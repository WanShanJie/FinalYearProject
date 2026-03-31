"""opencv_pipeline.py

Face detection, strict single-subject tracking, and quality gating
before AltFreezing inference.

Five quality improvements over the previous version:
  Fix 1 – Strict IoU + centre-jump + area-ratio guard: a candidate face
           is only accepted onto the track when it is geometrically
           consistent with the previous accepted face.
  Fix 2 – Track-break limit: at most TRACK_MAX_MISS consecutive frames
           may be missed before the sequence is terminated early.
  Fix 3 – Sequence-stability gate: the final sequence is scored on
           (a) mean adjacent-pair IoU, (b) centre-drift, and
           (c) face-size consistency. Unstable sequences → INCONCLUSIVE.
  Fix 4 – Warm-up skip: the first WARMUP_SKIP_FRAMES frames are skipped
           to allow the video to stabilise before tracking begins.
  Fix 5 – Duplicate-frame deduplication: consecutive frames whose bbox
           centre, size, blur, and brightness are all within tight
           tolerances are collapsed to a single representative frame.
"""

import os
import threading
import cv2
import numpy as np
from concurrent.futures import ThreadPoolExecutor
from typing import List, Tuple, Dict, Any, Optional

# ── Model path ───────────────────────────────────────────────────────────────
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
YUNET_MODEL_PATH = os.path.join(_THIS_DIR, "face_detection_yunet_2023mar.onnx")

# ── Per-face quality thresholds ───────────────────────────────────────────────
MIN_FACE_SIZE       = 40     # px — was 80; browser JPEG crops can appear smaller
MIN_BRIGHTNESS      = 10.0   # was 20.0; dark-background interview setups
HARD_MIN_BLUR       = 1.5    # was 4.0; talking-head motion reduces sharpness
CROP_MARGIN         = 0.35   # padding fraction around detected bbox (unchanged)

# ── Tracker geometry thresholds (Fix 1) ──────────────────────────────────────
TRACK_MIN_IOU          = 0.10   # was 0.20; allow more inter-frame movement
TRACK_MAX_CENTRE_JUMP  = 0.40   # unchanged
TRACK_MIN_AREA_RATIO   = 0.25   # was 0.35; head tilt changes bbox area

# ── Track-break policy (Fix 2) ───────────────────────────────────────────────
TRACK_MAX_MISS = 5   # was 2; with WARMUP_SKIP=1 a streak of 2 killed the sequence

# ── Warm-up skip (Fix 4) ─────────────────────────────────────────────────────
WARMUP_SKIP_FRAMES = 1   # was 2; browser captures are stable by the 2nd frame

# ── Sequence-level stability thresholds (Fix 3) ──────────────────────────────
SEQ_MIN_AVG_IOU          = 0.20   # was 0.30; interview heads move slightly
SEQ_MAX_CENTRE_DRIFT     = 0.50   # was 0.35; natural head movement
SEQ_MIN_SIZE_CONSISTENCY = 0.20   # was 0.40; face size varies with tilt

# ── Duplicate-frame tolerance (Fix 5) ────────────────────────────────────────
# With the original DUP_CENTRE_PX=6.0 almost every frame of a talking-head
# interview was deduplicated (drift is 2-5px), leaving 1-2 crops in _seq/.
# The verdict logic then falls into total_windows<3 → quality_band="weak" → SUSPICIOUS.
DUP_CENTRE_PX   = 20.0   # was 6.0;  up to 20px centre drift between frames
DUP_SIZE_RATIO  = 0.15   # was 0.06; allow 15% face-size change
DUP_BLUR_RATIO  = 0.30   # was 0.08; mouth movement changes blur
DUP_BRIGHT_DIFF = 15.0   # was 5.0;  mouth open/close changes brightness

# Minimum frames we want to pass to the model after deduplication.
# If dedup would leave fewer than this, skip it entirely — temporal uniform
# subsampling (below) provides adequate frame variety for the model.
MIN_SEQ_BEFORE_MODEL = 24

# ── Sequence length ───────────────────────────────────────────────────────────
DEFAULT_SEQUENCE_LENGTH = 32

# ── YuNet detector (module-level singleton) ───────────────────────────────────
face_detector      = None
face_detector_size = None

# ── Thread-local YuNet detectors for parallel frame processing ───────────────
_thread_local = threading.local()

# ── Maximum worker threads for parallel frame preprocessing ──────────────────
# Kept modest (4) to avoid spawning more threads than CPU cores on most servers.
_MAX_PREPROC_WORKERS = 4


# ─────────────────────────────────────────────────────────────────────────────
# Low-level helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_thread_detector(w: int, h: int):
    """Return (or create) a per-thread YuNet detector with the requested input size.

    Each worker thread keeps its own cv2.FaceDetectorYN instance so that
    concurrent calls do not race on the module-level singleton.
    """
    det      = getattr(_thread_local, "detector",      None)
    det_size = getattr(_thread_local, "detector_size", None)
    if not os.path.exists(YUNET_MODEL_PATH):
        return None
    try:
        if det is None:
            det = cv2.FaceDetectorYN.create(
                model=YUNET_MODEL_PATH,
                config="",
                input_size=(int(w), int(h)),
                score_threshold=0.45,
                nms_threshold=0.3,
                top_k=5000,
            )
            _thread_local.detector      = det
            _thread_local.detector_size = (int(w), int(h))
        elif det_size != (int(w), int(h)):
            det.setInputSize((int(w), int(h)))
            _thread_local.detector_size = (int(w), int(h))
        return det
    except Exception as e:
        print(f"[YuNet] Thread-local init failed: {e}")
        return None


def _init_yunet(w: int, h: int):
    global face_detector, face_detector_size
    if not os.path.exists(YUNET_MODEL_PATH):
        print(f"[YuNet] Model not found: {YUNET_MODEL_PATH}")
        return None
    try:
        if face_detector is None:
            face_detector = cv2.FaceDetectorYN.create(
                model=YUNET_MODEL_PATH,
                config="",
                input_size=(int(w), int(h)),
                score_threshold=0.45,  # was 0.65; browser canvas JPEG artifacts reduce confidence
                nms_threshold=0.3,
                top_k=5000,
            )
            face_detector_size = (int(w), int(h))
        elif face_detector_size != (int(w), int(h)):
            face_detector.setInputSize((int(w), int(h)))
            face_detector_size = (int(w), int(h))
        return face_detector
    except Exception as e:
        print(f"[YuNet] Init failed: {e}")
        return None


def blur_variance_laplacian(img: np.ndarray) -> float:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def calc_brightness(img: np.ndarray) -> float:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(np.mean(gray))


def _safe_decode(content: bytes):
    nparr = np.frombuffer(content, np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_COLOR)


def _bbox_iou(a: Dict, b: Dict) -> float:
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = ax1 + a["w"], ay1 + a["h"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = bx1 + b["w"], by1 + b["h"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih   = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter    = iw * ih
    if inter <= 0:
        return 0.0
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / max(1, union)


def _bbox_centre(bbox: Dict) -> Tuple[float, float]:
    return bbox["x"] + bbox["w"] / 2.0, bbox["y"] + bbox["h"] / 2.0


def _centre_score(bbox: Dict, img_w: int, img_h: int) -> float:
    cx, cy = _bbox_centre(bbox)
    dx = abs(cx - img_w / 2.0) / max(1.0, img_w / 2.0)
    dy = abs(cy - img_h / 2.0) / max(1.0, img_h / 2.0)
    return 1.0 - min(1.0, (dx + dy) / 2.0)


def _crop_with_margin(img: np.ndarray, bbox: Dict, margin: float = CROP_MARGIN):
    h, w = img.shape[:2]
    fx, fy, fw, fh = bbox["x"], bbox["y"], bbox["w"], bbox["h"]
    x1 = max(0, int(fx - margin * fw))
    y1 = max(0, int(fy - margin * fh))
    x2 = min(w, int(fx + (1 + margin) * fw))
    y2 = min(h, int(fy + (1 + margin) * fh))
    return img[y1:y2, x1:x2]


# ─────────────────────────────────────────────────────────────────────────────
# Fix 1 – Strict geometry guard
# ─────────────────────────────────────────────────────────────────────────────

def _is_consistent_with_track(
    candidate_bbox: Dict,
    prev_bbox: Dict,
    frame_diag: float,
) -> Tuple[bool, str]:
    """Return (ok, reject_reason) for a candidate against the running track."""
    iou = _bbox_iou(candidate_bbox, prev_bbox)
    if iou < TRACK_MIN_IOU:
        return False, f"iou_too_low:{iou:.2f}"

    cx_new, cy_new = _bbox_centre(candidate_bbox)
    cx_old, cy_old = _bbox_centre(prev_bbox)
    dist = ((cx_new - cx_old) ** 2 + (cy_new - cy_old) ** 2) ** 0.5
    jump = dist / max(1.0, frame_diag)
    if jump > TRACK_MAX_CENTRE_JUMP:
        return False, f"centre_jump:{jump:.2f}"

    prev_area = max(1, prev_bbox["w"] * prev_bbox["h"])
    new_area  = candidate_bbox["w"] * candidate_bbox["h"]
    ratio = new_area / prev_area
    if ratio < TRACK_MIN_AREA_RATIO:
        return False, f"area_drop:{ratio:.2f}"

    return True, "ok"


# ─────────────────────────────────────────────────────────────────────────────
# Fix 5 – Duplicate-frame detection
# ─────────────────────────────────────────────────────────────────────────────

def _is_duplicate(a: Dict, b: Dict) -> bool:
    """True when two selection records represent almost the same frame."""
    if a is None or b is None:
        return False
    ba, bb = a["bbox"], b["bbox"]
    # centre drift
    cxa, cya = _bbox_centre(ba)
    cxb, cyb = _bbox_centre(bb)
    if abs(cxa - cxb) > DUP_CENTRE_PX or abs(cya - cyb) > DUP_CENTRE_PX:
        return False
    # size change
    area_a = max(1, ba["w"] * ba["h"])
    area_b = max(1, bb["w"] * bb["h"])
    if abs(area_a - area_b) / area_a > DUP_SIZE_RATIO:
        return False
    # blur change
    blur_a = a.get("blur_var", 0.0)
    blur_b = b.get("blur_var", 0.0)
    if max(blur_a, blur_b) > 0 and abs(blur_a - blur_b) / max(blur_a, blur_b) > DUP_BLUR_RATIO:
        return False
    # brightness
    if abs(a.get("brightness", 0) - b.get("brightness", 0)) > DUP_BRIGHT_DIFF:
        return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Fix 3 – Sequence-level stability check
# ─────────────────────────────────────────────────────────────────────────────

def _sequence_stability(sequence: List[Dict], frame_diag: float) -> Dict[str, Any]:
    """Return a dict with stability metrics and a boolean `stable` flag."""
    if len(sequence) < 2:
        return {"stable": False, "reason": "too_few_frames", "avg_iou": 0.0,
                "max_centre_drift": 0.0, "size_consistency": 0.0}

    ious, drifts, areas = [], [], []
    for i in range(len(sequence) - 1):
        a = sequence[i]["bbox"]
        b = sequence[i + 1]["bbox"]
        ious.append(_bbox_iou(a, b))
        cxa, cya = _bbox_centre(a)
        cxb, cyb = _bbox_centre(b)
        drift = ((cxa - cxb) ** 2 + (cya - cyb) ** 2) ** 0.5 / max(1, frame_diag)
        drifts.append(drift)

    for s in sequence:
        areas.append(s["bbox"]["w"] * s["bbox"]["h"])

    avg_iou       = float(np.mean(ious))
    max_drift     = float(np.max(drifts))
    min_area      = min(areas)
    max_area      = max(areas)
    size_consist  = min_area / max(1, max_area)

    reasons = []
    if avg_iou < SEQ_MIN_AVG_IOU:
        reasons.append(f"avg_iou:{avg_iou:.2f}<{SEQ_MIN_AVG_IOU}")
    if max_drift > SEQ_MAX_CENTRE_DRIFT:
        reasons.append(f"drift:{max_drift:.2f}>{SEQ_MAX_CENTRE_DRIFT}")
    if size_consist < SEQ_MIN_SIZE_CONSISTENCY:
        reasons.append(f"size_consistency:{size_consist:.2f}<{SEQ_MIN_SIZE_CONSISTENCY}")

    stable = len(reasons) == 0
    return {
        "stable": stable,
        "reason": "; ".join(reasons) if reasons else "ok",
        "avg_iou": avg_iou,
        "max_centre_drift": max_drift,
        "size_consistency": size_consist,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Core tracker  (Fixes 1 + 2 + 4 + 5 integrated)
# ─────────────────────────────────────────────────────────────────────────────

def _track_primary_face(
    frame_candidates: List[Dict],
    frame_diag: float,
) -> Tuple[List[Dict], Dict]:
    """
    Single-pass gap-tolerant tracker.

    When TRACK_MAX_MISS consecutive frames are missed the tracker resets
    (prev_bbox = None) so it re-anchors on the next valid face rather than
    discarding all remaining frames.  This preserves face crops from later
    segments of a video where the subject momentarily left the frame.

    Returns
    -------
    track_items  : list of {idx, orig, img, selected, reject_reason}
                   `selected` is None for missed / geometry-rejected frames.
    tracker_meta : summary dict
    """
    prev_bbox:   Optional[Dict] = None
    miss_streak: int            = 0
    track_items: List[Dict]     = []
    gap_count:   int            = 0

    for item in frame_candidates:
        idx        = item["idx"]
        candidates = item.get("candidates", [])
        out        = {**item, "selected": None, "track_reject": None}

        if not candidates:
            miss_streak += 1
            out["track_reject"] = "no_candidate"
        else:
            if prev_bbox is None:
                # Anchor (or re-anchor after a gap): pick the largest, most-centred face
                best = max(
                    candidates,
                    key=lambda c: (c["bbox"]["w"] * c["bbox"]["h"],
                                   c["center_score"],
                                   c["blur_var"]),
                )
                out["selected"]     = best
                out["track_reject"] = None
                prev_bbox           = best["bbox"]
                miss_streak         = 0
            else:
                # Try to find a geometrically consistent candidate
                consistent_candidates = []
                for c in candidates:
                    ok, reason = _is_consistent_with_track(c["bbox"], prev_bbox, frame_diag)
                    if ok:
                        consistent_candidates.append(c)

                if consistent_candidates:
                    best = max(
                        consistent_candidates,
                        key=lambda c: (_bbox_iou(c["bbox"], prev_bbox),
                                       c["center_score"],
                                       c["blur_var"]),
                    )
                    out["selected"]     = best
                    out["track_reject"] = None
                    prev_bbox           = best["bbox"]
                    miss_streak         = 0
                else:
                    # All candidates failed the geometry guard
                    miss_streak += 1
                    reasons = []
                    for c in candidates:
                        _, r = _is_consistent_with_track(c["bbox"], prev_bbox, frame_diag)
                        reasons.append(r)
                    out["track_reject"] = "geometry_rejected: " + " | ".join(reasons)

        # Fix 2 ─ reset tracker after too many consecutive misses so frames
        # after the gap are still collected (gap-tolerant behaviour).
        if miss_streak > TRACK_MAX_MISS:
            prev_bbox   = None
            miss_streak = 0
            gap_count  += 1

        track_items.append(out)

    meta = {
        "broken_at_idx": None,
        "track_break": False,
        "gap_count": gap_count,
        "frames_considered": len(frame_candidates),
        "frames_after_trim": len(track_items),
    }
    return track_items, meta


# ─────────────────────────────────────────────────────────────────────────────
# Per-frame parallel worker
# ─────────────────────────────────────────────────────────────────────────────

def _process_single_frame(
    idx: int,
    orig_name: str,
    content: bytes,
    is_warmup: bool,
) -> Dict[str, Any]:
    """Decode one frame, run YuNet face detection, apply quality gates.

    Returns a dict with:
      ``per_frame``      – record for the audit log (None when frame has usable face candidates)
      ``candidate_entry``– entry for ``_track_primary_face``
      ``frame_diag``     – diagonal of the image in pixels (None for skipped frames)
    """
    if is_warmup:
        return {
            "per_frame": {"idx": idx, "orig": orig_name, "used": False, "reason": "warmup_skip"},
            "candidate_entry": {"idx": idx, "orig": orig_name, "img": None, "candidates": []},
            "frame_diag": None,
        }

    img = _safe_decode(content)
    if img is None:
        return {
            "per_frame": {"idx": idx, "orig": orig_name, "used": False, "reason": "decode_failed"},
            "candidate_entry": {"idx": idx, "orig": orig_name, "img": None, "candidates": []},
            "frame_diag": None,
        }

    h, w = img.shape[:2]
    diag = (w ** 2 + h ** 2) ** 0.5
    detector = _get_thread_detector(w, h)
    if detector is None:
        return {
            "per_frame": {"idx": idx, "orig": orig_name, "used": False, "reason": "detector_init_failed"},
            "candidate_entry": {"idx": idx, "orig": orig_name, "img": img, "candidates": []},
            "frame_diag": diag,
        }

    _, faces = detector.detect(img)
    frame_entry: Dict[str, Any] = {"idx": idx, "orig": orig_name, "img": img, "candidates": []}
    per_frame_record = None

    if faces is None or len(faces) == 0:
        per_frame_record = {"idx": idx, "orig": orig_name, "used": False, "reason": "no_face_found"}
    else:
        for face in faces:
            fx, fy, fw, fh = map(int, face[:4])
            bbox = {"x": fx, "y": fy, "w": fw, "h": fh}
            if fw < MIN_FACE_SIZE or fh < MIN_FACE_SIZE:
                continue
            crop = _crop_with_margin(img, bbox)
            if crop.size == 0:
                continue
            blur_var   = blur_variance_laplacian(crop)
            brightness = calc_brightness(crop)
            if brightness < MIN_BRIGHTNESS or blur_var < HARD_MIN_BLUR:
                continue
            frame_entry["candidates"].append({
                "bbox":         bbox,
                "crop":         crop,
                "blur_var":     float(blur_var),
                "brightness":   float(brightness),
                "center_score": _centre_score(bbox, w, h),
            })
        if not frame_entry["candidates"]:
            per_frame_record = {"idx": idx, "orig": orig_name, "used": False, "reason": "no_usable_face"}

    return {
        "per_frame":      per_frame_record,
        "candidate_entry": frame_entry,
        "frame_diag":     diag,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def process_frames_for_sequence(
    analysis_id,
    frames,
    uploads_dir,
    sequence_length: int = DEFAULT_SEQUENCE_LENGTH,
    save_crops: bool = True,
) -> Dict[str, Any]:

    seq_dir = os.path.join(uploads_dir, f"{analysis_id}_seq")
    if save_crops:
        os.makedirs(seq_dir, exist_ok=True)

    per_frame:       List[Dict] = []
    frame_candidates: List[Dict] = []
    frame_diag = 1.0  # updated once we know the frame size

    frames_total = len(frames)

    # ── Parallel per-frame decode + face detection + quality gating ──────────
    # Each worker uses a thread-local YuNet instance so there is no shared
    # state between threads.  The tracker that follows must remain sequential.
    n_workers = min(_MAX_PREPROC_WORKERS, max(1, frames_total))
    task_args = [
        (idx, orig_name, content, idx < WARMUP_SKIP_FRAMES)
        for idx, (orig_name, content) in enumerate(frames)
    ]

    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        # executor.map preserves input order
        results = list(pool.map(lambda a: _process_single_frame(*a), task_args))

    for res in results:
        if res["per_frame"] is not None:
            per_frame.append(res["per_frame"])
        frame_candidates.append(res["candidate_entry"])
        if res["frame_diag"] is not None:
            frame_diag = res["frame_diag"]  # last non-None wins (all frames same size)

    # ── Run strict tracker (Fixes 1, 2, 4) ───────────────────────────────────
    track_items, tracker_meta = _track_primary_face(frame_candidates, frame_diag)

    selected_items = [t for t in track_items if t.get("selected") is not None]
    frames_with_face = len(selected_items)

    # ── Fix 5 – Deduplicate consecutive identical frames ─────────────────────
    # Deduplication is skipped when the result would leave fewer than
    # MIN_SEQ_BEFORE_MODEL frames — a common case for talking-head content
    # where the face barely moves.  Temporal uniform subsampling (below)
    # handles variety selection instead.
    deduped: List[Dict] = []
    dup_rejected_recs: List[Dict] = []
    prev_sel = None
    for t in selected_items:
        sel = t["selected"]
        rec = {
            "idx": t["idx"], "orig": t["orig"],
            "bbox": sel["bbox"],
            "blur_var": sel["blur_var"],
            "brightness": sel["brightness"],
        }
        if prev_sel is not None and _is_duplicate(rec, prev_sel):
            dup_rejected_recs.append(rec)
            continue
        deduped.append(t)
        prev_sel = rec

    if len(deduped) < MIN_SEQ_BEFORE_MODEL and len(selected_items) > len(deduped):
        # Dedup would remove too many frames — keep all tracked frames so the
        # model has enough temporal signal.  No duplicate_frame records added.
        pass  # selected_items stays unchanged
    else:
        for rec in dup_rejected_recs:
            per_frame.append({**rec, "used": False, "reason": "duplicate_frame"})
        selected_items = deduped

    # ── Fix 3 – Sequence stability check ─────────────────────────────────────
    stability_input = [
        {"bbox": t["selected"]["bbox"],
         "blur_var": t["selected"]["blur_var"],
         "brightness": t["selected"]["brightness"]}
        for t in selected_items
    ]
    stability = _sequence_stability(stability_input, frame_diag)

    # ── Subsample evenly to target sequence_length ────────────────────────────
    if len(selected_items) > sequence_length:
        positions = np.linspace(0, len(selected_items) - 1,
                                sequence_length).round().astype(int).tolist()
        keep_ids  = set(positions)
    else:
        keep_ids = set(range(len(selected_items)))

    used_counter     = 0
    selected_counter = 0
    sequence_crop_paths: List[str] = []

    for sel_iter, t in enumerate(selected_items):
        sel  = t["selected"]
        used = sel_iter in keep_ids
        record = {
            "idx":        t["idx"],
            "orig":       t["orig"],
            "bbox":       sel["bbox"],
            "blur_var":   sel["blur_var"],
            "brightness": sel["brightness"],
            "used":       used,
            "reason":     "selected" if used else "sequence_subsampled",
        }
        if used:
            crop_path = os.path.join(seq_dir, f"face_{selected_counter:03d}.jpg")
            if save_crops:
                cv2.imwrite(crop_path, sel["crop"])
            record["crop_path"] = crop_path
            sequence_crop_paths.append(crop_path)
            used_counter     += 1
            selected_counter += 1
        per_frame.append(record)

    # Add per_frame records for geometry-rejected / track-trimmed frames
    accepted_idxs = {r["idx"] for r in per_frame}
    for t in track_items:
        if t["idx"] not in accepted_idxs and t.get("track_reject"):
            per_frame.append({
                "idx":    t["idx"],
                "orig":   t["orig"],
                "used":   False,
                "reason": t["track_reject"],
            })

    per_frame.sort(key=lambda x: x.get("idx", 0))

    # ── Final pass decision ───────────────────────────────────────────────────
    sequence_ok = (
        used_counter >= max(4, min(sequence_length, 8))
        and stability["stable"]
    )

    return {
        "pass":                  sequence_ok,
        "per_frame":             per_frame,
        "frames_total":          frames_total,
        "frames_received":       frames_total,
        "frames_with_face":      frames_with_face,
        "sequence_frames_used":  used_counter,
        "sequence_length":       sequence_length,
        "sequence_ready":        used_counter >= 4,
        "sequence_crop_paths":   sequence_crop_paths,
        "track_summary": {
            "strategy":         "strict_single_subject_tracker",
            "selected_track_id": 0,
            **tracker_meta,
        },
        "stability": stability,
    }


def process_frames(analysis_id, frames, uploads_dir, save_crops=True):
    return process_frames_for_sequence(
        analysis_id, frames, uploads_dir,
        sequence_length=DEFAULT_SEQUENCE_LENGTH, save_crops=save_crops,
    )