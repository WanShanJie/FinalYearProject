"""scripts/dfdc_model.py

Loads the Kaggle DFDC Xception checkpoint (e.g. model_v3.pth).

We inspected the checkpoint keys and it contains:
- backbone under prefix: base.0.*
- head under prefix: h1.* with shapes:
    h1.l.weight: [512, 2048]
    h1.o.weight: [1, 512]
    h1.b1.* BN(2048)
    h1.b2.* BN(512)

So we build:
- self.base = nn.Sequential(<pytorchcv xception backbone>)  # gives base.0.*
- self.h1 = Head()                                          # gives h1.*

This matches the checkpoint exactly so load_state_dict(strict=True) can succeed.

Dependency:
- pytorchcv (same library bundled with many DFDC/Kaggle solutions)
  pip install pytorchcv

"""

from __future__ import annotations

from typing import Tuple, Dict, Any
import torch
import torch.nn as nn
import torch.nn.functional as F


class HeadH1(nn.Module):
    def __init__(self):
        super().__init__()
        self.b1 = nn.BatchNorm1d(2048)
        self.l = nn.Linear(2048, 512)
        self.b2 = nn.BatchNorm1d(512)
        self.o = nn.Linear(512, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, 2048]
        x = self.b1(x)
        x = self.l(x)
        x = F.relu(x, inplace=True)
        x = self.b2(x)
        x = self.o(x)          # [B,1]
        return x.squeeze(1)    # [B]


class DFDCXception(nn.Module):
    def __init__(self):
        super().__init__()
        try:
            from pytorchcv.model_provider import get_model
        except Exception as e:
            raise ImportError(
                "pytorchcv is required to load DFDC Xception checkpoint.\n"
                "Install: pip install pytorchcv\n"
                f"Original import error: {e}"
            )

        backbone = get_model("xception", pretrained=False)
        # pytorchcv xception returns logits by default; we want feature map before classifier.
        # In pytorchcv, classifier is typically `output` or `final_pool` + `output`.
        # We remove classifier parts by taking all children except the last `output` layer if present.
        # Many pytorchcv models keep feature extractor in `features` attr.
        if hasattr(backbone, "features"):
            feature_extractor = backbone.features
        else:
            # fallback: drop last layer if named output
            modules = []
            for name, m in backbone.named_children():
                if name in ("output", "classifier", "fc"):
                    continue
                modules.append(m)
            feature_extractor = nn.Sequential(*modules)

        self.base = nn.Sequential(feature_extractor)  # prefix base.0.*
        self.h1 = HeadH1()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feats = self.base(x)  # usually [B,2048,H,W]
        if feats.ndim == 4:
            feats = F.adaptive_avg_pool2d(feats, (1, 1)).view(feats.size(0), -1)  # [B,2048]
        return self.h1(feats)


def load_dfdc_checkpoint(ckpt_path: str, device: str = "cpu") -> Tuple[nn.Module, str]:
    state = torch.load(ckpt_path, map_location=device, weights_only=True)
    if not isinstance(state, dict):
        raise ValueError("Expected state_dict/OrderedDict for model_v3.pth")

    model = DFDCXception().to(device).eval()
    missing, unexpected = model.load_state_dict(state, strict=True)
    info = f"{ckpt_path} (strict=True, missing={len(missing)}, unexpected={len(unexpected)})"
    return model, info