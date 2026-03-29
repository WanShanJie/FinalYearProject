from __future__ import annotations

from pathlib import Path
from typing import Iterable, List, Sequence

from PIL import Image
from torchvision import transforms

DEFAULT_INPUT_SIZE = 224
DEFAULT_IMAGENET_MEAN = (0.485, 0.456, 0.406)
DEFAULT_IMAGENET_STD = (0.229, 0.224, 0.225)
DEFAULT_EXTENSIONS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def build_preprocess_transform(
    image_size: int = DEFAULT_INPUT_SIZE,
    mean: Sequence[float] = DEFAULT_IMAGENET_MEAN,
    std: Sequence[float] = DEFAULT_IMAGENET_STD,
):
    return transforms.Compose(
        [
            transforms.Resize((image_size, image_size)),
            transforms.ToTensor(),
            transforms.Normalize(mean=mean, std=std),
        ]
    )


def load_image_paths(
    frames_dir: str | Path,
    max_frames: int | None = None,
    extensions: Iterable[str] = DEFAULT_EXTENSIONS,
) -> List[Path]:
    frames_dir = Path(frames_dir)
    if not frames_dir.exists():
        raise FileNotFoundError(f"Frames directory not found: {frames_dir}")
    if not frames_dir.is_dir():
        raise NotADirectoryError(f"Expected a directory of frames, got: {frames_dir}")

    allowed = {ext.lower() for ext in extensions}
    paths = sorted(
        path for path in frames_dir.iterdir()
        if path.is_file() and path.suffix.lower() in allowed
    )
    if max_frames is not None:
        paths = paths[: max(0, int(max_frames))]
    return paths


def load_pil_image(path: str | Path) -> Image.Image:
    return Image.open(path).convert("RGB")
