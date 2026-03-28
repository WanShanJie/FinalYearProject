from __future__ import annotations

import os
import sys
import numpy as np
import torch
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from PIL import Image
from torchvision import transforms

from scripts.altfreezing_config import (
    ALTFREEZING_REPO_CANDIDATES,
    ALTFREEZING_WEIGHTS,
    SEQUENCE_LENGTH,
    HIGH_FRAME_THRESHOLD,
    WINDOW_STRIDE,
    MAX_WINDOWS,
)

INPUT_SIZE = 224
MEAN_IMAGENET = [0.485, 0.456, 0.406]
STD_IMAGENET = [0.229, 0.224, 0.225]

_TF = transforms.Compose([
    transforms.Resize((INPUT_SIZE, INPUT_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(mean=MEAN_IMAGENET, std=STD_IMAGENET),
])

_DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_READY = False
_MODEL = None
_ERROR: Optional[str] = None
_REPO_PATH: Optional[Path] = None
_WEIGHTS_PATH: str = ALTFREEZING_WEIGHTS
_MODEL_CLIP_SIZE: int = 32


def _find_repo() -> Optional[Path]:
    env_path = os.getenv("ALT_FREEZING_REPO")
    candidates = [Path(env_path)] if env_path else []
    candidates += list(ALTFREEZING_REPO_CANDIDATES)
    for c in candidates:
        if c and c.exists() and (c / "demo.py").exists():
            return c
    return None


def _add_repo_to_path(repo: Path) -> None:
    s = str(repo)
    if s not in sys.path:
        sys.path.insert(0, s)


def init(weights_path: str = ALTFREEZING_WEIGHTS) -> None:
    global _READY, _ERROR, _MODEL, _REPO_PATH, _WEIGHTS_PATH, _MODEL_CLIP_SIZE
    _WEIGHTS_PATH = weights_path

    repo = _find_repo()
    if repo is None:
        _ERROR = "altfreezing_repo_not_found"
        _READY = False
        return

    _REPO_PATH = repo
    _add_repo_to_path(repo)

    weights = Path(weights_path)
    if not weights.exists():
        _ERROR = f"checkpoint_not_found:{weights_path}"
        _READY = False
        return

    os.environ.setdefault("PYTHONUTF8", "1")
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(errors="replace")
    except Exception:
        pass

    try:
        from config import config as cfg
        from utils.plugin_loader import PluginLoader

        root_yaml_path = _REPO_PATH / "root_setting.yaml"
        model_yaml_path = _REPO_PATH / "setting" / "i3d_ori.yaml"

        with open(root_yaml_path, encoding="utf-8", errors="replace") as f:
            cfg.update_with_text(f.read())
        with open(model_yaml_path, encoding="utf-8", errors="replace") as f:
            cfg.update_with_text(f.read())

        cfg.setting_name = "i3d_ori"
        cfg.freeze()

        clip_size = getattr(cfg, "clip_size", None)
        if clip_size is None:
            clip_size = getattr(cfg, "num_frames", None)
        _MODEL_CLIP_SIZE = int(clip_size or 32)

        classifier = PluginLoader.get_classifier(cfg.classifier_type)()
        classifier.to(_DEVICE)
        classifier.eval()
        classifier.load(str(weights))

        _MODEL = classifier
        _READY = True
        _ERROR = None
        print(f"[AltFreezing] Model ready on {_DEVICE}. Weights: {weights_path}. clip_size={_MODEL_CLIP_SIZE}")
    except Exception as e:
        import traceback
        _ERROR = f"altfreezing_init_failed:{e}"
        _READY = False
        _MODEL = None
        print(f"[AltFreezing] Init failed: {e}")
        traceback.print_exc()


def _resample_paths(paths: List[Path], target_len: int) -> List[Path]:
    if not paths:
        return []
    if len(paths) == target_len:
        return list(paths)
    idxs = np.linspace(0, len(paths) - 1, num=target_len)
    return [paths[int(round(i))] for i in idxs]


def _load_sequence_paths(seq_dir: Path) -> List[Path]:
    return sorted(seq_dir.glob("face_*.jpg"))


def _load_sequence(paths: List[Path]) -> Tuple[List[torch.Tensor], List[Path]]:
    frames: List[torch.Tensor] = []
    ok_paths: List[Path] = []
    for p in paths:
        try:
            img = Image.open(p).convert("RGB")
            frames.append(_TF(img))
            ok_paths.append(p)
        except Exception:
            continue
    return frames, ok_paths


def _build_window_specs(
    raw_paths: List[Path],
    clip_len: int,
    target_sequence_len: int,
    stride: int = WINDOW_STRIDE,
    max_windows: int = MAX_WINDOWS,
) -> List[Dict[str, Any]]:
    if not raw_paths:
        return []

    working_paths = list(raw_paths)
    if target_sequence_len > 0 and len(working_paths) > target_sequence_len:
        working_paths = _resample_paths(working_paths, target_sequence_len)

    if len(working_paths) <= clip_len:
        return [{
            "index": 0,
            "paths": _resample_paths(working_paths, clip_len),
            "start_frame": 0,
            "end_frame": max(0, len(working_paths) - 1),
            "source_frames": len(working_paths),
        }]

    effective_stride = max(1, int(stride or 0))
    last_start = max(0, len(working_paths) - clip_len)
    starts = list(range(0, last_start + 1, effective_stride))
    if not starts or starts[-1] != last_start:
        starts.append(last_start)

    if len(starts) > max_windows:
        selected = np.linspace(0, len(starts) - 1, num=max_windows).round().astype(int).tolist()
        starts = [starts[idx] for idx in selected]

    specs: List[Dict[str, Any]] = []
    for index, start in enumerate(starts):
        chunk = working_paths[start:start + clip_len]
        specs.append({
            "index": index,
            "paths": chunk,
            "start_frame": start,
            "end_frame": start + len(chunk) - 1,
            "source_frames": len(chunk),
        })
    return specs


def _extract_probability(output: Any) -> float:
    if isinstance(output, dict):
        logit = output.get("final_output")
    else:
        logit = output
    if logit is None:
        raise RuntimeError("altfreezing_missing_final_output")
    if isinstance(logit, (list, tuple)):
        logit = logit[0]
    prob = torch.sigmoid(logit.float()).detach().cpu().view(-1).mean().item()
    return float(prob)


def _adjacent_diversity(image_paths: List[Path], resize: int = 64) -> float:
    # Measures how much adjacent crops change over time; very low diversity means duplicated/static evidence.
    vals = []
    prev = None
    for p in image_paths:
        try:
            img = Image.open(p).convert("L").resize((resize, resize))
            arr = np.asarray(img, dtype=np.float32) / 255.0
        except Exception:
            continue
        if prev is not None:
            vals.append(float(np.mean(np.abs(arr - prev))))
        prev = arr
    if not vals:
        return 0.0
    return float(np.mean(vals))


def _coverage_quality(unique_frames: int, model_clip: int) -> float:
    # 8 unique frames into a 32-frame model clip should not be treated as equally trustworthy as a full 32.
    # Normalize against 16 because most browser captures will not reasonably provide 32 truly unique frames.
    return max(0.25, min(1.0, unique_frames / max(16.0, model_clip / 2.0)))


def _diversity_quality(diversity: float) -> float:
    # Map adjacent-frame diversity into [0.35, 1.0].
    # Interview/talking-head videos have naturally low diversity (~0.03-0.06)
    # because the subject barely moves. This is a property of real content, NOT
    # a sign of poor evidence. Calibrating against 0.03 means real interviews
    # score ~0.6-1.0 instead of being penalised as low-quality.
    q = diversity / 0.03
    return max(0.35, min(1.0, q))


def _calibrate_score(raw_score: float, unique_frames: int, model_clip: int, diversity: float) -> Tuple[float, Dict[str, float]]:
    cover_q = _coverage_quality(unique_frames, model_clip)
    div_q = _diversity_quality(diversity)
    evidence_q = 0.65 * cover_q + 0.35 * div_q
    # Shrink extreme probabilities toward 0.5 when evidence quality is weak.
    calibrated = 0.5 + (raw_score - 0.5) * evidence_q
    return float(calibrated), {
        "coverage_quality": float(cover_q),
        "diversity_quality": float(div_q),
        "evidence_quality": float(evidence_q),
    }


@torch.no_grad()
def predict_from_sequence(
    analysis_id: int,
    uploads_dir: Path,
    sequence_length: int = SEQUENCE_LENGTH,
    weights_path: str = ALTFREEZING_WEIGHTS,
) -> Dict[str, Any]:
    if not _READY:
        init(weights_path)

    if not _READY or _MODEL is None:
        return {
            "ok": False,
            "error": _ERROR or "altfreezing_not_ready",
            "video_score": None,
            "raw_video_score": None,
            "frames_used": 0,
            "sequence_length": sequence_length,
            "model_name": "AltFreezing",
            "loaded_from": _WEIGHTS_PATH,
            "repo_path": str(_REPO_PATH) if _REPO_PATH else None,
        }

    seq_dir = Path(uploads_dir) / f"{analysis_id}_seq"
    raw_paths = _load_sequence_paths(seq_dir)
    model_clip_len = max(int(_MODEL_CLIP_SIZE), 16)
    target_sequence_len = max(int(sequence_length), model_clip_len)

    if len(raw_paths) < 2:
        return {
            "ok": False,
            "error": "insufficient_sequence_frames",
            "video_score": None,
            "raw_video_score": None,
            "frames_used": len(raw_paths),
            "sequence_length": target_sequence_len,
            "model_name": "AltFreezing",
            "loaded_from": _WEIGHTS_PATH,
            "repo_path": str(_REPO_PATH) if _REPO_PATH else None,
        }

    try:
        window_specs = _build_window_specs(raw_paths, model_clip_len, target_sequence_len)
        if not window_specs:
            return {
                "ok": False,
                "error": "insufficient_prediction_windows",
                "video_score": None,
                "raw_video_score": None,
                "frames_used": len(raw_paths),
                "sequence_length": target_sequence_len,
                "model_name": "AltFreezing",
                "loaded_from": _WEIGHTS_PATH,
                "repo_path": str(_REPO_PATH) if _REPO_PATH else None,
            }

        probs: List[float] = []
        raw_probs: List[float] = []
        per_window: List[Dict[str, Any]] = []
        evidence_qualities: List[float] = []
        coverage_qualities: List[float] = []
        diversity_qualities: List[float] = []
        window_diversities: List[float] = []

        for window in window_specs:
            frames, used_paths = _load_sequence(window["paths"])
            if len(frames) < 2:
                continue

            clip = torch.stack(frames, dim=0)      # [T, 3, H, W]
            clip = clip.permute(1, 0, 2, 3)        # [3, T, H, W]
            clip = clip.unsqueeze(0).to(_DEVICE)   # [1, 3, T, H, W]

            output = _MODEL(clip)
            raw_prob = _extract_probability(output)

            unique_frames = len({str(path) for path in used_paths})
            window_diversity = _adjacent_diversity(used_paths)
            calibrated_prob, quality = _calibrate_score(raw_prob, unique_frames, model_clip_len, window_diversity)

            probs.append(calibrated_prob)
            raw_probs.append(raw_prob)
            evidence_qualities.append(float(quality["evidence_quality"]))
            coverage_qualities.append(float(quality["coverage_quality"]))
            diversity_qualities.append(float(quality["diversity_quality"]))
            window_diversities.append(float(window_diversity))
            per_window.append({
                "window": window["index"],
                "start_frame": window["start_frame"],
                "end_frame": window["end_frame"],
                "source_frames": window["source_frames"],
                "fake_prob": float(calibrated_prob),
                "raw_fake_prob": float(raw_prob),
                "temporal_diversity": float(window_diversity),
                "evidence_quality": float(quality["evidence_quality"]),
            })

        if not probs:
            return {
                "ok": False,
                "error": "inference_failed:no_valid_windows",
                "video_score": None,
                "raw_video_score": None,
                "frames_used": len(raw_paths),
                "sequence_length": target_sequence_len,
                "model_name": "AltFreezing",
                "loaded_from": _WEIGHTS_PATH,
                "repo_path": str(_REPO_PATH) if _REPO_PATH else None,
            }

        diversity = _adjacent_diversity(raw_paths)
        total_windows = len(probs)
        median_score = float(np.median(probs))
        mean_score = float(np.mean(probs))
        raw_median_score = float(np.median(raw_probs))
        raw_mean_score = float(np.mean(raw_probs))
        score_std = float(np.std(probs)) if total_windows > 1 else 0.0
        high_frame_count = int(sum(1 for p in raw_probs if p >= HIGH_FRAME_THRESHOLD))
        window_count_quality = max(0.25, min(1.0, total_windows / 3.0))
        avg_evidence_quality = float(np.mean(evidence_qualities))
        aggregated_evidence_quality = float(0.75 * avg_evidence_quality + 0.25 * window_count_quality)

        return {
            "ok": True,
            "video_score": median_score,
            "raw_video_score": raw_median_score,
            "median_score": median_score,
            "mean_score": mean_score,
            "raw_mean_score": raw_mean_score,
            "score_std": score_std,
            "high_frame_count": high_frame_count,
            "total_windows": total_windows,
            "frames_used": len(raw_paths),
            "sequence_length": target_sequence_len,
            "per_frame": per_window,
            "model_name": "AltFreezing",
            "loaded_from": _WEIGHTS_PATH,
            "repo_path": str(_REPO_PATH),
            "preprocess": {
                "resize": INPUT_SIZE,
                "mean": MEAN_IMAGENET,
                "std": STD_IMAGENET,
                "input_shape": f"[1, 3, {model_clip_len}, {INPUT_SIZE}, {INPUT_SIZE}]",
                "model_clip_size": model_clip_len,
                "resampled_from_frames": len(raw_paths),
                "sequence_budget": target_sequence_len,
                "window_stride": WINDOW_STRIDE,
            },
            "calibration": {
                "coverage_quality": float(np.mean(coverage_qualities)),
                "diversity_quality": float(np.mean(diversity_qualities)),
                "evidence_quality": aggregated_evidence_quality,
                "window_count_quality": window_count_quality,
                "temporal_diversity": diversity,
                "window_temporal_diversity": float(np.mean(window_diversities)),
                "note": "video_score is confidence-adjusted from raw_video_score based on sequence evidence",
            },
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "ok": False,
            "error": f"inference_failed:{e}",
            "video_score": None,
            "raw_video_score": None,
            "frames_used": len(raw_paths),
            "sequence_length": target_sequence_len,
            "model_name": "AltFreezing",
            "loaded_from": _WEIGHTS_PATH,
        }