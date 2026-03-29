from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from scripts.xception_pipeline.aggregator import aggregate_scores, classify_score
from scripts.xception_pipeline.inference import run_frame_inference
from scripts.xception_pipeline.model_loader import get_default_device, load_xception_model
from scripts.xception_pipeline.preprocess import DEFAULT_IMAGENET_MEAN, DEFAULT_IMAGENET_STD

_DEVICE = get_default_device()
_MODEL = None
_READY = False
_ERROR: Optional[str] = None
_LOADED_FROM = ""


def init(weights_path: str = "checkpoints/xception_best.pth", strict: bool = False):
    global _MODEL, _READY, _ERROR, _LOADED_FROM
    try:
        _MODEL, info = load_xception_model(weights_path, device=str(_DEVICE), strict=strict)
        _READY = True
        _ERROR = None
        _LOADED_FROM = str(info.get("checkpoint_path") or weights_path)
        print(f"[xception_service] ready on {_DEVICE}: {_LOADED_FROM}")
    except Exception as e:
        _MODEL = None
        _READY = False
        _ERROR = str(e)
        _LOADED_FROM = weights_path
        print(f"[xception_service] init failed: {_ERROR}")


def _load_crops(analysis_id: int, uploads_dir: Path, max_frames: int) -> List[Path]:
    seq_dir = uploads_dir / f"{analysis_id}_seq"
    if not seq_dir.exists():
        return []
    return sorted(seq_dir.glob("face_*.jpg"))[:max_frames]


def predict_from_analysis(
    analysis_id: int,
    uploads_dir: Path,
    max_frames: int = 8,
    aggregation: str = "mean",
    threshold: float = 0.5,
) -> Dict[str, Any]:
    if not _READY or _MODEL is None:
        init()
    if not _READY or _MODEL is None:
        return {
            "ok": False,
            "error": _ERROR or "xception_not_ready",
            "video_score": None,
            "frames_used": 0,
            "per_frame": [],
            "loaded_from": _LOADED_FROM,
        }

    crop_paths = _load_crops(analysis_id, uploads_dir, max_frames)
    if not crop_paths:
        return {
            "ok": False,
            "error": "no_face_crops",
            "video_score": None,
            "frames_used": 0,
            "per_frame": [],
            "loaded_from": _LOADED_FROM,
        }

    per_frame = run_frame_inference(
        _MODEL,
        crop_paths,
        device=str(_DEVICE),
        batch_size=min(8, max(1, len(crop_paths))),
        image_size=224,
        mean=DEFAULT_IMAGENET_MEAN,
        std=DEFAULT_IMAGENET_STD,
    )
    scores = [frame["fake_prob"] for frame in per_frame]
    final_score = aggregate_scores(scores, method=aggregation)

    return {
        "ok": True,
        "agg": aggregation,
        "video_score": final_score,
        "mean_score": aggregate_scores(scores, method="mean"),
        "median_score": aggregate_scores(scores, method="median"),
        "score_std": float(np.std(scores)) if scores else None,
        "high_frame_count": int(sum(1 for score in scores if score >= threshold)),
        "frames_used": len(per_frame),
        "per_frame": per_frame,
        "prob_mode": "softmax_class_1",
        "preprocess": {"resize": [224, 224], "mean": list(DEFAULT_IMAGENET_MEAN), "std": list(DEFAULT_IMAGENET_STD)},
        "loaded_from": _LOADED_FROM,
        "prediction": classify_score(final_score, threshold=threshold),
        "threshold": float(threshold),
    }
