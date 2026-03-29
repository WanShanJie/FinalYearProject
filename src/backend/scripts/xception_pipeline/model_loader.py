from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import torch
import torch.nn as nn
import timm


def get_default_device(device: Optional[str] = None) -> torch.device:
    if device:
        return torch.device(device)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _unwrap_checkpoint(checkpoint: Any) -> Dict[str, torch.Tensor]:
    if isinstance(checkpoint, dict):
        for key in ("state_dict", "model", "model_state_dict", "net", "weights"):
            candidate = checkpoint.get(key)
            if isinstance(candidate, dict):
                checkpoint = candidate
                break

    if not isinstance(checkpoint, dict):
        raise ValueError("Unsupported checkpoint format: expected a state_dict-like mapping.")

    return checkpoint


def _normalize_state_dict_keys(state_dict: Dict[str, torch.Tensor]) -> Dict[str, torch.Tensor]:
    normalized: Dict[str, torch.Tensor] = {}
    for key, value in state_dict.items():
        new_key = str(key)
        for prefix in ("module.", "model.", "net."):
            if new_key.startswith(prefix):
                new_key = new_key[len(prefix):]
        if new_key.startswith("state_dict."):
            new_key = new_key[len("state_dict."):]
        if new_key.startswith("backbone.fc."):
            new_key = new_key.replace("backbone.fc.", "backbone.last_linear.", 1)
        normalized[new_key] = value
    return normalized


def infer_num_classes(state_dict: Dict[str, torch.Tensor], default: int = 2) -> int:
    for key in ("backbone.last_linear.weight", "backbone.fc.weight", "last_linear.weight", "fc.weight"):
        weight = state_dict.get(key)
        if isinstance(weight, torch.Tensor) and weight.ndim >= 2:
            return int(weight.shape[0])
    return default


class DeepfakeBenchXception(nn.Module):
    """
    Xception wrapper compatible with DeepfakeBench-style checkpoints that store:
    - backbone.* feature extractor weights
    - backbone.last_linear.* classifier weights
    - optional backbone.adjust_channel.* auxiliary block
    """

    def __init__(self, num_classes: int = 2) -> None:
        super().__init__()
        backbone = timm.create_model("legacy_xception", pretrained=False, num_classes=num_classes)

        # DeepfakeBench-style checkpoints often use `last_linear` instead of timm's `fc`.
        backbone.last_linear = backbone.fc
        del backbone.fc

        # Some training pipelines add an auxiliary channel adjust block even if it is
        # not needed at inference time. We keep it so checkpoints can load cleanly.
        backbone.adjust_channel = nn.Sequential(
            nn.Conv2d(2048, 512, kernel_size=1, stride=1, padding=0, bias=True),
            nn.BatchNorm2d(512),
        )

        self.backbone = backbone

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.backbone.forward_features(x)      # [B, 2048, H, W]
        pooled = self.backbone.global_pool(features)      # [B, 2048]
        logits = self.backbone.last_linear(pooled)        # [B, num_classes]
        return logits


def load_xception_model(
    checkpoint_path: str | Path,
    device: Optional[str] = None,
    strict: bool = False,
) -> Tuple[nn.Module, Dict[str, Any]]:
    checkpoint_path = Path(checkpoint_path)
    if not checkpoint_path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")

    runtime_device = get_default_device(device)
    raw_checkpoint = torch.load(checkpoint_path, map_location="cpu")
    raw_state_dict = _unwrap_checkpoint(raw_checkpoint)
    state_dict = _normalize_state_dict_keys(raw_state_dict)
    num_classes = infer_num_classes(state_dict)

    model = DeepfakeBenchXception(num_classes=num_classes).to(runtime_device)
    incompatible = model.load_state_dict(state_dict, strict=strict)
    model.eval()

    info = {
        "checkpoint_path": str(checkpoint_path),
        "device": str(runtime_device),
        "num_classes": num_classes,
        "strict": strict,
        "missing_keys": list(getattr(incompatible, "missing_keys", [])),
        "unexpected_keys": list(getattr(incompatible, "unexpected_keys", [])),
    }
    return model, info
