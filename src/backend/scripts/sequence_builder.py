from pathlib import Path
from typing import List
from PIL import Image


def load_sequence_images(seq_dir: Path, max_frames: int = 16) -> List[Image.Image]:
    paths = sorted(seq_dir.glob("face_*.jpg"))[:max_frames]
    images = []
    for p in paths:
        try:
            images.append(Image.open(p).convert("RGB"))
        except Exception:
            continue
    return images
