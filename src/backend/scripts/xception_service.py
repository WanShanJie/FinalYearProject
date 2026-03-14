from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional

import numpy as np
import torch
from PIL import Image
from torchvision import transforms

from scripts.dfdc_model import load_dfdc_checkpoint

_DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_MODEL = None
_READY = False
_ERROR: Optional[str] = None
_LOADED_FROM = ""

_TF = transforms.Compose([
    transforms.Resize((299, 299)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]),
])


def init(weights_path: str = "checkpoints/model_v3.pth"):
    global _MODEL, _READY, _ERROR, _LOADED_FROM
    try:
        _MODEL, info = load_dfdc_checkpoint(weights_path, device=str(_DEVICE))
        _MODEL.eval()
        _READY = True
        _ERROR = None
        _LOADED_FROM = str(info or weights_path)
        print(f"[xception_service] ready on {_DEVICE}: {_LOADED_FROM}")
    except Exception as e:
        _MODEL = None
        _READY = False
        _ERROR = str(e)
        _LOADED_FROM = weights_path
        print(f"[xception_service] init failed: {_ERROR}")


def _load_crops(analysis_id: int, uploads_dir: Path, max_frames: int) -> List[Tuple[str, Image.Image]]:
    faces_dir = uploads_dir / f"{analysis_id}_faces"
    if not faces_dir.exists():
        return []
    paths = sorted(list(faces_dir.glob("face_*.jpg")))[:max_frames]
    crops: List[Tuple[str, Image.Image]] = []
    for p in paths:
        try:
            crops.append((str(p), Image.open(p).convert("RGB")))
        except Exception:
            continue
    return crops


@torch.no_grad()
def predict_from_analysis(
    analysis_id: int,
    uploads_dir: Path,
    max_frames: int = 10,
) -> Dict[str, Any]:
    if not _READY or _MODEL is None:
        return {
            "ok": False,
            "error": _ERROR or "xception_not_ready",
            "video_score": None,
            "frames_used": 0,
            "per_frame": [],
            "loaded_from": _LOADED_FROM,
        }

    crops = _load_crops(analysis_id, uploads_dir, max_frames)
    if not crops:
        return {
            "ok": False,
            "error": "no_face_crops",
            "video_score": None,
            "frames_used": 0,
            "per_frame": [],
            "loaded_from": _LOADED_FROM,
        }

    batch = torch.stack([_TF(img) for (_, img) in crops], dim=0).to(_DEVICE)
    logits = _MODEL(batch)
    probs = torch.sigmoid(logits).detach().cpu().numpy().reshape(-1).tolist()

    median_score = float(np.median(probs)) if probs else None
    mean_score = float(np.mean(probs)) if probs else None
    score_std = float(np.std(probs)) if probs else None
    high_frame_count = int(sum(1 for p in probs if p >= 0.90))

    per_frame = [
        {"crop_path": p, "fake_prob": float(s)}
        for (p, _), s in zip(crops, probs)
    ]

    return {
        "ok": True,
        "agg": "median",
        "video_score": median_score,
        "median_score": median_score,
        "mean_score": mean_score,
        "score_std": score_std,
        "high_frame_count": high_frame_count,
        "frames_used": len(probs),
        "per_frame": per_frame,
        "prob_mode": "sigmoid_1logit",
        "preprocess": {"resize": [299, 299], "mean": [0.5, 0.5, 0.5], "std": [0.5, 0.5, 0.5]},
        "loaded_from": _LOADED_FROM,
    }


def verdict(score: Optional[float]) -> str:
    if score is None:
        return "INCONCLUSIVE"
    if score >= 0.80:
        return "FAKE"
    if score <= 0.35:
        return "REAL"
    return "INCONCLUSIVE"
