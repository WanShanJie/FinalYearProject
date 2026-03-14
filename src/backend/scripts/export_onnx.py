"""
export_onnx.py

Export trained Xception model to ONNX for faster CPU inference.

Example:
python export_onnx.py --ckpt checkpoints/best.pt --out xception_deepfake.onnx
"""

from __future__ import annotations

import argparse
import torch
from model_xception import load_model


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", type=str, required=True)
    p.add_argument("--out", type=str, required=True)
    p.add_argument("--opset", type=int, default=17)
    return p.parse_args()


def main():
    args = parse_args()
    model = load_model(args.ckpt, device="cpu")
    dummy = torch.randn(1, 3, 299, 299)

    torch.onnx.export(
        model,
        dummy,
        args.out,
        input_names=["input"],
        output_names=["logits"],
        opset_version=args.opset,
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
    )

    print("Exported ONNX to:", args.out)


if __name__ == "__main__":
    main()
