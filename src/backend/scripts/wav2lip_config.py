"""wav2lip_config.py

Configuration constants for the Wav2Lip audio-visual sync scoring service.
All values must match the Wav2Lip training hyper-parameters exactly — do not
change them unless you are using a differently-trained checkpoint.
"""

from pathlib import Path

# ── Checkpoint ────────────────────────────────────────────────────────────────
WAV2LIP_WEIGHTS = "checkpoints/wav2lip_gan.pth"

# ── Model input ───────────────────────────────────────────────────────────────
WAV2LIP_FACE_SIZE     = 96   # px — Wav2Lip expects 96×96 BGR face crops
WAV2LIP_MEL_STEP_SIZE = 16   # mel columns per inference window

# ── Video / audio — must match Wav2Lip training ───────────────────────────────
WAV2LIP_FPS         = 25
WAV2LIP_SAMPLE_RATE = 16_000   # Hz
WAV2LIP_HOP_LENGTH  = 200      # samples per mel frame
WAV2LIP_WIN_LENGTH  = 800      # STFT window size
WAV2LIP_NUM_MELS    = 80
WAV2LIP_FMIN        = 55
WAV2LIP_FMAX        = 7_600

# ── Mel normalisation (from Wav2Lip hparams.py) ───────────────────────────────
WAV2LIP_MIN_LEVEL_DB  = -100.0
WAV2LIP_REF_LEVEL_DB  =   20.0
WAV2LIP_MAX_ABS_VALUE =    4.0   # output range: [-4, +4]

# ── Sync score calibration ────────────────────────────────────────────────────
# Sigmoid centred at SYNC_MAE_THRESHOLD with SYNC_SIGMOID_SLOPE steepness.
# In-sync MAE ≈ 0.05–0.13 → score 0.70–0.92
# Out-of-sync MAE ≈ 0.18–0.30 → score 0.08–0.35
SYNC_MAE_THRESHOLD   = 0.15   # MAE value that maps to sync_score = 0.50
SYNC_SIGMOID_SLOPE   = 12.0   # controls transition sharpness

# ── Thresholds for verdict classification ─────────────────────────────────────
SYNC_THRESHOLD_REAL        = 0.65   # above this → audio-visual sync present
SYNC_THRESHOLD_SUSPICIOUS  = 0.38   # below this → audio-visual desync detected

# ── Processing limits ─────────────────────────────────────────────────────────
SYNC_MAX_FRAMES    = 200   # maximum frames to analyse (speed vs accuracy)
SYNC_BATCH_SIZE    =  16   # GPU/CPU batch size for Wav2Lip inference
