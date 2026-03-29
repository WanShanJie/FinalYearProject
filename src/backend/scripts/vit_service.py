from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForImageClassification

from scripts.vit_config import (
    VIT_HIGH_FAKE_THRESHOLD,
    VIT_LOCAL_ONLY,
    VIT_MAX_FRAMES,
    VIT_MODEL_ID,
)

_DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_READY = False
_ERROR: Optional[str] = None
_MODEL = None
_PROCESSOR = None
_MODEL_ID = VIT_MODEL_ID
_FAKE_LABEL = "fake"
_REAL_LABEL = "real"
_FAKE_INDEX = 1


def _error_payload(error: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "video_score": None,
        "mean_score": None,
        "score_std": None,
        "high_frame_count": 0,
        "frames_used": 0,
        "per_frame": [],
        "model_name": "ViT",
        "loaded_from": _MODEL_ID,
        "error": error,
    }


def _pick_evenly(paths: List[Path], limit: int) -> List[Path]:
    if len(paths) <= limit:
        return list(paths)
    idxs = np.linspace(0, len(paths) - 1, num=limit).round().astype(int).tolist()
    seen = set()
    selected: List[Path] = []
    for idx in idxs:
        if idx in seen:
            continue
        seen.add(idx)
        selected.append(paths[idx])
    return selected


def _resolve_fake_index(id2label: Dict[int, str]) -> tuple[int, str, str]:
    normalized = {int(k): str(v).strip() for k, v in (id2label or {}).items()}
    fake_idx = None
    real_idx = None
    for idx, label in normalized.items():
        label_lower = label.lower()
        if fake_idx is None and ("fake" in label_lower or "deepfake" in label_lower):
            fake_idx = idx
        if real_idx is None and ("real" in label_lower or "authentic" in label_lower):
            real_idx = idx

    if fake_idx is None:
        for idx, label in normalized.items():
            if "real" not in label.lower():
                fake_idx = idx
                break
    if fake_idx is None:
        fake_idx = max(normalized.keys()) if normalized else 1

    if real_idx is None:
        remaining = [idx for idx in normalized.keys() if idx != fake_idx]
        real_idx = remaining[0] if remaining else 0

    fake_label = normalized.get(fake_idx, "fake")
    real_label = normalized.get(real_idx, "real")
    return fake_idx, fake_label, real_label


def init(model_id: str = VIT_MODEL_ID) -> None:
    global _READY, _ERROR, _MODEL, _PROCESSOR, _MODEL_ID, _FAKE_INDEX, _FAKE_LABEL, _REAL_LABEL
    _MODEL_ID = model_id
    local_only = str(os.getenv("HF_LOCAL_ONLY", str(VIT_LOCAL_ONLY))).lower() in {"1", "true", "yes"}

    try:
        _PROCESSOR = AutoImageProcessor.from_pretrained(model_id, local_files_only=local_only)
        _MODEL = AutoModelForImageClassification.from_pretrained(model_id, local_files_only=local_only)
        _MODEL.to(_DEVICE)
        _MODEL.eval()
        _FAKE_INDEX, _FAKE_LABEL, _REAL_LABEL = _resolve_fake_index(getattr(_MODEL.config, "id2label", {}) or {})
        _READY = True
        _ERROR = None
        print(f"[ViT] Model ready on {_DEVICE}. Source: {model_id}. fake_label={_FAKE_LABEL} real_label={_REAL_LABEL}")
    except Exception as exc:
        _READY = False
        _MODEL = None
        _PROCESSOR = None
        _ERROR = f"vit_init_failed:{exc}"
        print(f"[ViT] Init failed: {exc}")


@torch.no_grad()
def predict_from_crops(
    crop_paths: List[str] | List[Path],
    model_id: str = VIT_MODEL_ID,
    max_frames: int = VIT_MAX_FRAMES,
) -> Dict[str, Any]:
    if not _READY:
        init(model_id)
    if not _READY or _MODEL is None or _PROCESSOR is None:
        return _error_payload(_ERROR or "vit_not_ready")

    paths = [Path(p) for p in (crop_paths or []) if p]
    paths = [p for p in paths if p.exists()]
    if not paths:
        return _error_payload("no_crop_paths")

    selected = _pick_evenly(paths, max(1, int(max_frames or VIT_MAX_FRAMES)))
    images: List[Image.Image] = []
    image_paths: List[Path] = []
    for path in selected:
        try:
            img = Image.open(path).convert("RGB")
            images.append(img)
            image_paths.append(path)
        except Exception:
            continue

    if not images:
        return _error_payload("no_valid_crop_images")

    try:
        inputs = _PROCESSOR(images=images, return_tensors="pt")
        inputs = {k: v.to(_DEVICE) for k, v in inputs.items()}
        outputs = _MODEL(**inputs)
        probs = torch.softmax(outputs.logits, dim=-1).detach().cpu().numpy()
    except Exception as exc:
        return _error_payload(f"vit_inference_failed:{exc}")

    fake_probs = probs[:, _FAKE_INDEX].astype(float).tolist()
    score_std = float(np.std(fake_probs)) if len(fake_probs) > 1 else 0.0
    mean_score = float(np.mean(fake_probs))
    per_frame = [
        {
            "crop_path": str(path),
            "fake_prob": float(prob),
            "frame_index": idx,
        }
        for idx, (path, prob) in enumerate(zip(image_paths, fake_probs))
    ]

    return {
        "ok": True,
        "video_score": mean_score,
        "mean_score": mean_score,
        "score_std": score_std,
        "high_frame_count": int(sum(1 for prob in fake_probs if prob >= VIT_HIGH_FAKE_THRESHOLD)),
        "frames_used": len(fake_probs),
        "per_frame": per_frame,
        "model_name": "ViT",
        "loaded_from": _MODEL_ID,
        "fake_label": _FAKE_LABEL,
        "real_label": _REAL_LABEL,
        "error": None,
        "calibration": {
            "max_frames": len(fake_probs),
            "note": "video_score is the mean fake probability across evenly sampled face crops.",
        },
    }
