"""worker.py
Celery background task — runs the full deepfake detection pipeline for
video uploads submitted through POST /api/analysis/video.

Why a separate worker?
  The detection pipeline (face detection → AltFreezing → ViT → Xception
  → Wav2Lip) takes 10–60 s per video.  Running it inside the FastAPI
  request/response cycle blocks the server and times out browsers.
  Offloading to a Celery worker allows the API to respond immediately
  ("queued") while the heavy work happens in the background.

Usage (run from src/backend/):
  celery -A worker worker --loglevel=info --concurrency=1

NOTE: All imports from main.py are done INSIDE the task function body
(lazy imports) to avoid circular dependencies.  The module-level imports
here are limited to stdlib + celery_app.
"""

import os
import time
import traceback
from pathlib import Path

from celery_app import celery_app


# ─────────────────────────────────────────────────────────────────────────────
# Progress stage weights (used to report % complete to the status endpoint)
# ─────────────────────────────────────────────────────────────────────────────
_STAGE_PROGRESS = {
    "frame_extraction":  10,
    "face_detection":    25,
    "quality_gate":      35,
    "inference_alt":     55,
    "inference_vit":     65,
    "inference_xception":75,
    "inference_wav2lip": 85,
    "fusion":            95,
    "saving":           100,
}


def _update(self_task, stage: str, extra: dict | None = None):
    """Push a PROGRESS state update so the polling endpoint can show %."""
    meta = {"progress": _STAGE_PROGRESS.get(stage, 0), "stage": stage}
    if extra:
        meta.update(extra)
    self_task.update_state(state="PROGRESS", meta=meta)


# ─────────────────────────────────────────────────────────────────────────────
# Main Celery task
# ─────────────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="worker.run_video_analysis",
    bind=True,       # self = task instance (needed for update_state + retry)
    max_retries=0,   # failures are stored in DB; no automatic retry
)
def run_video_analysis(
    self,
    analysis_id: int,
    video_path: str,       # absolute path to the saved video file
    upload_dir_str: str,   # absolute path to the uploads/ directory
):
    """
    Execute the full deepfake detection pipeline for a video upload.

    Parameters
    ----------
    analysis_id   : int   — MediaAnalysis PK created by the API before queuing
    video_path    : str   — path to the uploaded video (persisted by the API)
    upload_dir_str: str   — path to uploads/ directory (for face crops etc.)
    """

    # ── Lazy imports (avoids circular deps; cached after first call) ───────────
    import cv2 as _cv2

    from db import SessionLocal
    from models import MediaAnalysis, ModelRun
    from opencv_pipeline import process_frames_for_sequence
    from scripts import altfreezing_service, vit_service, xception_service, wav2lip_service
    from scripts.altfreezing_config import SEQUENCE_LENGTH as ALT_SEQ_LEN
    from scripts.wav2lip_config import WAV2LIP_FPS as _TARGET_FPS

    # These helper functions live in main.py. Importing main.py here is safe —
    # FastAPI() just creates an ASGI object; no server starts.
    from main import (
        _decide_altfreezing_verdict,
        _combine_model_signals,
        generate_verdict_reason,
        _finalize_analysis_log,
        _persist_model_runs,
        _maybe_insert_blocklist,
        _prune_analysis_uploads,
    )
    # ──────────────────────────────────────────────────────────────────────────

    upload_dir = Path(upload_dir_str)
    start_time = time.time()

    db = SessionLocal()
    analysis = None

    try:
        # ── 1. Load analysis record ───────────────────────────────────────────
        analysis = db.query(MediaAnalysis).filter(MediaAnalysis.id == analysis_id).first()
        if not analysis:
            print(f"[Worker] Analysis {analysis_id} not found — aborting task.")
            return

        # Mark as actively processing so the status endpoint shows PROCESSING
        analysis.status = "PROCESSING"
        db.commit()
        _update(self, "frame_extraction")

        meta_data: dict = dict(analysis.meta or {})

        # ── 2. Extract frames from video ──────────────────────────────────────
        cap = _cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError(f"cannot_open_video:{video_path}")

        src_fps = cap.get(_cv2.CAP_PROP_FPS) or 25.0
        step = max(1, int(src_fps / _TARGET_FPS))
        frames_for_cv = []
        frame_idx = 0

        while cap.isOpened():
            cap.set(_cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ok, frame = cap.read()
            if not ok:
                break
            ret, buf = _cv2.imencode(".jpg", frame, [_cv2.IMWRITE_JPEG_QUALITY, 90])
            if ret:
                frames_for_cv.append((f"frame_{frame_idx:06d}.jpg", bytes(buf)))
            frame_idx += step
        cap.release()

        if not frames_for_cv:
            raise ValueError("no_frames_extracted_from_video")

        print(f"[Worker][{analysis_id}] Extracted {len(frames_for_cv)} frames "
              f"(src_fps={src_fps:.1f}, step={step})")

        # ── 3. Face detection + quality gating ───────────────────────────────
        _update(self, "face_detection")

        opencv_summary = process_frames_for_sequence(
            analysis_id=analysis_id,
            frames=frames_for_cv,
            uploads_dir=str(upload_dir),
            sequence_length=ALT_SEQ_LEN,
            save_crops=True,
        )

        per_frame        = opencv_summary.get("per_frame", []) if isinstance(opencv_summary, dict) else []
        total_frames     = int(opencv_summary.get("frames_total", 0) or 0)
        frames_with_face = int(opencv_summary.get("frames_with_face", 0) or 0)
        seq_frames       = int(opencv_summary.get("sequence_frames_used", 0) or 0)
        crop_paths       = opencv_summary.get("sequence_crop_paths") or []
        track_summary    = opencv_summary.get("track_summary", {}) if isinstance(opencv_summary, dict) else {}
        stability_meta   = opencv_summary.get("stability", {}) if isinstance(opencv_summary, dict) else {}

        reject_reasons: dict = {}
        blur_used:   list = []
        bright_used: list = []
        for pf in per_frame:
            if not isinstance(pf, dict):
                continue
            if pf.get("used") is True:
                if pf.get("blur_var") is not None:
                    blur_used.append(float(pf["blur_var"]))
                if pf.get("brightness") is not None:
                    bright_used.append(float(pf["brightness"]))
            else:
                r = pf.get("reason") or "unknown"
                reject_reasons[r] = reject_reasons.get(r, 0) + 1

        avg_blur       = sum(blur_used)   / len(blur_used)   if blur_used   else 0.0
        avg_brightness = sum(bright_used) / len(bright_used) if bright_used else 0.0
        usable_ratio   = (seq_frames / total_frames) if total_frames else 0.0

        _update(self, "quality_gate", {"frames_extracted": len(frames_for_cv),
                                       "seq_frames": seq_frames})

        MIN_SEQUENCE_FRAMES = 6
        MIN_USABLE_RATIO    = 0.10
        MIN_AVG_BLUR        = 2.0
        MIN_AVG_BRIGHTNESS  = 15.0

        quality_pass         = True
        quality_fail_reasons = []
        if seq_frames   < MIN_SEQUENCE_FRAMES:
            quality_pass = False
            quality_fail_reasons.append(f"too_few_sequence_frames:{seq_frames}")
        if usable_ratio < MIN_USABLE_RATIO:
            quality_pass = False
            quality_fail_reasons.append(f"usable_ratio_too_low:{usable_ratio:.2f}")
        if avg_blur     < MIN_AVG_BLUR:
            quality_pass = False
            quality_fail_reasons.append(f"avg_blur_too_low:{avg_blur:.2f}")
        if avg_brightness < MIN_AVG_BRIGHTNESS:
            quality_pass = False
            quality_fail_reasons.append(f"avg_brightness_too_low:{avg_brightness:.2f}")

        geometry_rejected_count = sum(
            v for k, v in reject_reasons.items()
            if isinstance(k, str) and "geometry_rejected" in k
        )
        quality_gate = {
            "pass":                    quality_pass,
            "fail_reasons":            quality_fail_reasons,
            "frames_total":            total_frames,
            "frames_with_face":        frames_with_face,
            "sequence_frames_used":    seq_frames,
            "usable_ratio":            usable_ratio,
            "avg_blur":                avg_blur,
            "avg_brightness":          avg_brightness,
            "reject_reasons":          reject_reasons,
            "track_gap_count":         int(track_summary.get("gap_count", 0) or 0),
            "geometry_rejected_count": geometry_rejected_count,
            "sequence_stable":         stability_meta.get("stable", True),
            "stability":               stability_meta,
            "thresholds": {
                "MIN_SEQUENCE_FRAMES": MIN_SEQUENCE_FRAMES,
                "MIN_USABLE_RATIO":    MIN_USABLE_RATIO,
                "MIN_AVG_BLUR":        MIN_AVG_BLUR,
                "MIN_AVG_BRIGHTNESS":  MIN_AVG_BRIGHTNESS,
            },
        }
        meta_data["opencv"]       = opencv_summary
        meta_data["quality_gate"] = quality_gate

        # ── 4. Model inference (AltFreezing, ViT, Xception, Wav2Lip) ─────────
        if not quality_pass:
            alt_result = {
                "ok": False, "error": "quality_gate_failed",
                "video_score": None, "frames_used": seq_frames,
                "sequence_length": opencv_summary.get("sequence_length", 16),
                "per_frame": [],
            }
            vit_result = {
                "ok": False, "error": "quality_gate_failed",
                "video_score": None, "frames_used": 0, "per_frame": [],
                "model_name": "ViT",
            }
            xception_result = {
                "ok": False, "error": "quality_gate_failed",
                "video_score": None, "frames_used": 0, "per_frame": [],
                "model_name": "Xception",
            }
            wav2lip_result = {
                "ok": False, "error": "quality_gate_failed",
                "sync_score": None, "interpretation": "unavailable",
            }
        else:
            # ── Run AltFreezing + ViT + Xception in parallel ──────────────────
            # These three models all read from the same pre-saved crop files and
            # are completely independent, so we can execute them concurrently.
            # Wall-clock time ≈ max(t_alt, t_vit, t_xception) instead of sum.
            # Celery tasks are synchronous (no asyncio), so we use
            # ThreadPoolExecutor directly — PyTorch/OpenCV release the GIL
            # during their C++ kernels, enabling real parallelism.
            _update(self, "inference_alt")  # progress = 55 (first model starts)
            from concurrent.futures import ThreadPoolExecutor as _Exec

            _aid    = analysis_id
            _ud     = upload_dir
            _seq    = ALT_SEQ_LEN
            _cp     = crop_paths

            with _Exec(max_workers=3, thread_name_prefix="worker_model") as pool:
                fut_alt = pool.submit(
                    altfreezing_service.predict_from_sequence,
                    analysis_id=_aid,
                    uploads_dir=_ud,
                    sequence_length=_seq,
                    weights_path="checkpoints/model.pth",
                )
                fut_vit = pool.submit(
                    vit_service.predict_from_crops, _cp
                ) if _cp else None
                fut_xc = pool.submit(
                    lambda: xception_service.predict_from_analysis(
                        analysis_id=_aid,
                        uploads_dir=_ud,
                        max_frames=8,
                        aggregation="mean",
                        threshold=0.5,
                    )
                )

                alt_result      = fut_alt.result()
                xception_result = fut_xc.result()
                vit_result = fut_vit.result() if fut_vit is not None else {
                    "ok": False, "error": "no_sequence_crops",
                    "video_score": None, "frames_used": 0,
                    "per_frame": [], "model_name": "ViT",
                }

            _update(self, "inference_wav2lip")  # progress = 85
            wav2lip_result = wav2lip_service.wav2lip_sync_score(
                video_path=video_path,
                weights_path="checkpoints/wav2lip_gan.pth",
            )

        meta_data["altfreezing"] = alt_result
        meta_data["vit"]         = vit_result
        meta_data["xception"]    = xception_result
        meta_data["wav2lip"]     = wav2lip_result

        # ── 5. Fuse signals → final verdict ───────────────────────────────────
        _update(self, "fusion")

        alt_score      = alt_result.get("video_score")
        visual_decision = _decide_altfreezing_verdict(alt_score, quality_gate, alt_result)
        combined_decision = _combine_model_signals(
            visual_decision,
            alt_result,
            vit_result,
            xception_result,
            wav2lip_result,
            quality_gate,
        )

        def _reasoning_meta(dp, ar, vr, xr):
            cal = (ar or {}).get("calibration") or {}
            return {
                "verdict":            dp.get("final_verdict"),
                "final_verdict":      dp.get("final_verdict"),
                "score":              dp.get("final_score", dp.get("score")),
                "raw_score":          dp.get("raw_score"),
                "confidence":         dp.get("confidence"),
                "reason":             dp.get("reason"),
                "quality_band":       dp.get("quality_band"),
                "usable_frames":      seq_frames,
                "usable_ratio":       usable_ratio,
                "temporal_diversity": dp.get("temporal_diversity", cal.get("temporal_diversity")),
                "duplicate_frames":   reject_reasons.get("duplicate_frame", 0),
                "stability":          stability_meta.get("stable"),
                "drift":              stability_meta.get("max_centre_drift"),
                "blur":               avg_blur,
                "brightness":         avg_brightness,
                "fail_reasons":       quality_fail_reasons,
                "high_frame_count":   dp.get("high_frame_count", (ar or {}).get("high_frame_count")),
                "score_std":          dp.get("score_std", (ar or {}).get("score_std")),
                "total_windows":      dp.get("total_windows", (ar or {}).get("total_windows")),
                "temporal_penalty":   dp.get("temporal_penalty"),
                "evidence_quality":   dp.get("evidence_quality", cal.get("evidence_quality")),
                "evidence_strength":  dp.get("evidence_strength"),
                "vit_score":          dp.get("vit_score", (vr or {}).get("video_score")),
                "xception_score":     dp.get("xception_score", (xr or {}).get("video_score")),
                "wav2lip_score":      dp.get("wav2lip_score"),
                "disagreement_flag":  dp.get("disagreement_flag"),
            }

        combined_decision["final_explanation"] = (
            combined_decision.get("explanation")
            or generate_verdict_reason(
                _reasoning_meta(combined_decision, alt_result, vit_result, xception_result)
            )
        )
        combined_decision["verdict_reason"] = combined_decision["final_explanation"]
        meta_data["decision"] = combined_decision

        # ── 6. Persist results ────────────────────────────────────────────────
        _update(self, "saving")

        analysis.score   = float(combined_decision.get("score") or 0.0)
        analysis.verdict = combined_decision["final_verdict"]
        analysis.meta    = meta_data

        _persist_model_runs(
            db,
            analysis,
            alt_result=alt_result,
            visual_decision=visual_decision,
            vit_result=vit_result,
            xception_result=xception_result,
            wav2lip_result=wav2lip_result,
        )
        _finalize_analysis_log(db, analysis, start_time, status="DONE")

        try:
            _maybe_insert_blocklist(analysis, db)
        except Exception as _be:
            print(f"[Worker][{analysis_id}] Blocklist insert failed: {_be}")

        _prune_analysis_uploads(analysis_id)

        elapsed = round(time.time() - start_time, 2)
        print(f"[Worker][{analysis_id}] Completed in {elapsed}s  "
              f"verdict={analysis.verdict}  score={analysis.score:.3f}")

        return {
            "analysis_id": analysis_id,
            "verdict":     analysis.verdict,
            "score":       analysis.score,
            "status":      "DONE",
            "elapsed_s":   elapsed,
        }

    except Exception as exc:
        traceback.print_exc()
        print(f"[Worker][{analysis_id}] Task FAILED: {exc}")

        if analysis is not None:
            try:
                analysis.verdict = "INCONCLUSIVE"
                analysis.meta    = {**(analysis.meta or {}), "worker_error": str(exc)}
                _finalize_analysis_log(db, analysis, start_time, status="ERROR")
            except Exception as _db_err:
                print(f"[Worker][{analysis_id}] DB error during failure handling: {_db_err}")

        # Re-raise so Celery marks the task as FAILURE in Redis
        raise

    finally:
        db.close()
        # Clean up the persisted video file once processing is done
        try:
            if os.path.exists(video_path):
                os.remove(video_path)
        except Exception as _fe:
            print(f"[Worker][{analysis_id}] Could not delete video file: {_fe}")
