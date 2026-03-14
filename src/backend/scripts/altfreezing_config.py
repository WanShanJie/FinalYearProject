from pathlib import Path

ALTFREEZING_WEIGHTS = "checkpoints/model.pth"
ALTFREEZING_REPO_CANDIDATES = [
    Path(__file__).resolve().parents[1] / "third_party" / "AltFreezing",
    Path(__file__).resolve().parents[1] / "AltFreezing",
]
SEQUENCE_LENGTH = 8

# AltFreezing uses 224×224 with ImageNet mean/std (same as demo.py)
INPUT_SIZE = 224
MEAN = [0.485, 0.456, 0.406]
STD  = [0.229, 0.224, 0.225]

# A per-window score above this threshold counts as a "high" fake signal
HIGH_FRAME_THRESHOLD = 0.85
