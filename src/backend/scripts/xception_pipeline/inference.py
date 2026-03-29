from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Sequence

import torch

from .aggregator import summarize_video_result
from .model_loader import get_default_device, load_xception_model
from .preprocess import (
    DEFAULT_IMAGENET_MEAN,
    DEFAULT_IMAGENET_STD,
    DEFAULT_INPUT_SIZE,
    build_preprocess_transform,
    load_image_paths,
    load_pil_image,
)


def _probabilities_from_logits(logits: torch.Tensor) -> torch.Tensor:
    if logits.ndim == 1:
        logits = logits.unsqueeze(1)

    if logits.shape[1] == 1:
        return torch.sigmoid(logits[:, 0])

    if logits.shape[1] >= 2:
        probs = torch.softmax(logits, dim=1)
        return probs[:, 1]

    raise ValueError(f"Unexpected logits shape: {tuple(logits.shape)}")


@torch.no_grad()
def run_frame_inference(
    model: torch.nn.Module,
    image_paths: Sequence[str | Path],
    *,
    device: Optional[str] = None,
    batch_size: int = 8,
    image_size: int = DEFAULT_INPUT_SIZE,
    mean=DEFAULT_IMAGENET_MEAN,
    std=DEFAULT_IMAGENET_STD,
) -> List[Dict[str, float]]:
    runtime_device = get_default_device(device)
    transform = build_preprocess_transform(image_size=image_size, mean=mean, std=std)

    per_frame_scores: List[Dict[str, float]] = []
    paths = [Path(path) for path in image_paths]
    batch_size = max(1, int(batch_size))

    for start in range(0, len(paths), batch_size):
        batch_paths = paths[start : start + batch_size]
        batch_tensors = [transform(load_pil_image(path)) for path in batch_paths]
        batch = torch.stack(batch_tensors, dim=0).to(runtime_device)
        logits = model(batch)
        fake_probs = _probabilities_from_logits(logits).detach().cpu().tolist()

        for path, score in zip(batch_paths, fake_probs):
            per_frame_scores.append(
                {
                    "frame_path": str(path),
                    "fake_prob": float(score),
                }
            )

    return per_frame_scores


def run_directory_inference(
    frames_dir: str | Path,
    checkpoint_path: str | Path,
    *,
    batch_size: int = 8,
    aggregation: str = "mean",
    threshold: float = 0.5,
    max_frames: Optional[int] = None,
    image_size: int = DEFAULT_INPUT_SIZE,
    mean=DEFAULT_IMAGENET_MEAN,
    std=DEFAULT_IMAGENET_STD,
    device: Optional[str] = None,
    strict: bool = False,
) -> Dict[str, object]:
    model, load_info = load_xception_model(checkpoint_path, device=device, strict=strict)
    image_paths = load_image_paths(frames_dir, max_frames=max_frames)
    per_frame_scores = run_frame_inference(
        model,
        image_paths,
        device=str(get_default_device(device)),
        batch_size=batch_size,
        image_size=image_size,
        mean=mean,
        std=std,
    )
    result = summarize_video_result(
        per_frame_scores,
        aggregation=aggregation,
        threshold=threshold,
    )
    result["model_info"] = load_info
    result["frames_used"] = len(per_frame_scores)
    return result
