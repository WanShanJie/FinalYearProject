"""wav2lip_service.py

Audio-visual lip-sync scoring using the pretrained Wav2Lip GAN model.

HOW THE SYNC SCORE WORKS
─────────────────────────
The model is used in *reconstruction* mode — NOT to generate a synthetic video:

  1. For each face frame, mask the lower half (mouth region) to zero.
  2. Feed [masked_face | original_face] (6-ch) + the aligned audio mel window
     to the Wav2Lip generator.
  3. The generator reconstructs what the mouth SHOULD look like given that audio.
  4. Compute MAE between the generated lower face and the actual lower face.
     • Low MAE  → generator and reality agree → lips were already in sync → REAL
     • High MAE → generator disagrees with reality → lips don't match audio → FAKE

SCORE INTERPRETATION
─────────────────────
  sync_score > 0.65  →  lips and audio appear synchronised  (authentic)
  sync_score 0.38–0.65  →  uncertain / use as supporting signal
  sync_score < 0.38  →  audio-visual desync detected  (possible manipulation)

REQUIRED DEPENDENCY
────────────────────
  pip install librosa
  (librosa is not in requirements.txt — add it before using this module)

INPUTS (one of the following combinations must be supplied)
────────────────────────────────────────────────────────────
  A) video_path                — extract audio and frames automatically
  B) frames_dir + audio_path  — pre-extracted face crops + WAV file
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn

from scripts.wav2lip_config import (
    WAV2LIP_FACE_SIZE,
    WAV2LIP_FMAX,
    WAV2LIP_FMIN,
    WAV2LIP_FPS,
    WAV2LIP_HOP_LENGTH,
    WAV2LIP_MAX_ABS_VALUE,
    WAV2LIP_MEL_STEP_SIZE,
    WAV2LIP_MIN_LEVEL_DB,
    WAV2LIP_NUM_MELS,
    WAV2LIP_REF_LEVEL_DB,
    WAV2LIP_SAMPLE_RATE,
    WAV2LIP_WEIGHTS,
    WAV2LIP_WIN_LENGTH,
    SYNC_BATCH_SIZE   as _BATCH_SIZE,
    SYNC_MAE_THRESHOLD,
    SYNC_SIGMOID_SLOPE,
    SYNC_MAX_FRAMES,
)

# ── Device / model singletons ─────────────────────────────────────────────────
_DEVICE: torch.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_MODEL:  Optional[nn.Module] = None
_READY:  bool = False
_ERROR:  Optional[str] = None

# ── YuNet face-detector singleton (separate from opencv_pipeline's singleton) ─
_YUNET_PATH = Path(__file__).resolve().parents[1] / "face_detection_yunet_2023mar.onnx"
_w2l_detector      = None
_w2l_detector_size = None


# ─────────────────────────────────────────────────────────────────────────────
# Wav2Lip model architecture
# Self-contained — no dependency on the Wav2Lip source repo.
# Architecture mirrors wav2lip.py from github.com/Rudrabha/Wav2Lip exactly so
# that pretrained weights load without key remapping.
# ─────────────────────────────────────────────────────────────────────────────

class _Conv2d(nn.Module):
    def __init__(self, cin: int, cout: int, kernel_size, stride, padding,
                 residual: bool = False):
        super().__init__()
        self.conv_block = nn.Sequential(
            nn.Conv2d(cin, cout, kernel_size, stride=stride, padding=padding),
            nn.BatchNorm2d(cout),
        )
        self.act      = nn.ReLU()
        self.residual = residual

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.conv_block(x)
        if self.residual:
            out = out + x
        return self.act(out)


class _Conv2dTranspose(nn.Module):
    def __init__(self, cin: int, cout: int, kernel_size, stride, padding,
                 output_padding: int = 0):
        super().__init__()
        self.conv_block = nn.Sequential(
            nn.ConvTranspose2d(cin, cout, kernel_size, stride=stride,
                               padding=padding, output_padding=output_padding),
            nn.BatchNorm2d(cout),
        )
        self.act = nn.ReLU()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.act(self.conv_block(x))


class _Wav2LipModel(nn.Module):
    """
    Wav2Lip generator.

    Inputs
    ------
    audio_sequences : (B, 1, 80, mel_step_size)   normalised mel spectrogram window
    face_sequences  : (B, 6, H, W)                 channels 0-2: masked face (lower
                                                    half zeroed), 3-5: reference face

    Output
    ------
    (B, 3, H, W)  reconstructed lower face in [0, 1]
    """

    def __init__(self) -> None:
        super().__init__()

        self.face_encoder_blocks = nn.ModuleList([
            nn.Sequential(_Conv2d(6,   16,  7, 1, 3)),                          # 96×96
            nn.Sequential(_Conv2d(16,  32,  3, 2, 1),                           # 48×48
                          _Conv2d(32,  32,  3, 1, 1, residual=True),
                          _Conv2d(32,  32,  3, 1, 1, residual=True)),
            nn.Sequential(_Conv2d(32,  64,  3, 2, 1),                           # 24×24
                          _Conv2d(64,  64,  3, 1, 1, residual=True),
                          _Conv2d(64,  64,  3, 1, 1, residual=True)),
            nn.Sequential(_Conv2d(64,  128, 3, 2, 1),                           # 12×12
                          _Conv2d(128, 128, 3, 1, 1, residual=True),
                          _Conv2d(128, 128, 3, 1, 1, residual=True)),
            nn.Sequential(_Conv2d(128, 256, 3, 2, 1),                           #  6×6
                          _Conv2d(256, 256, 3, 1, 1, residual=True),
                          _Conv2d(256, 256, 3, 1, 1, residual=True)),
            nn.Sequential(_Conv2d(256, 512, 3, 2, 1),                           #  3×3
                          _Conv2d(512, 512, 3, 1, 1, residual=True)),
            nn.Sequential(_Conv2d(512, 512, 3, 1, 0),                           #  1×1
                          _Conv2d(512, 512, 1, 1, 0)),
        ])

        self.audio_encoder = nn.Sequential(
            _Conv2d(1,   32,  3, 1,      1),
            _Conv2d(32,  32,  3, 1,      1, residual=True),
            _Conv2d(32,  64,  3, (3, 1), 1),
            _Conv2d(64,  64,  3, 1,      1, residual=True),
            _Conv2d(64,  128, 3, 3,      1),
            _Conv2d(128, 128, 3, 1,      1, residual=True),
            _Conv2d(128, 256, 3, (3, 2), 1),
            _Conv2d(256, 256, 3, 1,      1, residual=True),
            _Conv2d(256, 512, 3, 1,      0),
            _Conv2d(512, 512, 1, 1,      0),
        )

        self.face_decoder_blocks = nn.ModuleList([
            nn.Sequential(_Conv2dTranspose(512,  512, 1, 1, 0)),
            nn.Sequential(_Conv2dTranspose(1024, 512, 3, 1, 0),
                          _Conv2d(512, 512, 3, 1, 1, residual=True)),
            nn.Sequential(_Conv2dTranspose(1024, 256, 3, 2, 1, output_padding=1),
                          _Conv2d(256, 256, 3, 1, 1, residual=True)),
            nn.Sequential(_Conv2dTranspose(512,  128, 3, 2, 1, output_padding=1),
                          _Conv2d(128, 128, 3, 1, 1, residual=True)),
            nn.Sequential(_Conv2dTranspose(256,   64, 3, 2, 1, output_padding=1),
                          _Conv2d(64,  64,  3, 1, 1, residual=True)),
            nn.Sequential(_Conv2dTranspose(128,   32, 3, 2, 1, output_padding=1),
                          _Conv2d(32,  32,  3, 1, 1, residual=True)),
            nn.Sequential(_Conv2dTranspose(64,    16, 3, 2, 1, output_padding=1),
                          _Conv2d(16,  16,  3, 1, 1, residual=True)),
        ])

        self.output_block = nn.Sequential(
            _Conv2d(32, 16, 3, 1, 1),
            nn.Conv2d(16, 3, 1, 1, 0),
            nn.Sigmoid(),
        )

    def forward(self, audio_sequences: torch.Tensor,
                face_sequences: torch.Tensor) -> torch.Tensor:
        audio_emb = self.audio_encoder(audio_sequences)   # (B, 512, 1, 1)

        feats: List[torch.Tensor] = []
        x = face_sequences
        for block in self.face_encoder_blocks:
            x = block(x)
            feats.append(x)

        x = audio_emb
        for block in self.face_decoder_blocks:
            x = block(x)
            x = torch.cat((x, feats.pop()), dim=1)

        return self.output_block(x)   # (B, 3, 96, 96)


# ─────────────────────────────────────────────────────────────────────────────
# Model loading
# ─────────────────────────────────────────────────────────────────────────────

def init(weights_path: str = WAV2LIP_WEIGHTS) -> None:
    """Load (or reload) the Wav2Lip model.  Called automatically on first use."""
    global _MODEL, _READY, _ERROR

    _ERROR = None
    weights = Path(weights_path)
    if not weights.is_absolute():
        weights = Path(__file__).resolve().parents[1] / weights_path

    if not weights.exists():
        _ERROR = f"checkpoint_not_found:{weights_path}"
        _READY = False
        print(f"[Wav2Lip] {_ERROR}")
        return

    try:
        model = _Wav2LipModel().to(_DEVICE)
        ckpt  = torch.load(str(weights), map_location=_DEVICE)

        # Handle various checkpoint formats
        state = ckpt.get("state_dict") or ckpt.get("gen") or ckpt
        # Strip DataParallel 'module.' prefix if present
        state = {k.replace("module.", ""): v for k, v in state.items()}

        model.load_state_dict(state, strict=True)
        model.eval()
        _MODEL = model
        _READY = True
        print(f"[Wav2Lip] Ready on {_DEVICE}. Weights: {weights_path}")
    except Exception as exc:
        _ERROR = f"wav2lip_init_failed:{exc}"
        _READY = False
        _MODEL = None
        print(f"[Wav2Lip] Init failed: {exc}")
        traceback.print_exc()


# ─────────────────────────────────────────────────────────────────────────────
# Audio preprocessing  (matches Wav2Lip hparams.py / audio.py exactly)
# ─────────────────────────────────────────────────────────────────────────────

def _preemphasis(wav: np.ndarray, coef: float = 0.97) -> np.ndarray:
    return np.concatenate([[wav[0]], wav[1:] - coef * wav[:-1]])


def _compute_mel(wav: np.ndarray) -> np.ndarray:
    """
    Compute the normalised mel spectrogram expected by Wav2Lip.
    Returns float32 array of shape (80, T).

    Requires librosa — install with:  pip install librosa
    """
    try:
        import librosa
    except ImportError:
        raise RuntimeError(
            "librosa is required for audio analysis. "
            "Install with:  pip install librosa"
        )

    wav = _preemphasis(wav.astype(np.float32))

    D  = librosa.stft(wav, n_fft=WAV2LIP_WIN_LENGTH,
                      hop_length=WAV2LIP_HOP_LENGTH,
                      win_length=WAV2LIP_WIN_LENGTH)
    mel_basis = librosa.filters.mel(sr=WAV2LIP_SAMPLE_RATE,
                                    n_fft=WAV2LIP_WIN_LENGTH,
                                    n_mels=WAV2LIP_NUM_MELS,
                                    fmin=WAV2LIP_FMIN, fmax=WAV2LIP_FMAX)
    S = 20.0 * np.log10(np.maximum(1e-5, np.dot(mel_basis, np.abs(D))))
    S = S - WAV2LIP_REF_LEVEL_DB

    # Symmetric normalisation to [-max_abs, +max_abs]
    S_norm = (S - WAV2LIP_MIN_LEVEL_DB) / (-WAV2LIP_MIN_LEVEL_DB)
    S_norm = np.clip(2.0 * WAV2LIP_MAX_ABS_VALUE * S_norm - WAV2LIP_MAX_ABS_VALUE,
                     -WAV2LIP_MAX_ABS_VALUE, WAV2LIP_MAX_ABS_VALUE)
    return S_norm.astype(np.float32)


# ─────────────────────────────────────────────────────────────────────────────
# Video / face helpers
# ─────────────────────────────────────────────────────────────────────────────

def _load_audio_from_video(video_path: str) -> Optional[np.ndarray]:
    """Extract the audio track from a video file using ffmpeg → float32 at 16 kHz."""
    try:
        import librosa
    except ImportError:
        raise RuntimeError("librosa required — pip install librosa")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = f.name
    try:
        cmd = ["ffmpeg", "-y", "-i", video_path,
               "-vn", "-acodec", "pcm_s16le",
               "-ar", str(WAV2LIP_SAMPLE_RATE), "-ac", "1", tmp]
        res = subprocess.run(cmd, capture_output=True, timeout=120)
        if res.returncode != 0:
            return None
        wav, _ = librosa.load(tmp, sr=WAV2LIP_SAMPLE_RATE)
        return wav
    except Exception:
        return None
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _load_audio_file(audio_path: str) -> Optional[np.ndarray]:
    """Load a WAV/MP3/etc. file into a float32 array at 16 kHz."""
    try:
        import librosa
        wav, _ = librosa.load(audio_path, sr=WAV2LIP_SAMPLE_RATE)
        return wav
    except Exception:
        return None


def _extract_video_frames(video_path: str,
                           max_frames: int = SYNC_MAX_FRAMES) -> List[np.ndarray]:
    """Extract up to max_frames uniformly sampled frames from a video (BGR arrays)."""
    cap   = cv2.VideoCapture(video_path)
    src_fps   = cap.get(cv2.CAP_PROP_FPS) or WAV2LIP_FPS
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    step  = max(1, int(src_fps / WAV2LIP_FPS))  # resample to WAV2LIP_FPS

    frames: List[np.ndarray] = []
    idx = 0
    while cap.isOpened() and len(frames) < max_frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
        idx += step
    cap.release()
    return frames


def _yunet_detect(img: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """Detect the largest face using YuNet. Returns (x, y, w, h) or None."""
    global _w2l_detector, _w2l_detector_size
    if not _YUNET_PATH.exists():
        return None
    h, w = img.shape[:2]
    try:
        if _w2l_detector is None:
            _w2l_detector = cv2.FaceDetectorYN.create(
                str(_YUNET_PATH), "", (w, h), score_threshold=0.45,
                nms_threshold=0.3, top_k=5000)
            _w2l_detector_size = (w, h)
        elif _w2l_detector_size != (w, h):
            _w2l_detector.setInputSize((w, h))
            _w2l_detector_size = (w, h)
        _, faces = _w2l_detector.detect(img)
    except Exception:
        return None
    if faces is None or len(faces) == 0:
        return None
    best = max(faces, key=lambda f: f[2] * f[3])
    return tuple(map(int, best[:4]))   # x, y, w, h


def _crop_for_wav2lip(img: np.ndarray,
                       bbox: Tuple[int, int, int, int],
                       size: int = WAV2LIP_FACE_SIZE) -> Optional[np.ndarray]:
    """
    Crop and resize the face to size×size.
    Returns BGR float32 in [0, 1]  (matches Wav2Lip training input format).
    """
    x, y, w, h = bbox
    margin = int(max(w, h) * 0.25)
    ih, iw = img.shape[:2]
    x1 = max(0, x - margin);  y1 = max(0, y - margin)
    x2 = min(iw, x + w + margin); y2 = min(ih, y + h + margin)
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    return cv2.resize(crop, (size, size)).astype(np.float32) / 255.0


# ─────────────────────────────────────────────────────────────────────────────
# Core scoring
# ─────────────────────────────────────────────────────────────────────────────

def _mae_to_sync_score(mae: float) -> float:
    """
    Convert mean-absolute-error (lower face reconstruction) → sync_score in [0, 1].

    Sigmoid centred at SYNC_MAE_THRESHOLD:
      mae ≈ 0.05  → score ≈ 0.88   (very well synced)
      mae ≈ 0.10  → score ≈ 0.69
      mae = 0.15  → score = 0.50   (decision boundary)
      mae ≈ 0.20  → score ≈ 0.31
      mae ≈ 0.25  → score ≈ 0.15   (clearly out-of-sync)
    """
    return float(1.0 / (1.0 + np.exp(SYNC_SIGMOID_SLOPE * (mae - SYNC_MAE_THRESHOLD))))


@torch.no_grad()
def _run_inference(
    model:         nn.Module,
    face_crops:    List[np.ndarray],   # each (H, W, 3) BGR float32 [0,1]
    frame_indices: List[int],          # original frame number for mel alignment
    mel:           np.ndarray,         # (80, T) normalised mel
    fps:           float = WAV2LIP_FPS,
    batch_size:    int  = _BATCH_SIZE,
) -> List[float]:
    """
    Run Wav2Lip forward pass on batches; return per-frame sync scores.
    """
    mel_idx_mul   = 80.0 / fps           # mel frames per video frame
    half_h        = WAV2LIP_FACE_SIZE // 2
    per_frame_scores: List[float] = []

    for b_start in range(0, len(face_crops), batch_size):
        face_batch  = face_crops[b_start: b_start + batch_size]
        idx_batch   = frame_indices[b_start: b_start + batch_size]
        f_tensors:  List[np.ndarray] = []
        m_tensors:  List[np.ndarray] = []
        actuals:    List[np.ndarray] = []

        for face, orig_idx in zip(face_batch, idx_batch):
            mel_start = int(orig_idx * mel_idx_mul)
            mel_end   = mel_start + WAV2LIP_MEL_STEP_SIZE
            if mel_end > mel.shape[1]:
                break   # ran out of audio coverage

            mel_win = mel[:, mel_start:mel_end]          # (80, 16)

            # Mask lower half → zero out rows [half_h:]
            masked = face.copy()
            masked[half_h:, :, :] = 0.0

            # 6-channel: [masked | original], shape (H, W, 6) → (6, H, W)
            six_ch = np.concatenate([masked, face], axis=2).transpose(2, 0, 1)

            f_tensors.append(six_ch)
            m_tensors.append(mel_win[np.newaxis, :, :])   # (1, 80, 16)
            actuals.append(face)

        if not f_tensors:
            continue

        face_t = torch.from_numpy(np.stack(f_tensors)).float().to(_DEVICE)  # (B,6,H,W)
        mel_t  = torch.from_numpy(np.stack(m_tensors)).float().to(_DEVICE)  # (B,1,80,16)

        generated = model(mel_t, face_t).cpu().numpy()   # (B, 3, H, W)

        for b, actual in enumerate(actuals):
            # Compare only the lower half (mouth region)
            actual_lower = actual[half_h:, :, :].transpose(2, 0, 1)   # (3, H//2, W)
            gen_lower    = generated[b, :, half_h:, :]                 # (3, H//2, W)
            mae = float(np.mean(np.abs(gen_lower - actual_lower)))
            per_frame_scores.append(_mae_to_sync_score(mae))

    return per_frame_scores


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def wav2lip_sync_score(
    video_path:   Optional[str] = None,
    audio_path:   Optional[str] = None,
    frames_dir:   Optional[str] = None,
    weights_path: str = WAV2LIP_WEIGHTS,
    max_frames:   int = SYNC_MAX_FRAMES,
) -> Dict[str, Any]:
    """
    Compute audio-visual lip-sync score using the Wav2Lip GAN model.

    Parameters
    ----------
    video_path   : path to video file (audio + frames extracted automatically)
    audio_path   : path to WAV file   (used together with frames_dir)
    frames_dir   : directory of face_*.jpg crops (from opencv_pipeline)
    weights_path : path to wav2lip_gan.pth
    max_frames   : cap on frames processed (controls speed)

    Returns
    -------
    {
      "ok"           : bool
      "sync_score"   : float | None    0 = out-of-sync  /  1 = perfectly synced
      "confidence"   : "high" | "medium" | "low"
      "frames_used"  : int
      "score_std"    : float            temporal consistency (lower = more stable)
      "per_frame"    : list[float]      per-frame sync scores
      "interpretation": "synced" | "uncertain" | "out_of_sync"
      "error"        : str | None
    }
    """
    global _MODEL, _READY, _ERROR

    # ── Lazy model load ───────────────────────────────────────────────────────
    if not _READY:
        init(weights_path)
    if not _READY or _MODEL is None:
        return _error_payload(_ERROR or "wav2lip_not_ready")

    # ── Gather frames and audio ───────────────────────────────────────────────
    raw_frames: List[np.ndarray] = []
    wav:        Optional[np.ndarray] = None
    fps:        float = float(WAV2LIP_FPS)

    if video_path:
        if not Path(video_path).exists():
            return _error_payload(f"video_not_found:{video_path}")
        wav        = _load_audio_from_video(video_path)
        raw_frames = _extract_video_frames(video_path, max_frames)
        # Determine actual FPS for correct mel alignment
        cap  = cv2.VideoCapture(video_path)
        fps  = cap.get(cv2.CAP_PROP_FPS) or WAV2LIP_FPS
        # Clamp: we sampled at WAV2LIP_FPS, use that for alignment
        fps  = WAV2LIP_FPS
        cap.release()

    elif frames_dir and audio_path:
        wav = _load_audio_file(audio_path)
        if wav is None:
            return _error_payload(f"audio_load_failed:{audio_path}")
        # Load face crops from the sequence directory (already cropped by opencv_pipeline)
        crops_sorted = sorted(Path(frames_dir).glob("face_*.jpg"))[:max_frames]
        for p in crops_sorted:
            img = cv2.imread(str(p))
            if img is not None:
                raw_frames.append(img)

    else:
        return _error_payload(
            "no_input:supply video_path OR (frames_dir + audio_path)"
        )

    if wav is None or len(wav) < WAV2LIP_SAMPLE_RATE // 2:
        return _error_payload("no_audio_available")

    if len(raw_frames) < 5:
        return _error_payload(f"insufficient_frames:{len(raw_frames)}")

    # ── Compute mel spectrogram ───────────────────────────────────────────────
    try:
        mel = _compute_mel(wav)   # (80, T_mel)
    except RuntimeError as exc:
        return _error_payload(str(exc))
    except Exception as exc:
        return _error_payload(f"mel_failed:{exc}")

    # ── Extract / validate face crops ─────────────────────────────────────────
    # If frames came from frames_dir they are already face crops → resize only.
    # If frames came from a video we need to run face detection first.
    face_crops:    List[np.ndarray] = []
    frame_indices: List[int]        = []

    if frames_dir:
        # Already face crops — just resize to 96×96
        for i, frame in enumerate(raw_frames):
            resized = cv2.resize(frame, (WAV2LIP_FACE_SIZE, WAV2LIP_FACE_SIZE))
            face_crops.append(resized.astype(np.float32) / 255.0)
            frame_indices.append(i)
    else:
        # Full video frames — detect faces
        for i, frame in enumerate(raw_frames):
            bbox = _yunet_detect(frame)
            if bbox is None:
                continue
            crop = _crop_for_wav2lip(frame, bbox)
            if crop is None:
                continue
            face_crops.append(crop)
            frame_indices.append(i)

    if len(face_crops) < 5:
        return _error_payload(f"insufficient_faces_detected:{len(face_crops)}")

    # ── Run reconstruction-based sync scoring ─────────────────────────────────
    try:
        per_frame = _run_inference(
            _MODEL, face_crops, frame_indices, mel, fps=fps,
            batch_size=_BATCH_SIZE,
        )
    except Exception as exc:
        traceback.print_exc()
        return _error_payload(f"inference_failed:{exc}")

    if not per_frame:
        return _error_payload("no_valid_windows:audio_too_short_for_frame_count")

    sync_score = float(np.mean(per_frame))
    score_std  = float(np.std(per_frame)) if len(per_frame) > 1 else 0.0

    confidence = (
        "high"   if len(per_frame) >= 20 else
        "medium" if len(per_frame) >= 8  else
        "low"
    )
    interpretation = (
        "synced"      if sync_score > 0.65 else
        "uncertain"   if sync_score > 0.38 else
        "out_of_sync"
    )

    return {
        "ok":             True,
        "sync_score":     sync_score,
        "confidence":     confidence,
        "frames_used":    len(per_frame),
        "score_std":      score_std,
        "per_frame":      per_frame,
        "interpretation": interpretation,
        "error":          None,
        "model_name":     "Wav2Lip-GAN",
        "loaded_from":    weights_path,
        "calibration": {
            "mae_threshold": SYNC_MAE_THRESHOLD,
            "sigmoid_slope": SYNC_SIGMOID_SLOPE,
            "note": (
                "sync_score = sigmoid-transformed reconstruction MAE "
                "on the lower face (mouth region). "
                "High score = lips matched audio; low score = mismatch."
            ),
        },
    }


def _error_payload(error: str) -> Dict[str, Any]:
    return {
        "ok":             False,
        "sync_score":     None,
        "confidence":     "low",
        "frames_used":    0,
        "score_std":      None,
        "per_frame":      [],
        "interpretation": "unavailable",
        "error":          error,
        "model_name":     "Wav2Lip-GAN",
    }
