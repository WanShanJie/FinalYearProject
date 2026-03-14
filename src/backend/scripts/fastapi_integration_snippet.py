"""
fastapi_integration_snippet.py

Helper for your FastAPI backend. Loads model once, scores a folder of crops,
and returns:
- video_score (fake probability)
- per_frame list (for DB meta / debugging)

Your pipeline: uploads/{analysis_id}_faces/face_###.jpg
"""

from __future__ import annotations

import os
from typing import List, Tuple, Dict

import numpy as np
from PIL import Image

import torch
from torchvision import transforms

from model_xception import load_model
from dataset import IMAGENET_MEAN, IMAGENET_STD


def _list_images(d: str) -> List[str]:
    fns = []
    for fn in os.listdir(d):
        if fn.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            fns.append(os.path.join(d, fn))
    return sorted(fns)


def _tf():
    return transforms.Compose([
        transforms.Resize(320),
        transforms.CenterCrop(299),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])


def _aggregate(scores: List[float], method: str) -> float:
    arr = np.array(scores, dtype=np.float32)
    if len(arr) == 0:
        return float("nan")
    if method == "mean":
        return float(arr.mean())
    if method == "median":
        return float(np.median(arr))
    if method == "trimmed_mean":
        if len(arr) < 5:
            return float(arr.mean())
        lo = int(len(arr) * 0.1)
        hi = int(len(arr) * 0.9)
        return float(np.sort(arr)[lo:hi].mean())
    raise ValueError(method)


class XceptionScorer:
    def __init__(self, ckpt_path: str, device: str = "cpu"):
        self.device = device
        self.model = load_model(ckpt_path, device=device)
        self.tf = _tf()

    @torch.no_grad()
    def score_folder(self, folder: str, agg: str = "mean") -> Tuple[float, List[Dict]]:
        paths = _list_images(folder)
        if not paths:
            return float("nan"), []

        batch = []
        for p in paths:
            img = Image.open(p).convert("RGB")
            batch.append(self.tf(img))
        x = torch.stack(batch, dim=0).to(self.device)

        logits = self.model(x)
        probs = torch.sigmoid(logits).detach().cpu().numpy().tolist()
        per_frame = [{"file": os.path.basename(p), "fake_prob": float(s)} for p, s in zip(paths, probs)]
        score = _aggregate([float(s) for s in probs], method=agg)
        return score, per_frame
