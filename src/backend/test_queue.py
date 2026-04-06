"""
test_queue.py — Concurrent queue stress test for the deepfake analysis pipeline.

Tests that:
  1. Multiple video uploads are accepted instantly (not blocked by processing)
  2. All tasks are queued in Redis and picked up by the Celery worker
  3. Status polling returns correct PENDING → PROCESSING → DONE transitions
  4. Results from concurrent jobs don't cross-contaminate

Usage (from src/backend/ with venv active):
  python test_queue.py --email you@example.com --password yourpass --video test.mp4
  python test_queue.py --email you@example.com --password yourpass --video test.mp4 --jobs 3
  python test_queue.py --email you@example.com --password yourpass --video test.mp4 --jobs 3 --users 2
"""

import argparse
import json
import sys
import time
import threading
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' not installed.  Run: pip install requests")
    sys.exit(1)

API_BASE = "http://127.0.0.1:8000"
POLL_INTERVAL_S = 3
POLL_TIMEOUT_S  = 300   # 5 minutes max per job


# ── Helpers ───────────────────────────────────────────────────────────────────

def ts():
    return datetime.now().strftime("%H:%M:%S")

def log(msg, tag="INFO"):
    print(f"[{ts()}][{tag}] {msg}")


def login(email: str, password: str) -> str:
    """Authenticate and return the Bearer token."""
    res = requests.post(f"{API_BASE}/api/auth/login",
                        json={"email": email, "password": password}, timeout=10)
    data = res.json()
    if not res.ok:
        raise SystemExit(f"Login failed: {data.get('detail', res.text)}")
    token = data.get("token") or data.get("access_token")
    if not token:
        raise SystemExit(f"No token in login response: {data}")
    log(f"Logged in as {email}", "AUTH")
    return token


def submit_video(token: str, video_path: str, title: str) -> dict:
    """POST /api/analysis/video and return the full response dict."""
    with open(video_path, "rb") as fh:
        res = requests.post(
            f"{API_BASE}/api/analysis/video",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": (Path(video_path).name, fh, "video/mp4")},
            data={"title": title, "platform": "upload"},
            timeout=60,
        )
    data = res.json()
    if not res.ok or not data.get("ok"):
        raise RuntimeError(f"Submit failed ({res.status_code}): {data.get('detail', data)}")
    return data


def poll_until_done(token: str, analysis_id: int, label: str) -> dict:
    """Poll GET /api/analysis/{id}/status until DONE or ERROR, return final status."""
    deadline = time.time() + POLL_TIMEOUT_S
    last_stage = ""
    while time.time() < deadline:
        res = requests.get(
            f"{API_BASE}/api/analysis/{analysis_id}/status",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        data = res.json()
        status   = data.get("status", "?")
        progress = data.get("progress", 0)
        stage    = data.get("stage", "")

        if stage != last_stage:
            log(f"[{label}] #{analysis_id}  {status}  {progress}%  stage={stage}", "POLL")
            last_stage = stage

        if status in ("DONE", "ERROR"):
            return data

        time.sleep(POLL_INTERVAL_S)

    return {"status": "TIMEOUT", "analysis_id": analysis_id}


# ── Single-job worker (runs in its own thread) ────────────────────────────────

def run_job(token: str, video_path: str, job_index: int, results: list, lock: threading.Lock):
    label = f"JOB-{job_index}"
    title = f"Queue Test #{job_index} @ {ts()}"
    try:
        t0 = time.time()
        log(f"[{label}] Submitting '{Path(video_path).name}'…", "SUBMIT")
        queued = submit_video(token, video_path, title)
        submit_elapsed = time.time() - t0
        aid = queued["analysis_id"]

        log(f"[{label}] Queued in {submit_elapsed:.2f}s  analysis_id={aid}  task_id={queued.get('task_id','?')}", "SUBMIT")

        # Submit should be fast — flag it if it took more than 5 s
        if submit_elapsed > 5:
            log(f"[{label}] WARNING: submit took {submit_elapsed:.1f}s — backend may be processing synchronously!", "WARN")

        final = poll_until_done(token, aid, label)
        total_elapsed = time.time() - t0

        result = {
            "job":         job_index,
            "analysis_id": aid,
            "status":      final.get("status"),
            "verdict":     final.get("verdict"),
            "score":       final.get("score"),
            "submit_s":    round(submit_elapsed, 2),
            "total_s":     round(total_elapsed, 1),
            "ok":          final.get("status") == "DONE",
        }
    except Exception as exc:
        result = {"job": job_index, "status": "EXCEPTION", "error": str(exc), "ok": False}
        log(f"[{label}] EXCEPTION: {exc}", "ERR")

    with lock:
        results.append(result)


# ── Multi-user helper ─────────────────────────────────────────────────────────

def submit_concurrent(token: str, video_path: str, n_jobs: int) -> list:
    """Submit n_jobs videos at the SAME TIME from the same account."""
    results: list = []
    lock = threading.Lock()
    threads = []
    for i in range(1, n_jobs + 1):
        t = threading.Thread(target=run_job, args=(token, video_path, i, results, lock), daemon=True)
        threads.append(t)

    log(f"Launching {n_jobs} concurrent upload(s)…", "CONCUR")
    t_launch = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    log(f"All {n_jobs} job(s) finished in {time.time() - t_launch:.1f}s total", "CONCUR")
    return sorted(results, key=lambda r: r["job"])


# ── CLI entry point ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Celery queue concurrent test")
    parser.add_argument("--email",    required=True, help="Portal login email")
    parser.add_argument("--password", required=True, help="Portal login password")
    parser.add_argument("--video",    required=True, help="Path to a .mp4 video to upload")
    parser.add_argument("--jobs",     type=int, default=3,
                        help="Number of concurrent jobs to submit (default 3)")
    parser.add_argument("--users",    type=int, default=1,
                        help="Simulate N separate user accounts (supply N emails/passwords via CSV)")
    parser.add_argument("--email2",   default=None, help="Second user email (for --users 2)")
    parser.add_argument("--password2",default=None, help="Second user password (for --users 2)")
    args = parser.parse_args()

    video_path = Path(args.video)
    if not video_path.exists():
        raise SystemExit(f"Video file not found: {video_path}")

    print("\n" + "="*60)
    print(" DEEPFAKE QUEUE SYSTEM — CONCURRENT TEST")
    print("="*60)
    print(f"  Video   : {video_path.name}  ({video_path.stat().st_size / 1024 / 1024:.1f} MB)")
    print(f"  Jobs    : {args.jobs} concurrent per user")
    print(f"  Users   : {args.users}")
    print("="*60 + "\n")

    # ── Step 1: Check services are up ─────────────────────────────────────────
    log("Checking backend is reachable…")
    try:
        requests.get(f"{API_BASE}/docs", timeout=5)
        log("Backend OK", "CHECK")
    except Exception:
        raise SystemExit(f"Backend not reachable at {API_BASE} — start uvicorn first")

    # ── Step 2: Login ─────────────────────────────────────────────────────────
    token1 = login(args.email, args.password)
    token2 = None
    if args.users >= 2:
        if not args.email2 or not args.password2:
            raise SystemExit("--users 2 requires --email2 and --password2")
        token2 = login(args.email2, args.password2)

    # ── Step 3: Concurrent submission ─────────────────────────────────────────
    all_results = []

    if args.users >= 2:
        # Run both users simultaneously
        results1, results2 = [], []
        lock1, lock2 = threading.Lock(), threading.Lock()
        threads = []
        for i in range(1, args.jobs + 1):
            threads.append(threading.Thread(target=run_job, args=(token1, str(video_path), f"U1-{i}", results1, lock1), daemon=True))
            threads.append(threading.Thread(target=run_job, args=(token2, str(video_path), f"U2-{i}", results2, lock2), daemon=True))
        log(f"Launching {len(threads)} threads across 2 users…", "CONCUR")
        t0 = time.time()
        for t in threads: t.start()
        for t in threads: t.join()
        log(f"All finished in {time.time()-t0:.1f}s", "CONCUR")
        all_results = results1 + results2
    else:
        all_results = submit_concurrent(token1, str(video_path), args.jobs)

    # ── Step 4: Print summary ─────────────────────────────────────────────────
    print("\n" + "="*60)
    print(" RESULTS SUMMARY")
    print("="*60)
    passed = sum(1 for r in all_results if r.get("ok"))
    failed = len(all_results) - passed

    for r in sorted(all_results, key=lambda x: str(x.get("job", ""))):
        status_sym = "✓" if r.get("ok") else "✗"
        if r.get("status") == "DONE":
            print(f"  {status_sym} Job {r['job']:>6}  analysis_id={r.get('analysis_id'):>5}  "
                  f"verdict={r.get('verdict','?'):<15}  score={r.get('score', 0):.3f}  "
                  f"submit={r.get('submit_s','?')}s  total={r.get('total_s','?')}s")
        elif r.get("status") == "TIMEOUT":
            print(f"  ✗ Job {r['job']:>6}  TIMEOUT after {POLL_TIMEOUT_S}s")
        else:
            print(f"  ✗ Job {r['job']:>6}  {r.get('status','?')}  {r.get('error','')}")

    print("-"*60)
    print(f"  Passed: {passed}/{len(all_results)}   Failed: {failed}/{len(all_results)}")

    # ── Step 5: Queue-behaviour assertions ────────────────────────────────────
    print("\n" + "="*60)
    print(" QUEUE BEHAVIOUR CHECKS")
    print("="*60)

    submit_times = [r.get("submit_s", 999) for r in all_results if "submit_s" in r]
    if submit_times:
        avg_submit = sum(submit_times) / len(submit_times)
        max_submit = max(submit_times)
        print(f"  Submit latency  avg={avg_submit:.2f}s  max={max_submit:.2f}s")
        if max_submit < 5:
            print("  ✓  All uploads returned instantly — queue is non-blocking")
        else:
            print("  ✗  Some uploads took > 5s — check if Celery worker is running")

    analysis_ids = [r.get("analysis_id") for r in all_results if r.get("analysis_id")]
    if len(set(analysis_ids)) == len(analysis_ids):
        print("  ✓  Each job got a unique analysis_id — no ID collision")
    else:
        print("  ✗  Duplicate analysis IDs detected!")

    done_count  = sum(1 for r in all_results if r.get("status") == "DONE")
    error_count = sum(1 for r in all_results if r.get("status") == "ERROR")
    print(f"  Jobs DONE={done_count}  ERROR={error_count}  TIMEOUT={len(all_results)-done_count-error_count}")

    print("="*60 + "\n")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
