from __future__ import annotations

import argparse
import json

from .inference import run_directory_inference


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Xception deepfake inference on a folder of face crops.")
    parser.add_argument("--frames-dir", required=True, help="Directory containing cropped face images.")
    parser.add_argument("--checkpoint", required=True, help="Path to xception_best.pth or a compatible checkpoint.")
    parser.add_argument("--batch-size", type=int, default=8, help="Inference batch size.")
    parser.add_argument("--aggregation", choices=["mean", "median"], default="mean", help="Video-level aggregation.")
    parser.add_argument("--threshold", type=float, default=0.5, help="Fake threshold.")
    parser.add_argument("--max-frames", type=int, default=None, help="Optional frame cap.")
    parser.add_argument("--image-size", type=int, default=224, help="Resize input to N x N.")
    parser.add_argument("--device", default=None, help="Override device, e.g. cpu or cuda.")
    parser.add_argument("--strict", action="store_true", help="Load checkpoint with strict=True.")
    args = parser.parse_args()

    result = run_directory_inference(
        frames_dir=args.frames_dir,
        checkpoint_path=args.checkpoint,
        batch_size=args.batch_size,
        aggregation=args.aggregation,
        threshold=args.threshold,
        max_frames=args.max_frames,
        image_size=args.image_size,
        device=args.device,
        strict=args.strict,
    )

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
