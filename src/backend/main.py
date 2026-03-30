import os
import math
import secrets
import hashlib
import hmac
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile, File, Form, Header
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import or_
from sqlalchemy.orm import Session
from dotenv import load_dotenv
from starlette.middleware.sessions import SessionMiddleware
from jose import jwt, JWTError

from db import SessionLocal, engine, Base
from models import User, OAuthAccount, PasswordReset, MfaChallenge, EmailVerification, TrustedDevice, MediaAnalysis, ModelRun, ExtensionLinkRequest, LinkedExtension, GlobalBlocklist
from schemas import RegisterIn, LoginIn, UserOut, ForgotPasswordIn, ResetPasswordIn, MfaVerifyIn, VerifyEmailOtpIn, ExtensionLinkRequestIn, ExtensionLinkApproveIn, ExtensionLinkRedeemIn
from auth import hash_password, verify_password, create_token, create_extension_token
from oauth_routes import router as oauth_router
from password_reset import make_reset_token, hash_token, expires_at_dt
from email_utils import send_reset_email, send_mfa_code, send_email_verification_code
from typing import List, Optional
from base64 import urlsafe_b64encode

from opencv_pipeline import process_frames_for_sequence
import os as _os
# Force UTF-8 output so AltFreezing's logger doesn't crash on Windows
_os.environ.setdefault("PYTHONUTF8", "1")
from scripts import altfreezing_service
from scripts.altfreezing_config import SEQUENCE_LENGTH as ALT_ANALYSIS_SEQUENCE_LENGTH
from scripts import wav2lip_service
from scripts import vit_service
from scripts import xception_service

# Create tables (dev). For production, use Alembic migrations.
Base.metadata.create_all(bind=engine)
load_dotenv()
app = FastAPI()

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login", auto_error=False)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def _decode_access_token(token: str) -> dict:
    from auth import SECRET_KEY, ALGORITHM
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str = payload.get("sub")
        if user_id_str is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        payload["sub"] = int(user_id_str)
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


def _hash_extension_token(raw_token: str) -> str:
    return _sha256_hex(f"extension:{raw_token}:{JWT_SECRET}")


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = _decode_access_token(token)
    user_id = payload["sub"]

    if payload.get("type") == "extension":
        linked_extension_id = payload.get("linked_extension_id")
        if not linked_extension_id:
            raise HTTPException(status_code=401, detail="Invalid extension token")

        linked_extension = (
            db.query(LinkedExtension)
            .filter(
                LinkedExtension.id == int(linked_extension_id),
                LinkedExtension.user_id == user_id,
                LinkedExtension.is_active == True,
                LinkedExtension.revoked_at.is_(None),
                LinkedExtension.token_hash == _hash_extension_token(token),
            )
            .first()
        )
        if not linked_extension:
            raise HTTPException(status_code=401, detail="Extension token revoked or invalid")
        linked_extension.last_seen_at = _utcnow()
        db.commit()

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def get_portal_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = _decode_access_token(token)
    if payload.get("type") == "extension":
        raise HTTPException(status_code=403, detail="Portal session required")

    user = db.query(User).filter(User.id == payload["sub"]).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def get_optional_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    if not token:
        return None
    try:
        payload = _decode_access_token(token)
        return db.query(User).filter(User.id == payload["sub"]).first()
    except Exception:
        return None

# NOTE: altfreezing_service is lazy-loaded on first capture request.
# Do NOT call altfreezing_service.init() here — it imports slowfast/torch3D
# which takes 10-30s and would block uvicorn startup.

TERMS_VERSION = "v1"
PRIVACY_VERSION = "v1"

# ----- Settings -----
EMAIL_VERIFY_TTL_MIN = int(os.getenv("EMAIL_VERIFY_TTL_MIN", "10"))
MFA_CODE_TTL_MIN = int(os.getenv("MFA_CODE_TTL_MIN", "5"))
MFA_MAX_ATTEMPTS = int(os.getenv("MFA_MAX_ATTEMPTS", "5"))
TRUST_DEVICE_DAYS = int(os.getenv("TRUST_DEVICE_DAYS", "30"))

JWT_SECRET = os.getenv("JWT_SECRET_KEY", "1234567890abcdef")
EXTENSION_LINK_TTL_MIN = int(os.getenv("EXTENSION_LINK_TTL_MIN", "5"))
EXTENSION_TOKEN_EXPIRE_DAYS = int(os.getenv("EXTENSION_TOKEN_EXPIRE_DAYS", "30"))

# ----- Helpers -----
def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def _hash_device_id(device_id: str) -> str:
    # Stable hash (never store raw device_id)
    return _sha256_hex(device_id + JWT_SECRET)

def _hash_mfa_token(raw_token: str) -> str:
    return _sha256_hex(raw_token + JWT_SECRET)

def _hash_otp(raw_token: str, otp_code: str) -> str:
    # Use token as per-challenge salt
    key = (JWT_SECRET + raw_token).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", otp_code.encode("utf-8"), key, 100_000).hex()

def _hash_email_otp(email: str, otp_code: str) -> str:
    # Tie OTP to email to avoid cross-user reuse
    return _sha256_hex(email.strip().lower() + ":" + otp_code + ":" + JWT_SECRET)

def _new_otp_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"

def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _pkce_challenge_for_verifier(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode("utf-8")).digest()
    return urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


def _human_join(parts: List[str]) -> str:
    clean = [str(part).strip() for part in parts if str(part).strip()]
    if not clean:
        return ""
    if len(clean) == 1:
        return clean[0]
    if len(clean) == 2:
        return f"{clean[0]} and {clean[1]}"
    return f"{', '.join(clean[:-1])}, and {clean[-1]}"


def _metadata_quality_band(metadata: dict) -> str:
    band = str(metadata.get("quality_band") or "").strip().lower()
    if band in {"weak", "moderate", "strong"}:
        return band

    usable_frames = int(metadata.get("usable_frames") or 0)
    usable_ratio = float(metadata.get("usable_ratio") or 0.0)
    blur = float(metadata.get("blur") or 0.0)
    brightness = float(metadata.get("brightness") or 0.0)
    stability = metadata.get("stability")

    if usable_frames >= 24 and usable_ratio >= 0.65 and blur >= 20.0 and brightness >= 80.0 and stability is True:
        return "strong"
    if usable_frames >= 8 and usable_ratio >= 0.2 and blur >= 8.0 and brightness >= 25.0:
        return "moderate"
    return "weak"


def _safe_float(value) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _describe_quality_failure(code: str) -> str:
    key, _, raw_value = str(code or "").partition(":")
    if key == "too_few_sequence_frames":
        return f"only {raw_value or 'a few'} usable frames"
    if key == "usable_ratio_too_low":
        return "too little variation in usable frames"
    if key == "avg_blur_too_low":
        return "blurred visual evidence"
    if key == "avg_brightness_too_low":
        return "dark or poorly lit frames"
    return key.replace("_", " ")


def _evidence_strength_label(metadata: dict) -> str:
    total_windows = int(metadata.get("total_windows") or 0)
    score_std = _safe_float(metadata.get("score_std"))
    temporal_diversity = _safe_float(metadata.get("temporal_diversity"))
    high_frame_count = int(metadata.get("high_frame_count") or 0)
    quality_band = _metadata_quality_band(metadata)
    evidence_quality = _safe_float(metadata.get("evidence_quality"))

    weak_markers = 0
    strong_markers = 0

    if total_windows < 3:
        weak_markers += 1
    else:
        strong_markers += 1

    if score_std is None or score_std < 0.01:
        weak_markers += 1
    elif score_std > 0.02:
        strong_markers += 1

    if temporal_diversity is None or temporal_diversity < 0.15:
        weak_markers += 1
    elif temporal_diversity > 0.20:
        strong_markers += 1

    if high_frame_count <= 1:
        weak_markers += 1
    elif high_frame_count >= 3:
        strong_markers += 1

    if quality_band == "weak":
        weak_markers += 1
    elif quality_band == "strong":
        strong_markers += 1

    if evidence_quality is not None:
        if evidence_quality < 0.60:
            weak_markers += 1
        elif evidence_quality >= 0.75:
            strong_markers += 1

    if weak_markers >= 2 and strong_markers <= 1:
        return "weak"
    if strong_markers >= 4 and weak_markers == 0:
        return "strong"
    return "moderate"


def generate_verdict_reason(metadata) -> str:
    metadata = metadata or {}

    verdict = str(metadata.get("verdict") or metadata.get("final_verdict") or "INCONCLUSIVE").upper()
    score = _safe_float(metadata.get("score"))
    raw_score = _safe_float(metadata.get("raw_score"))
    score_pct = round(score * 100) if score is not None else None
    raw_score_pct = round(raw_score * 100) if raw_score is not None else None
    confidence = str(metadata.get("confidence") or "low").strip().lower()
    quality_band = _metadata_quality_band(metadata)

    usable_frames = int(metadata.get("usable_frames") or 0)
    temporal_diversity = _safe_float(metadata.get("temporal_diversity"))
    duplicate_frames = int(metadata.get("duplicate_frames") or 0)
    stability = metadata.get("stability")
    drift = _safe_float(metadata.get("drift"))
    blur = _safe_float(metadata.get("blur"))
    brightness = _safe_float(metadata.get("brightness"))
    fail_reasons = list(metadata.get("fail_reasons") or [])
    high_frame_count = int(metadata.get("high_frame_count") or 0)
    evidence_quality = _safe_float(metadata.get("evidence_quality"))
    score_std = _safe_float(metadata.get("score_std"))
    total_windows = int(metadata.get("total_windows") or 0)
    temporal_penalty = _safe_float(metadata.get("temporal_penalty")) or 1.0
    evidence_strength = str(metadata.get("evidence_strength") or _evidence_strength_label(metadata)).lower()
    vit_score = _safe_float(metadata.get("vit_score"))
    wav2lip_score = _safe_float(metadata.get("wav2lip_score"))
    disagreement_flag = bool(metadata.get("disagreement_flag"))

    evidence_bits: List[str] = []
    if total_windows:
        evidence_bits.append(f"{total_windows} analysis window{'s' if total_windows != 1 else ''}")
    if temporal_diversity is not None:
        if temporal_diversity > 0.20:
            evidence_bits.append("good frame-to-frame variation")
        elif temporal_diversity < 0.15:
            evidence_bits.append("limited frame-to-frame variation")
        else:
            evidence_bits.append("moderate frame-to-frame variation")
    if score_std is not None:
        evidence_bits.append("meaningful score variation" if score_std > 0.02 else "very little score variation")
    if high_frame_count:
        evidence_bits.append(f"{high_frame_count} strong manipulation window{'s' if high_frame_count != 1 else ''}")
    if vit_score is not None:
        evidence_bits.append(f"ViT score {round(vit_score * 100)}%")
    if wav2lip_score is not None:
        evidence_bits.append(f"Wav2Lip risk {round(wav2lip_score * 100)}%")

    evidence_text = _human_join(evidence_bits[:3]) or "limited supporting evidence"
    fusion_bits: List[str] = []
    if vit_score is not None:
        fusion_bits.append(f"ViT {round(vit_score * 100)}%")
    if wav2lip_score is not None:
        fusion_bits.append(f"Wav2Lip risk {round(wav2lip_score * 100)}%")
    if disagreement_flag:
        fusion_bits.append("the visual models disagreed")
    fusion_text = _human_join(fusion_bits[:3])

    if verdict == "INCONCLUSIVE":
        issues: List[str] = []
        if fail_reasons:
            issues.extend(_describe_quality_failure(reason) for reason in fail_reasons[:2])
        if total_windows and total_windows < 3:
            issues.append(f"only {total_windows} analysis window{'s' if total_windows != 1 else ''} were available")
        if confidence == "low":
            issues.append("low confidence")
        if temporal_diversity is not None and temporal_diversity < 0.15:
            issues.append("limited variation between frames")
        if stability is False:
            issues.append("unstable face tracking")
        if duplicate_frames >= max(4, usable_frames // 2 if usable_frames else 4):
            issues.append("too many repeated frames")
        if quality_band == "weak":
            issues.append("weak visual evidence")

        issue_text = _human_join(issues[:3]) or "weak and mixed evidence"
        follow_up = []
        if usable_frames:
            follow_up.append(f"Only {usable_frames} usable frames were available")
        if raw_score_pct is not None and score_pct is not None and raw_score_pct != score_pct:
            follow_up.append(f"the score was reduced from {raw_score_pct}% to {score_pct}% because the clip had limited variation")
        if drift is not None and drift > 0.18:
            follow_up.append("face alignment changed noticeably across the clip")
        if blur is not None and blur < 8.0:
            follow_up.append("the sequence was blurrier than the system prefers")
        if brightness is not None and brightness < 25.0:
            follow_up.append("the frames were darker than ideal")

        second_sentence = _human_join(follow_up[:2])
        base = f"The final fake score was {score_pct if score_pct is not None else 'not available'}%, but the evidence was {evidence_strength} because of {issue_text}."
        if fusion_text:
            base += f" Supporting signals were {fusion_text}."
        if second_sentence:
            return f"{base} {second_sentence[0].upper() + second_sentence[1:]}, so the system kept the result inconclusive."
        return f"{base} The system kept the result inconclusive rather than making an absolute claim."

    if verdict == "FAKE":
        issues: List[str] = []
        if high_frame_count > 0:
            issues.append("repeated manipulation signals across frames")
        if stability is False or (drift is not None and drift > 0.18):
            issues.append("inconsistencies in facial movement and alignment")
        if temporal_diversity is not None and temporal_diversity > 0.20:
            issues.append("irregular frame-to-frame motion patterns")
        if evidence_quality is not None and evidence_quality >= 0.75:
            issues.append("strong supporting evidence")

        issue_text = _human_join(issues[:3]) or "strong inconsistencies across the analyzed sequence"
        return (
            f"The final fake score was {score_pct if score_pct is not None else 'not available'}%, and the evidence was strong with {evidence_text}. "
            f"The system classified this media as fake because it found {issue_text}"
            + (f", with {fusion_text} supporting the result." if fusion_text else ".")
        )

    if verdict == "REAL":
        supports: List[str] = []
        if stability is True:
            supports.append("consistent face tracking")
        if drift is not None and drift <= 0.10:
            supports.append("stable facial movement")
        if temporal_diversity is not None and temporal_diversity <= 0.20:
            supports.append("natural variation between frames")
        if confidence in {"medium", "high"}:
            supports.append(f"{confidence} confidence")
        if quality_band in {"moderate", "strong"}:
            supports.append(f"{quality_band} visual evidence")

        support_text = _human_join(supports[:3]) or "stable visual evidence"
        tail = []
        if score_pct is not None:
            tail.append(f"the manipulation score remained low at {score_pct}%")
        if usable_frames:
            tail.append(f"{usable_frames} usable frames supported the decision")

        tail_text = _human_join(tail[:2])
        base = f"The final fake score remained low at {score_pct if score_pct is not None else 'not available'}%, and the evidence was {evidence_strength} with {support_text}."
        if fusion_text:
            base += f" Supporting signals were {fusion_text}."
        if tail_text:
            return f"{base} {tail_text[0].upper() + tail_text[1:]}, so the system treated the content as authentic."
        return f"{base} The system treated the content as authentic."

    mixed_signals: List[str] = []
    if high_frame_count > 0 or (score is not None and score >= 0.5):
        mixed_signals.append("some frame-level irregularities")
    if disagreement_flag:
        mixed_signals.append("disagreement between the temporal and spatial checks")
    if stability is False or (drift is not None and drift > 0.12):
        mixed_signals.append("partial instability in facial tracking")
    if temporal_diversity is not None and temporal_diversity > 0.10:
        mixed_signals.append("uneven motion patterns across frames")
    if quality_band == "weak" or confidence == "low":
        mixed_signals.append("evidence that was not strong enough for a definitive decision")
    if score_std is not None and score_std < 0.01:
        mixed_signals.append("very little variation across prediction windows")

    signal_text = _human_join(mixed_signals[:3]) or "mixed signals"
    tail = []
    if score_pct is not None:
        tail.append(f"the score reached {score_pct}%")
    if usable_frames:
        tail.append(f"only {usable_frames} usable frames were retained" if quality_band == "weak" else f"{usable_frames} usable frames were reviewed")
    if temporal_penalty < 1.0 and raw_score_pct is not None and score_pct is not None:
        tail.append(f"the score was reduced from {raw_score_pct}% to {score_pct}% because frame variation was limited")

    tail_text = _human_join(tail[:2])
    base = f"The final fake score was {score_pct if score_pct is not None else 'not available'}%, but the evidence was {evidence_strength} because of {signal_text}."
    if fusion_text:
        base += f" Supporting signals were {fusion_text}."
    if tail_text:
        return f"{base} In this case, {tail_text}, so the system used a suspicious verdict instead of an absolute one."
    return f"{base} The system used a suspicious verdict instead of an absolute one."


def _clamp01(value) -> Optional[float]:
    safe = _safe_float(value)
    if safe is None:
        return None
    return max(0.0, min(1.0, safe))


def _wav2lip_fake_likelihood(wav2lip_result: dict) -> Optional[float]:
    if not isinstance(wav2lip_result, dict) or not wav2lip_result.get("ok"):
        return None
    if str(wav2lip_result.get("confidence") or "").lower() == "low":
        return None
    sync_score = _clamp01(wav2lip_result.get("sync_score"))
    if sync_score is None:
        return None
    return max(0.0, min(1.0, 1.0 - sync_score))


def _score_stance(score: Optional[float]) -> str:
    safe = _clamp01(score)
    if safe is None:
        return "unknown"
    if safe >= 0.75:
        return "fake"
    if safe <= 0.35:
        return "real"
    return "suspicious"


# ── Improvement 1: Temperature Scaling ───────────────────────────────────────
# Models output overconfident raw probabilities on browser JPEG captures.
# Temperature scaling shrinks scores toward 0.5 without changing model weights.
# T=1.0 is no change; T=2.0 roughly halves the logit distance from 0.5.
_ALT_TEMPERATURE      = 2.0   # AltFreezing — most overconfident on static JPEG
_XCEPTION_TEMPERATURE = 1.8   # Xception — moderately overconfident


def _calibrate_score(raw_prob: float, temperature: float) -> float:
    """Reduce overconfidence by dividing the logit by `temperature`."""
    p = max(1e-7, min(1.0 - 1e-7, float(raw_prob)))
    logit = math.log(p / (1.0 - p))
    return 1.0 / (1.0 + math.exp(-logit / temperature))


# ── Improvement 2: Context-Aware Dynamic Thresholds ──────────────────────────
def _get_verdict_thresholds(
    avg_blur: float,
    avg_iou: float,
    total_windows: int,
    temporal_diversity: Optional[float],
) -> tuple:
    """Return (fake_threshold, real_threshold) adjusted for video context."""
    fake_threshold = 0.75
    real_threshold = 0.43

    # Small face or unstable track — model predictions are unreliable
    if avg_blur < 30 or avg_iou < 0.50:
        fake_threshold = 0.90
        real_threshold = 0.50

    # Weak evidence — only 1–2 windows
    if total_windows <= 2:
        fake_threshold = max(fake_threshold, 0.88)
        real_threshold = max(real_threshold, 0.48)

    # High-motion video — natural movement increases model scores; raise bar for FAKE
    if temporal_diversity is not None and temporal_diversity > 0.12:
        fake_threshold = max(fake_threshold, 0.82)

    return fake_threshold, real_threshold


# ── Improvement 3: Video Type Classifier ─────────────────────────────────────
def _classify_video_context(
    avg_blur: float,
    avg_iou: float,
    size_consistency: float,
    avg_brightness: float,
    temporal_diversity: Optional[float],
) -> str:
    """Classify video type using already-computed quality signals (no ML needed)."""
    div = temporal_diversity or 0.0

    # Conference / stage: small blurry face, position jumps, inconsistent size
    if avg_blur < 40 and avg_iou < 0.60 and size_consistency < 0.75:
        return "conference"

    # Interview / talking head: sharp face, stable position, near-static
    if avg_blur > 40 and avg_iou > 0.80 and div < 0.06:
        return "interview"

    # Active speaker: good quality + natural motion
    if avg_blur > 100 and avg_iou > 0.60 and div >= 0.06:
        return "active_speaker"

    return "unknown"


# ── Improvement 4: Fake Vote Counter ─────────────────────────────────────────
def _count_fake_votes(signals: dict, threshold: float = 0.65) -> int:
    """Count models independently agreeing the content is likely fake."""
    votes = 0
    if signals.get("altfreezing") is not None and signals["altfreezing"] >= threshold:
        votes += 1
    if signals.get("xception") is not None and signals["xception"] >= threshold:
        votes += 1
    if signals.get("vit") is not None and signals["vit"] >= threshold:
        votes += 1
    if signals.get("wav2lip") is not None and signals["wav2lip"] >= 0.60:
        votes += 1
    return votes


# ── Improvement 5: Xception Quality Normalisation ────────────────────────────
def _normalise_xception_by_quality(xc_score: float, avg_blur: float) -> float:
    """Blend Xception score toward 0.5 when face sharpness is too low to be reliable."""
    if avg_blur >= 100:
        return xc_score
    trust = min(1.0, max(0.0, (avg_blur - 10.0) / 90.0))
    return 0.5 + (xc_score - 0.5) * trust


# ── Improvement 6: Confidence-Based Verdict Downgrade ────────────────────────
def _apply_uncertainty_cascade(
    verdict: str,
    total_windows: int,
    avg_blur: float,
    wav2lip_available: bool,
    avg_iou: float,
    seq_frames: int,
) -> tuple:
    """Downgrade verdict one level when >= 2 weak-evidence flags co-occur."""
    flags = []
    if total_windows <= 1:
        flags.append("single_window")
    if avg_blur < 30:
        flags.append("small_face")
    if not wav2lip_available:
        flags.append("no_audio_check")
    if avg_iou < 0.55:
        flags.append("mobile_subject")
    if seq_frames < 20:
        flags.append("few_frames")

    if len(flags) >= 2 and verdict == "FAKE":
        return "SUSPICIOUS", f"uncertainty_cascade:{','.join(flags)}"
    if len(flags) >= 3 and verdict == "SUSPICIOUS":
        return "INCONCLUSIVE", f"high_uncertainty:{','.join(flags)}"

    return verdict, "no_cascade"


# ── Improvement 7: Cross-Frame Consistency Check ─────────────────────────────
def _xception_consistency_check(per_frame: list) -> dict:
    """Determine whether Xception's per-frame scores are consistent or confused."""
    probs = [
        float(f["fake_prob"])
        for f in (per_frame or [])
        if isinstance(f, dict) and "fake_prob" in f
    ]
    if not probs:
        return {"mean": None, "std": None, "high_frame_count": 0, "consistent": False, "confused": False}

    mean = sum(probs) / len(probs)
    std  = (sum((p - mean) ** 2 for p in probs) / len(probs)) ** 0.5
    high_count = sum(1 for p in probs if p >= 0.65)

    return {
        "mean": mean,
        "std": std,
        "high_frame_count": high_count,
        # consistent = model strongly agrees across most frames
        "consistent": std < 0.10 and high_count >= max(1, len(probs) * 3 // 4),
        # confused = model swings wildly (half fake / half real across frames)
        "confused": std > 0.20,
    }


def fuse_decision(
    altfreezing_score,
    altfreezing_std,
    temporal_diversity,
    wav2lip_sync,
    vit_fake_score,
    xception_fake_score=None,
    vit_score_std=None,
    fake_threshold: float = 0.75,
    real_threshold: float = 0.43,
    xception_confused: bool = False,
):
    alt_score = _clamp01(altfreezing_score)
    vit_score = _clamp01(vit_fake_score)
    xception_score = _clamp01(xception_fake_score)
    alt_std = _safe_float(altfreezing_std)
    vit_std = _safe_float(vit_score_std)

    # Base weights: AltFreezing is the primary temporal model for face-swaps, but
    # browser canvas JPEG captures produce compression artefacts that inflate its
    # scores on real videos — so its base weight is reduced and further gated by
    # temporal_diversity below.  Xception receives more weight as a spatial anchor.
    # Wav2Lip is only useful for lip-sync attacks — face-swaps keep original audio so
    # a "synced" reading carries no exculpatory value.
    alt_weight = 0.35       # reduced from 0.45 — browser JPEG artefacts bias AltFreezing high
    wav_weight = 0.05
    vit_weight = 0.20
    xception_weight = 0.40  # raised from 0.30 — more stable spatial anchor

    # Wav2Lip: only treat OUT-OF-SYNC as a positive manipulation signal.
    # A synced result is neutral, not evidence of real — face-swap deepfakes always
    # sync because the audio is unmodified.
    wav_signal = 0.5  # neutral default
    if wav2lip_sync is False:
        wav_signal = 1.0  # out-of-sync: clear evidence of lip-sync manipulation

    # Disqualify ViT when its per-frame variance is too high (near-random predictions).
    # std > 0.35 means ViT saw some frames as near-0% fake and others as near-100%,
    # indicating it is confused by lighting/compression artefacts rather than deepfake cues.
    vit_disqualified = vit_std is not None and vit_std > 0.35
    if vit_disqualified:
        vit_weight = 0.0

    # Improvement 7 integration: reduce Xception's weight when its per-frame
    # scores swing wildly (std > 0.20 across frames — model is confused, not detecting).
    if xception_confused:
        xception_weight *= 0.50

    # ── FIX: Use temporal_diversity to gate AltFreezing weight ───────────────
    # AltFreezing scores are inflated on browser JPEG captures when frames are
    # near-identical (temporal_diversity < 0.06): it interprets JPEG blocking
    # artefacts in static faces as manipulation boundaries.  Penalise its weight
    # proportionally; when diversity is adequate (>= 0.08) it earns full trust.
    # NOTE: temporal_diversity was previously accepted as a parameter but never
    # referenced inside this function — this is the fix for that dead argument.
    alt_unreliable = alt_std is not None and alt_std == 0.0
    if alt_unreliable:
        # Completely flat window predictions → zero discriminative value
        alt_weight *= 0.50
        xception_weight += 0.10
    elif temporal_diversity is not None:
        if temporal_diversity < 0.04:
            alt_weight *= 0.25   # near-static: 75% penalty
        elif temporal_diversity < 0.06:
            alt_weight *= 0.45   # very low motion: 55% penalty
        elif temporal_diversity < 0.08:
            alt_weight *= 0.70   # low motion: 30% penalty
        # >= 0.08: full weight — enough motion for AltFreezing to be reliable

    # ── Disagreement handling — PENALTY not boost ────────────────────────────
    # Previous code boosted AltFreezing when it was the sole high-fake signal
    # while spatial models said real.  This was backwards: that exact pattern
    # (high AltFreezing + low diversity + spatial models say real) is the
    # compression-artefact false-positive signature.  Apply a penalty instead.
    active_other_scores = [
        s for s in [vit_score if not vit_disqualified else None, xception_score]
        if s is not None
    ]
    others_avg = sum(active_other_scores) / len(active_other_scores) if active_other_scores else None
    disagreement_boost = False  # kept in return dict for API backward-compat
    disagreement_penalty = (
        alt_score is not None
        and alt_score >= 0.65
        and others_avg is not None
        and others_avg < 0.45
        and temporal_diversity is not None
        and temporal_diversity < 0.08
    )
    if disagreement_penalty:
        # Spatial models agree it looks real + low diversity →
        # AltFreezing is likely reacting to JPEG compression, not deepfake cues.
        alt_weight *= 0.60

    # Normalise weights so they always sum to 1.0
    weight_sum = alt_weight + wav_weight + vit_weight + xception_weight
    if weight_sum > 0:
        alt_weight /= weight_sum
        wav_weight /= weight_sum
        vit_weight /= weight_sum
        xception_weight /= weight_sum

    alt_component = alt_weight * (alt_score if alt_score is not None else 0.5)
    wav_component = wav_weight * wav_signal
    vit_component = vit_weight * (vit_score if vit_score is not None else 0.5)
    xception_component = xception_weight * (xception_score if xception_score is not None else 0.5)
    final_score = max(0.0, min(1.0, alt_component + wav_component + vit_component + xception_component))

    if final_score >= fake_threshold:
        verdict = "FAKE"
    elif final_score <= real_threshold:
        verdict = "REAL"
    else:
        verdict = "SUSPICIOUS"

    disagreement_flag = (
        len(
            [
                pair
                for pair in [
                    (alt_score, vit_score),
                    (alt_score, xception_score),
                    (vit_score, xception_score),
                ]
                if pair[0] is not None and pair[1] is not None and abs(pair[0] - pair[1]) > 0.30
            ]
        ) > 0
    )

    alt_stance = _score_stance(alt_score)
    vit_stance = _score_stance(vit_score)
    xception_stance = _score_stance(xception_score)
    wav_stance = "fake" if wav2lip_sync is False else "unknown"
    stances = [stance for stance in [alt_stance, wav_stance, vit_stance, xception_stance] if stance != "unknown"]

    confidence = "low"
    if len(stances) >= 3 and len(set(stances)) == 1 and stances[0] in {"fake", "real"}:
        confidence = "high"
    elif any(stances.count(label) == max(len(stances) - 1, 2) for label in {"fake", "real", "suspicious"}):
        confidence = "medium"

    contribution_total = alt_component + wav_component + vit_component + xception_component
    if contribution_total > 0:
        alt_contrib_pct = round((alt_component / contribution_total) * 100)
        wav_contrib_pct = round((wav_component / contribution_total) * 100)
        vit_contrib_pct = round((vit_component / contribution_total) * 100)
        xception_contrib_pct = max(0, 100 - alt_contrib_pct - wav_contrib_pct - vit_contrib_pct)
    else:
        alt_contrib_pct = wav_contrib_pct = vit_contrib_pct = xception_contrib_pct = 0

    explanation_parts: List[str] = []
    if alt_score is not None:
        explanation_parts.append(f"AltFreezing indicated {round(alt_score * 100)}% manipulation probability")
    else:
        explanation_parts.append("AltFreezing did not provide a usable score")
    if wav2lip_sync is False:
        explanation_parts.append("Wav2Lip detected lip-sync mismatch")
    elif wav2lip_sync is True:
        explanation_parts.append("Wav2Lip found no lip-sync mismatch (neutral — face-swaps retain original audio)")
    else:
        explanation_parts.append("Wav2Lip was unavailable")
    if vit_disqualified:
        explanation_parts.append(f"ViT was excluded due to high frame-level variance (std={round(vit_std, 3) if vit_std is not None else '?'})")
    elif vit_score is not None:
        explanation_parts.append(f"ViT estimated {round(vit_score * 100)}% fake likelihood")
    else:
        explanation_parts.append("ViT was unavailable")
    if xception_score is not None:
        explanation_parts.append(f"Xception estimated {round(xception_score * 100)}% fake likelihood")
    else:
        explanation_parts.append("Xception was unavailable")

    explanation = f"{_human_join(explanation_parts)}."
    follow_up: List[str] = []
    if alt_unreliable:
        follow_up.append("AltFreezing received a lower weight because its frame predictions were completely flat")
    if disagreement_boost:
        follow_up.append("AltFreezing received a higher weight because it was the sole high-fake signal and is the most reliable temporal model")
    elif disagreement_flag:
        follow_up.append("the models disagree")
    follow_up.append(
        f"weighted contributions were AltFreezing {alt_contrib_pct}%, Wav2Lip {wav_contrib_pct}%, ViT {vit_contrib_pct}%, and Xception {xception_contrib_pct}%"
    )
    follow_up.append(f"so the final verdict is {verdict.lower()} at {round(final_score * 100)}%")
    explanation = f"{explanation} {', '.join(follow_up[:-1]) + (', ' if len(follow_up) > 1 else '') + follow_up[-1]}."

    return {
        "final_score": final_score,
        "verdict": verdict,
        "confidence": confidence,
        "explanation": explanation,
        "weights_used": {
            "altfreezing": alt_weight,
            "wav2lip": wav_weight,
            "vit": vit_weight,
            "xception": xception_weight,
        },
        "signals": {
            "altfreezing": alt_score,
            "wav2lip": wav_signal,
            "vit": vit_score,
            "xception": xception_score,
        },
        "disagreement": disagreement_flag,
        "alt_unreliable": alt_unreliable,
        "vit_disqualified": vit_disqualified,
        "disagreement_boost": disagreement_boost,
    }


def _serialize_model_run(run: ModelRun) -> dict:
    return {
        "id": run.id,
        "analysis_id": run.analysis_id,
        "model_name": run.model_name,
        "model_version": run.model_version,
        "status": run.status,
        "score": run.score,
        "confidence": run.confidence,
        "verdict": run.verdict,
        "reason": run.reason,
        "error_message": run.error_message,
        "run_meta": run.run_meta or {},
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
    }


def _persist_model_runs(
    db: Session,
    analysis: MediaAnalysis,
    *,
    alt_result: Optional[dict] = None,
    visual_decision: Optional[dict] = None,
    vit_result: Optional[dict] = None,
    xception_result: Optional[dict] = None,
    wav2lip_result: Optional[dict] = None,
) -> None:
    db.query(ModelRun).filter(ModelRun.analysis_id == analysis.id).delete(synchronize_session=False)

    completed_at = analysis.completed_at or _utcnow()
    runs: List[ModelRun] = []

    def _run_status(ok: bool, error: Optional[str]) -> str:
        if ok:
            return "DONE"
        if str(error or "") in {"quality_gate_failed", "no_sequence_crops", "no_audio_uploaded", "empty_audio_uploaded", "skipped_due_to_quality_gate"}:
            return "SKIPPED"
        return "FAILED"

    if alt_result is not None or visual_decision is not None:
        alt_payload = alt_result or {}
        visual_payload = visual_decision or {}
        runs.append(
            ModelRun(
                analysis_id=analysis.id,
                model_name="altfreezing",
                model_version=str(alt_payload.get("loaded_from") or alt_payload.get("weights_path") or "checkpoints/model.pth"),
                status=_run_status(bool(alt_payload.get("ok") or visual_payload), alt_payload.get("error")),
                score=_safe_float(visual_payload.get("score", alt_payload.get("video_score"))),
                confidence=visual_payload.get("confidence"),
                verdict=visual_payload.get("final_verdict") or visual_payload.get("model_verdict"),
                reason=visual_payload.get("reason") or alt_payload.get("error"),
                error_message=None if alt_payload.get("ok") or visual_payload else alt_payload.get("error"),
                run_meta={
                    "raw_score": _safe_float(visual_payload.get("raw_score", alt_payload.get("raw_video_score"))),
                    "score_std": _safe_float(visual_payload.get("score_std", alt_payload.get("score_std"))),
                    "total_windows": int(visual_payload.get("total_windows") or alt_payload.get("total_windows") or 0),
                    "high_frame_count": int(visual_payload.get("high_frame_count") or alt_payload.get("high_frame_count") or 0),
                    "temporal_diversity": _safe_float(visual_payload.get("temporal_diversity", (alt_payload.get("calibration") or {}).get("temporal_diversity"))),
                    "evidence_strength": visual_payload.get("evidence_strength"),
                },
                completed_at=completed_at,
            )
        )

    if vit_result is not None:
        vit_ok = bool(vit_result.get("ok"))
        runs.append(
            ModelRun(
                analysis_id=analysis.id,
                model_name="vit",
                model_version=str(vit_result.get("loaded_from") or vit_result.get("model_name") or "huggingface"),
                status=_run_status(vit_ok, vit_result.get("error")),
                score=_safe_float(vit_result.get("video_score")),
                confidence="medium" if vit_ok else "low",
                verdict=None,
                reason="spatial_validation_complete" if vit_ok else vit_result.get("error"),
                error_message=None if vit_ok else vit_result.get("error"),
                run_meta={
                    "frames_used": int(vit_result.get("frames_used") or 0),
                    "score_std": _safe_float(vit_result.get("score_std")),
                    "high_frame_count": int(vit_result.get("high_frame_count") or 0),
                    "fake_label": vit_result.get("fake_label"),
                    "real_label": vit_result.get("real_label"),
                },
                completed_at=completed_at,
            )
        )

    if xception_result is not None:
        xception_ok = bool(xception_result.get("ok"))
        runs.append(
            ModelRun(
                analysis_id=analysis.id,
                model_name="xception",
                model_version=str(xception_result.get("loaded_from") or "checkpoints/xception_best.pth"),
                status=_run_status(xception_ok, xception_result.get("error")),
                score=_safe_float(xception_result.get("video_score")),
                confidence="medium" if xception_ok else "low",
                verdict=None,
                reason="spatial_validation_complete" if xception_ok else xception_result.get("error"),
                error_message=None if xception_ok else xception_result.get("error"),
                run_meta={
                    "frames_used": int(xception_result.get("frames_used") or 0),
                    "score_std": _safe_float(xception_result.get("score_std")),
                    "high_frame_count": int(xception_result.get("high_frame_count") or 0),
                    "aggregation": xception_result.get("agg"),
                    "prediction": xception_result.get("prediction"),
                },
                completed_at=completed_at,
            )
        )

    if wav2lip_result is not None:
        wav_ok = bool(wav2lip_result.get("ok"))
        runs.append(
            ModelRun(
                analysis_id=analysis.id,
                model_name="wav2lip",
                model_version="checkpoints/wav2lip_gan.pth",
                status=_run_status(wav_ok, wav2lip_result.get("error")),
                score=_wav2lip_fake_likelihood(wav2lip_result),
                confidence=wav2lip_result.get("confidence"),
                verdict=None,
                reason=wav2lip_result.get("interpretation") or wav2lip_result.get("error"),
                error_message=None if wav_ok else wav2lip_result.get("error"),
                run_meta={
                    "sync_score": _safe_float(wav2lip_result.get("sync_score")),
                    "interpretation": wav2lip_result.get("interpretation"),
                },
                completed_at=completed_at,
            )
        )

    if runs:
        db.add_all(runs)


def _serialize_analysis(analysis: MediaAnalysis, include_model_runs: bool = False) -> dict:
    payload = {
        "id": analysis.id,
        "title": analysis.title or "Unknown Media",
        "platform": analysis.platform,
        "page_url": analysis.page_url,
        "content_url": analysis.content_url,
        "video_id": analysis.video_id,
        "verdict": analysis.verdict,
        "score": analysis.score,
        "status": analysis.status,
        "capture_mode": analysis.capture_mode,
        "extension_version": analysis.extension_version,
        "created_at": analysis.created_at.isoformat() if analysis.created_at else None,
        "meta": analysis.meta or {},
    }
    if include_model_runs:
        runs = sorted(list(getattr(analysis, "model_runs", []) or []), key=lambda run: (run.created_at or datetime.min, run.id or 0))
        payload["model_runs"] = [_serialize_model_run(run) for run in runs]
    return payload


def _serialize_linked_extension(device: LinkedExtension) -> dict:
    return {
        "id": device.id,
        "device_name": device.device_name,
        "extension_version": device.extension_version,
        "last_seen_at": device.last_seen_at.isoformat() if device.last_seen_at else None,
        "created_at": device.created_at.isoformat() if device.created_at else None,
        "is_active": bool(device.is_active and device.revoked_at is None),
        "revoked_at": device.revoked_at.isoformat() if device.revoked_at else None,
    }


def _serialize_blocklist_entry(entry: GlobalBlocklist) -> dict:
    return {
        "id": entry.id,
        "fingerprint_hash": entry.fingerprint_hash,
        "video_id": entry.video_id,
        "source_url": entry.source_url,
        "platform": entry.platform,
        "title": entry.title,
        "verdict": entry.verdict,
        "risk_score": entry.risk_score,
        "risk_level": entry.risk_level,
        "analysis_id": entry.analysis_id,
        "status": entry.status,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "updated_at": entry.updated_at.isoformat() if entry.updated_at else None,
    }


def _uploads_root() -> Path:
    return Path(__file__).resolve().parent / "uploads"


def _iter_analysis_upload_paths(analysis_id: int) -> list[Path]:
    upload_root = _uploads_root().resolve()
    if not upload_root.exists():
        return []

    paths: list[Path] = []
    for candidate in upload_root.glob(f"{analysis_id}_*"):
        try:
            resolved = candidate.resolve()
        except FileNotFoundError:
            continue
        if resolved.parent != upload_root:
            continue
        paths.append(resolved)
    return paths


def _cleanup_analysis_uploads(analysis_id: int) -> int:
    removed_count = 0
    for path in _iter_analysis_upload_paths(analysis_id):
        if path.is_dir():
            shutil.rmtree(path)
            removed_count += 1
        elif path.exists():
            path.unlink()
            removed_count += 1
    return removed_count


def _prune_analysis_uploads(analysis_id: int) -> None:
    """
    After analysis is complete, reduce disk usage:
    - Keep only the first (thumbnail) frame in  uploads/{id}_raw/
    - Delete the entire  uploads/{id}_seq/  directory (face crops no longer needed)
    """
    upload_root = _uploads_root()

    # ── _seq: delete entirely (AltFreezing already ran) ──────────────────────
    seq_dir = upload_root / f"{analysis_id}_seq"
    if seq_dir.exists():
        shutil.rmtree(seq_dir, ignore_errors=True)

    # ── _raw: keep only the first sorted frame for the thumbnail ─────────────
    raw_dir = upload_root / f"{analysis_id}_raw"
    if raw_dir.exists() and raw_dir.is_dir():
        frames = sorted(raw_dir.glob("*.jpg"))
        for f in frames[1:]:   # delete everything except frames[0]
            try:
                f.unlink()
            except Exception:
                pass


def _get_user_analysis_or_404(db: Session, user_id: int, analysis_id: int) -> MediaAnalysis:
    analysis = (
        db.query(MediaAnalysis)
        .filter(
            MediaAnalysis.id == analysis_id,
            MediaAnalysis.user_id == user_id,
        )
        .first()
    )
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return analysis


def _find_active_blocklist_entry_for_analysis(db: Session, analysis: MediaAnalysis) -> Optional[GlobalBlocklist]:
    match_clauses = [GlobalBlocklist.analysis_id == analysis.id]

    if analysis.video_id:
        match_clauses.append(GlobalBlocklist.video_id == analysis.video_id)

    source_urls = sorted({url for url in [analysis.page_url, analysis.content_url] if url})
    if source_urls:
        match_clauses.append(GlobalBlocklist.source_url.in_(source_urls))

    return (
        db.query(GlobalBlocklist)
        .filter(
            GlobalBlocklist.status == "active",
            or_(*match_clauses),
        )
        .order_by(GlobalBlocklist.created_at.desc())
        .first()
    )


def _ensure_analysis_media_accessible(db: Session, analysis: MediaAnalysis) -> None:
    blocked_entry = _find_active_blocklist_entry_for_analysis(db, analysis)
    if blocked_entry:
        raise HTTPException(
            status_code=403,
            detail="Media access denied because this item is currently on the blocklist.",
        )


def _delete_analysis_records(db: Session, analyses: List[MediaAnalysis], user_id: int) -> tuple[int, int]:
    analysis_ids = [int(analysis.id) for analysis in analyses]
    if not analysis_ids:
        return 0, 0

    files_removed = 0
    try:
        for analysis_id in analysis_ids:
            files_removed += _cleanup_analysis_uploads(analysis_id)

        db.query(GlobalBlocklist).filter(
            GlobalBlocklist.analysis_id.in_(analysis_ids)
        ).update(
            {GlobalBlocklist.analysis_id: None},
            synchronize_session=False,
        )

        db.query(ModelRun).filter(
            ModelRun.analysis_id.in_(analysis_ids)
        ).delete(synchronize_session=False)

        deleted_count = (
            db.query(MediaAnalysis)
            .filter(
                MediaAnalysis.user_id == user_id,
                MediaAnalysis.id.in_(analysis_ids),
            )
            .delete(synchronize_session=False)
        )
        db.commit()
        return deleted_count, files_removed
    except Exception:
        db.rollback()
        raise

def _issue_user_token(user: User) -> dict:
    token = create_token(user.id, user.email)
    return {"token": token, "user": UserOut(id=user.id, email=user.email, first_name=user.first_name, last_name=user.last_name)}

def _create_or_refresh_trusted_device(db: Session, user_id: int, device_id: str) -> None:
    if not device_id:
        return

    device_hash = _hash_device_id(device_id)
    now = _utcnow()
    expires = now + timedelta(days=TRUST_DEVICE_DAYS)

    existing = (
        db.query(TrustedDevice)
        .filter(TrustedDevice.user_id == user_id, TrustedDevice.device_hash == device_hash)
        .order_by(TrustedDevice.id.desc())
        .first()
    )

    if existing and existing.trusted_until and existing.trusted_until > now:
        existing.trusted_until = expires
        db.commit()
        return

    td = TrustedDevice(
        user_id=user_id,
        device_hash=device_hash,
        trusted_until=expires,
    )
    db.add(td)
    db.commit()


def _is_trusted_device(db: Session, user_id: int, device_id: str) -> bool:
    if not device_id:
        return False

    device_hash = _hash_device_id(device_id)
    now = _utcnow()

    td = (
        db.query(TrustedDevice)
        .filter(
            TrustedDevice.user_id == user_id,
            TrustedDevice.device_hash == device_hash,
            TrustedDevice.trusted_until > now,
        )
        .order_by(TrustedDevice.id.desc())
        .first()
    )
    return td is not None

def _create_email_verification(db: Session, user: User) -> str:
    otp = _new_otp_code()
    ev = EmailVerification(
        user_id=user.id,
        token_hash=_hash_email_otp(user.email, otp),  # store OTP hash in token_hash column
        expires_at=_utcnow() + timedelta(minutes=EMAIL_VERIFY_TTL_MIN),
        used_at=None,
    )
    db.add(ev)
    db.commit()
    return otp


# ----- Middlewares -----
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET", "DEV_SECRET_CHANGE_LATER"),
    same_site="lax",
    https_only=False,
)

app.add_middleware(
    CORSMiddleware,
    # allow_origins=[os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")],
    allow_origins=["*"],  # dev only
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(oauth_router)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ----- Auth: Register -> Email OTP verification (one-time) -----
@app.post("/api/auth/register")
def register(data: RegisterIn, db: Session = Depends(get_db)):
    if not data.agreed_terms:
        raise HTTPException(status_code=400, detail="You must accept Terms and Privacy Policy.")

    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        first_name=data.first_name,
        last_name=data.last_name,
        email=data.email,
        provider="local",
        password_hash=hash_password(data.password),
        agreed_terms=True,
        agreed_terms_at=_utcnow(),
        terms_version=data.terms_version or TERMS_VERSION,
        privacy_version=data.privacy_version or PRIVACY_VERSION,
        email_verified=False,
        email_verified_at=None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Create OTP for email verification
    otp = _create_email_verification(db, user)

    try:
        send_email_verification_code(to_email=user.email, code=otp, ttl_minutes=EMAIL_VERIFY_TTL_MIN)
    except Exception as e:
        # Cleanup so the user can retry
        db.delete(user)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to send verification email: {e}")

    return {"verification_required": True, "email": user.email, "message": "Verification code sent to your email."}


@app.post("/api/auth/verify-email-otp")
def verify_email_otp(data: VerifyEmailOtpIn, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user:
        raise HTTPException(status_code=400, detail="User not found")

    # If already verified, just issue a token (and optionally trust device)
    if getattr(user, "email_verified", False):
        if data.trust_device and data.device_id:
            _create_or_refresh_trusted_device(db, user.id, data.device_id)
        return _issue_user_token(user)

    expected_hash = _hash_email_otp(user.email, data.code)
    now = _utcnow()

    ev = (
        db.query(EmailVerification)
        .filter(EmailVerification.user_id == user.id, EmailVerification.used_at.is_(None), EmailVerification.expires_at > now)
        .order_by(EmailVerification.id.desc())
        .first()
    )
    if not ev:
        raise HTTPException(status_code=400, detail="Verification code expired. Please request a new code.")

    if not hmac.compare_digest(ev.token_hash, expected_hash):
        raise HTTPException(status_code=401, detail="Invalid verification code")

    user.email_verified = True
    user.email_verified_at = now
    ev.used_at = now
    db.commit()

    # Trust current device after successful signup verification
    if data.trust_device and data.device_id:
        _create_or_refresh_trusted_device(db, user.id, data.device_id)

    return _issue_user_token(user)


# ----- Auth: Login -> No OTP on trusted device; OTP on new device -----
@app.post("/api/auth/login")
def login(request: Request, data: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Google OAuth accounts: rely on Google (including their MFA if enabled)
    if getattr(user, "provider", "local") == "google":
        return _issue_user_token(user)

    # Must verify email first (signup OTP)
    if not getattr(user, "email_verified", False):
        # auto-resend a new verification OTP
        otp = _create_email_verification(db, user)
        try:
            send_email_verification_code(to_email=user.email, code=otp, ttl_minutes=EMAIL_VERIFY_TTL_MIN)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to send verification email: {e}")
        return {"verification_required": True, "email": user.email, "message": "Email not verified. We sent a new verification code."}

    # Trusted device? -> no OTP needed
    if _is_trusted_device(db, user.id, data.device_id):
        return _issue_user_token(user)

    # New / untrusted device -> require OTP (step-up MFA)
    raw_mfa_token = secrets.token_urlsafe(32)
    otp = _new_otp_code()

    challenge = MfaChallenge(
        user_id=user.id,
        mfa_token_hash=_hash_mfa_token(raw_mfa_token),
        otp_hash=_hash_otp(raw_mfa_token, otp),
        expires_at=_utcnow() + timedelta(minutes=MFA_CODE_TTL_MIN),
        attempts=0,
        consumed_at=None,
    )
    db.add(challenge)
    db.commit()

    try:
        send_mfa_code(to_email=user.email, code=otp, ttl_minutes=MFA_CODE_TTL_MIN)
    except Exception as e:
        db.delete(challenge)
        db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to send OTP email: {e}")

    return {"mfa_required": True, "mfa_token": raw_mfa_token, "email": user.email, "message": "Verification code sent to email."}


@app.post("/api/auth/mfa/verify")
def verify_mfa(request: Request, data: MfaVerifyIn, db: Session = Depends(get_db)):
    token_hash = _hash_mfa_token(data.mfa_token)
    now = _utcnow()

    challenge = (
        db.query(MfaChallenge)
        .filter(MfaChallenge.mfa_token_hash == token_hash)
        .order_by(MfaChallenge.id.desc())
        .first()
    )
    if not challenge:
        raise HTTPException(status_code=400, detail="Invalid or expired MFA session")

    if challenge.consumed_at is not None:
        raise HTTPException(status_code=400, detail="OTP already used")

    if challenge.expires_at < now:
        raise HTTPException(status_code=400, detail="OTP expired")

    if int(challenge.attempts) >= MFA_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts. Please login again.")

    provided = _hash_otp(data.mfa_token, data.code)

    if not hmac.compare_digest(challenge.otp_hash, provided):
        challenge.attempts = int(challenge.attempts) + 1
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid verification code")

    user = db.query(User).filter(User.id == challenge.user_id).first()
    if not user:
        raise HTTPException(status_code=400, detail="User not found")

    challenge.consumed_at = now
    db.commit()

    # If user chose 'trust this device', store it so next login skips OTP
    if data.trust_device and data.device_id:
        _create_or_refresh_trusted_device(db, user.id, data.device_id)

    return _issue_user_token(user)


# ----- Password reset (unchanged) -----
@app.post("/api/auth/reset-password")
def reset_password(data: ResetPasswordIn, db: Session = Depends(get_db)):
    token_h = hash_token(data.token)
    pr = db.query(PasswordReset).filter(PasswordReset.token_hash == token_h).first()

    if not pr or pr.used_at is not None or pr.expires_at < _utcnow():
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")

    user = db.query(User).filter(User.id == pr.user_id).first()
    if not user:
        raise HTTPException(status_code=400, detail="User not found")

    user.password_hash = hash_password(data.new_password)
    pr.used_at = _utcnow()
    db.commit()

    return {"message": "Password reset successful. Please sign in again."}


@app.post("/api/auth/forgot-password")
def forgot_password(data: ForgotPasswordIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    generic_msg = {"message": "If the email exists, a reset link has been sent."}

    if not user:
        return generic_msg

    raw_token = make_reset_token()
    pr = PasswordReset(
        user_id=user.id,
        token_hash=hash_token(raw_token),
        expires_at=expires_at_dt(),
        used_at=None,
    )
    db.add(pr)
    db.commit()

    frontend_base = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")
    reset_link = f"{frontend_base}/reset-password?token={raw_token}"

    try:
        send_reset_email(user.email, reset_link)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Email send failed: {e}")

    return generic_msg





@app.post("/api/extension/link/request")
def create_extension_link_request(data: ExtensionLinkRequestIn, db: Session = Depends(get_db)):
    existing = db.query(ExtensionLinkRequest).filter(ExtensionLinkRequest.request_id == data.request_id).first()
    now = _utcnow()

    if existing and existing.status in {"pending", "approved"} and existing.expires_at > now:
        return {
            "ok": True,
            "request_id": existing.request_id,
            "status": existing.status,
            "expires_at": existing.expires_at.isoformat(),
        }

    if existing:
        existing.code_challenge = data.code_challenge
        existing.device_name = data.device_name or "Chrome Extension"
        existing.extension_version = data.extension_version
        existing.user_id = None
        existing.status = "pending"
        existing.expires_at = now + timedelta(minutes=EXTENSION_LINK_TTL_MIN)
        existing.approved_at = None
        existing.redeemed_at = None
        db.commit()
        return {
            "ok": True,
            "request_id": existing.request_id,
            "status": existing.status,
            "expires_at": existing.expires_at.isoformat(),
        }

    req = ExtensionLinkRequest(
        request_id=data.request_id,
        code_challenge=data.code_challenge,
        device_name=data.device_name or "Chrome Extension",
        extension_version=data.extension_version,
        status="pending",
        expires_at=now + timedelta(minutes=EXTENSION_LINK_TTL_MIN),
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return {
        "ok": True,
        "request_id": req.request_id,
        "status": req.status,
        "expires_at": req.expires_at.isoformat(),
    }


@app.get("/api/extension/link/request/{request_id}")
def get_extension_link_request_status(request_id: str, db: Session = Depends(get_db)):
    req = db.query(ExtensionLinkRequest).filter(ExtensionLinkRequest.request_id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Link request not found")

    if req.status in {"pending", "approved"} and req.expires_at <= _utcnow():
        req.status = "expired"
        db.commit()

    return {
        "ok": True,
        "request_id": req.request_id,
        "status": req.status,
        "device_name": req.device_name,
        "extension_version": req.extension_version,
        "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        "approved": req.status == "approved",
    }


@app.post("/api/extension/link/approve")
def approve_extension_link_request(
    data: ExtensionLinkApproveIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_portal_user),
):
    req = db.query(ExtensionLinkRequest).filter(ExtensionLinkRequest.request_id == data.request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Link request not found")

    now = _utcnow()
    if req.expires_at <= now:
        req.status = "expired"
        db.commit()
        raise HTTPException(status_code=400, detail="Link request expired")

    if req.status == "redeemed":
        raise HTTPException(status_code=400, detail="Link request already used")

    req.user_id = current_user.id
    req.status = "approved"
    req.approved_at = now
    db.commit()

    return {
        "ok": True,
        "status": req.status,
        "device_name": req.device_name,
        "user": {
            "id": current_user.id,
            "email": current_user.email,
            "first_name": current_user.first_name,
            "last_name": current_user.last_name,
        },
    }


@app.post("/api/extension/link/redeem")
def redeem_extension_link_request(data: ExtensionLinkRedeemIn, db: Session = Depends(get_db)):
    req = db.query(ExtensionLinkRequest).filter(ExtensionLinkRequest.request_id == data.request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Link request not found")

    now = _utcnow()
    if req.expires_at <= now:
        req.status = "expired"
        db.commit()
        raise HTTPException(status_code=400, detail="Link request expired")

    if req.status != "approved" or not req.user_id:
        raise HTTPException(status_code=400, detail="Link request not approved yet")

    expected_challenge = _pkce_challenge_for_verifier(data.code_verifier)
    if not hmac.compare_digest(expected_challenge, req.code_challenge):
        raise HTTPException(status_code=400, detail="Invalid code verifier")

    user = db.query(User).filter(User.id == req.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    device = LinkedExtension(
        user_id=user.id,
        link_request_id=req.id,
        device_name=req.device_name or "Chrome Extension",
        extension_version=req.extension_version,
        token_hash="pending",
        last_seen_at=now,
        is_active=True,
    )
    db.add(device)
    db.flush()

    token = create_extension_token(
        user.id,
        user.email,
        device.id,
        scopes=["analysis:create", "analysis:read:self"],
        expires_days=EXTENSION_TOKEN_EXPIRE_DAYS,
    )
    device.token_hash = _hash_extension_token(token)

    req.status = "redeemed"
    req.redeemed_at = now

    db.commit()
    db.refresh(device)

    return {
        "ok": True,
        "status": "linked",
        "extension_token": token,
        "user": {
            "id": user.id,
            "email": user.email,
            "first_name": user.first_name,
            "last_name": user.last_name,
        },
        "device": _serialize_linked_extension(device),
    }


@app.get("/api/extension/devices")
def list_extension_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_portal_user),
):
    devices = (
        db.query(LinkedExtension)
        .filter(LinkedExtension.user_id == current_user.id)
        .order_by(LinkedExtension.created_at.desc())
        .all()
    )
    return {"ok": True, "data": [_serialize_linked_extension(d) for d in devices]}


@app.post("/api/extension/devices/{device_id}/revoke")
def revoke_extension_device(
    device_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_portal_user),
):
    device = (
        db.query(LinkedExtension)
        .filter(LinkedExtension.id == device_id, LinkedExtension.user_id == current_user.id)
        .first()
    )
    if not device:
        raise HTTPException(status_code=404, detail="Linked extension not found")

    device.is_active = False
    device.revoked_at = _utcnow()
    db.commit()
    return {"ok": True, "message": "Extension revoked"}


@app.post("/api/extension/devices/self/revoke")
def revoke_current_extension_device(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = _decode_access_token(token)
    if payload.get("type") != "extension":
        raise HTTPException(status_code=403, detail="Extension token required")

    linked_extension_id = payload.get("linked_extension_id")
    user_id = payload.get("sub")
    if not linked_extension_id:
        raise HTTPException(status_code=401, detail="Invalid extension token")

    device = (
        db.query(LinkedExtension)
        .filter(
            LinkedExtension.id == int(linked_extension_id),
            LinkedExtension.user_id == int(user_id),
            LinkedExtension.token_hash == _hash_extension_token(token),
        )
        .first()
    )
    if not device:
        raise HTTPException(status_code=404, detail="Linked extension not found")

    device.is_active = False
    device.revoked_at = _utcnow()
    db.commit()
    return {"ok": True, "message": "Extension disconnected"}


def _decide_altfreezing_verdict(score: Optional[float], quality_gate: dict, alt_result: dict) -> dict:
    def _decision_payload(
        *,
        final_verdict: str,
        model_verdict: str,
        reason: str,
        confidence: str,
        quality_band: str,
        high_frame_count: int,
        score_std: Optional[float],
        score: Optional[float],
        raw_score: Optional[float],
        total_windows: int,
        temporal_diversity: float,
        temporal_penalty: float,
        evidence_quality: float,
        evidence_strength: str,
    ) -> dict:
        return {
            "final_verdict": final_verdict,
            "model_verdict": model_verdict,
            "reason": reason,
            "confidence": confidence,
            "quality_band": quality_band,
            "high_frame_count": high_frame_count,
            "score_std": score_std,
            "score": score,
            "raw_score": raw_score,
            "total_windows": total_windows,
            "temporal_diversity": temporal_diversity,
            "temporal_penalty": temporal_penalty,
            "evidence_quality": evidence_quality,
            "evidence_strength": evidence_strength,
        }

    if score is None:
        return _decision_payload(
            final_verdict="INCONCLUSIVE",
            model_verdict="INCONCLUSIVE",
            reason=alt_result.get("error") or "no_score",
            confidence="low",
            quality_band="weak",
            high_frame_count=0,
            score_std=None,
            score=None,
            raw_score=None,
            total_windows=int(alt_result.get("total_windows") or 0),
            temporal_diversity=0.0,
            temporal_penalty=1.0,
            evidence_quality=0.0,
            evidence_strength="weak",
        )

    avg_blur = float(quality_gate.get("avg_blur") or 0.0)
    avg_brightness = float(quality_gate.get("avg_brightness") or 0.0)
    usable_ratio = float(quality_gate.get("usable_ratio") or 0.0)
    seq_frames = int(quality_gate.get("sequence_frames_used") or 0)

    score_std = _safe_float(alt_result.get("score_std"))
    high_frame_count = int(alt_result.get("high_frame_count") or 0)
    raw_score = float(alt_result.get("raw_video_score", score))
    total_windows = int(
        alt_result.get("total_windows")
        or len(alt_result.get("per_frame") or [])
        or (1 if score is not None else 0)
    )

    calibration = alt_result.get("calibration") or {}
    evidence_quality = float(calibration.get("evidence_quality") or 0.0)
    temporal_diversity = float(calibration.get("temporal_diversity") or 0.0)

    # ── Quality band ─────────────────────────────────────────────────────────
    # "moderate" threshold matches the quality gate (MIN_AVG_BLUR=2.0, MIN_USABLE_RATIO=0.10)
    # so that browser JPEG captures (typically blur 2–5) are not downgraded to "weak".
    if avg_blur >= 8.0 and usable_ratio >= 0.40 and seq_frames >= 16 and avg_brightness >= 40.0:
        quality_band = "strong"
    elif avg_blur >= 2.0 and usable_ratio >= 0.10 and seq_frames >= 6:
        quality_band = "moderate"
    else:
        quality_band = "weak"

    # ── opencv track-stability signals ────────────────────────────────────────
    # These come from the face tracker in opencv_pipeline. A track gap (the face
    # disappears for several frames then reappears at a very different position)
    # is a key deepfake artefact — face-swap compositing often causes the
    # substituted face to jump spatially when the underlying actor moves their
    # head. Geometry-rejected frames (IoU=0.00) also indicate sudden face jumps.
    track_gap_count = int(quality_gate.get("track_gap_count") or 0)
    geometry_rejected_count = int(quality_gate.get("geometry_rejected_count") or 0)
    # Sequence-level stability from opencv (avg_iou, drift, size_consistency).
    # A sequence can have geometry-rejected frames in isolation but still be
    # globally stable — only flag instability when BOTH the tracker detected a
    # gap+jump AND the sequence-level metrics confirm the track is actually bad.
    sequence_stable = bool(quality_gate.get("sequence_stable", True))
    track_instability = (track_gap_count >= 1 and geometry_rejected_count >= 3 and not sequence_stable)
    # Stable tracking: no gaps, no jumps, face found throughout
    track_stable = (track_gap_count == 0 and geometry_rejected_count == 0)

    # ── Temporal penalty — shrink toward 0.5 (uncertainty), NOT toward 0 ─────
    temporal_penalty = 1.0
    if temporal_diversity < 0.04:
        temporal_penalty = 0.60
    elif temporal_diversity < 0.08:
        temporal_penalty = 0.80

    adjusted_score = max(0.0, min(1.0, 0.5 + (float(score) - 0.5) * temporal_penalty))

    weak_confidence_for_fake = (
        total_windows < 3
        or score_std is None
        or score_std < 0.01
        or high_frame_count <= 1
    )
    strong_fake_evidence = (
        adjusted_score > 0.90
        and score_std is not None
        and score_std > 0.02
        and temporal_diversity > 0.15
        and high_frame_count >= 3
        and total_windows >= 3
    )

    evidence_strength = _evidence_strength_label(
        {
            "quality_band": quality_band,
            "total_windows": total_windows,
            "score_std": score_std,
            "temporal_diversity": temporal_diversity,
            "high_frame_count": high_frame_count,
            "evidence_quality": evidence_quality,
        }
    )

    # ── Rule 0: very low raw score → REAL (model's actual threshold is ~0.04) ──
    # The AltFreezing model's optimal_threshold in demo.py is 0.04, meaning raw
    # scores below ~0.10 strongly indicate real content regardless of other signals.
    # Using 0.15 gives a comfortable safety margin above the 0.04 model threshold.
    if raw_score < 0.15 and seq_frames >= 6:
        return _decision_payload(
            final_verdict="REAL",
            model_verdict="REAL",
            reason="very_low_fake_score",
            confidence="high" if raw_score < 0.05 else "medium",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 1: track instability — SUSPICIOUS regardless of model score ──────
    # The AltFreezing model scores pixel-level face swap artefacts. It does NOT
    # detect geometric inconsistency (face jumping position between frames).
    # When the opencv tracker detects a gap+jump, that IS a deepfake signal
    # even if the raw model score is low.
    # Conditions: gap occurred, ≥3 geometry-rejected frames, ≥6 crops retained.
    if track_instability and seq_frames >= 6:
        return _decision_payload(
            final_verdict="SUSPICIOUS",
            model_verdict="FAKE",
            reason="track_instability_face_jump_detected",
            confidence="medium",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 2: stable tracking + low model score → REAL ─────────────────────
    # Continuous face track (no gaps, no geometry rejections) AND low model
    # score means both the pixel-level detector and the geometric tracker agree
    # the video is authentic. Apply from single-window captures onwards.
    if track_stable and adjusted_score <= 0.40 and seq_frames >= 6:
        return _decision_payload(
            final_verdict="REAL",
            model_verdict="REAL",
            reason="stable_track_low_model_score",
            confidence="medium" if total_windows >= 2 else "low",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 3: insufficient windows → INCONCLUSIVE ───────────────────────────
    # Only fall through to this if track signals were ambiguous (gap=0 but score
    # is not clearly low, or gap>0 but too few crops to be confident).
    if total_windows < 3:
        return _decision_payload(
            final_verdict="INCONCLUSIVE",
            model_verdict="INCONCLUSIVE",
            reason="insufficient_prediction_windows",
            confidence="low",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength="weak",
        )

    # ── Rule 4: strong pixel-level FAKE signal ───────────────────────────────
    if strong_fake_evidence and quality_band in {"moderate", "strong"} and evidence_quality >= 0.65 and seq_frames >= 12:
        return _decision_payload(
            final_verdict="FAKE",
            model_verdict="FAKE",
            reason="strong_consistent_fake_signal",
            confidence="high",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength="strong",
        )

    # ── Rule 5: talking-head / interview REAL override ───────────────────────
    # Only fires for NEAR-STATIC footage (temporal_diversity < 0.06).
    # Previous threshold was <= 0.12 which was too broad — Tom Cruise deepfake
    # (diversity=0.073) would have been wrongly classified as a talking-head.
    # adj_score ceiling raised from 0.72 → 0.82 and raw_score from 0.90 → 0.98
    # to catch the Elon Musk interview case (adj=0.777, raw=0.969) which was
    # previously escaping this safety valve by a narrow margin.
    is_talking_head = (
        temporal_diversity < 0.06       # near-static only (was <= 0.12)
        and adjusted_score <= 0.82      # raised ceiling (was 0.72)
        and raw_score < 0.98            # raised ceiling (was 0.90)
        and seq_frames >= 8
        and total_windows <= 2          # don't override when 3+ windows give consistent signal
        and high_frame_count <= 1       # don't override when multiple windows exceed fake threshold
    )
    if is_talking_head:
        return _decision_payload(
            final_verdict="REAL",
            model_verdict="REAL",
            reason="stable_talking_head_real_override",
            confidence="medium",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 5.5: decent diversity + elevated score → SUSPICIOUS ─────────────
    # When the video has enough motion (diversity >= 0.06) that AltFreezing is
    # trustworthy AND its adjusted score is still elevated (>= 0.70), the
    # talking-head override must not fire and this video is at minimum suspicious.
    # This rule catches face-swap deepfakes with natural head movement that would
    # otherwise fall through to Rule 9 (INCONCLUSIVE).
    if temporal_diversity >= 0.06 and adjusted_score >= 0.70 and seq_frames >= 8:
        return _decision_payload(
            final_verdict="SUSPICIOUS",
            model_verdict="FAKE",
            reason="decent_diversity_elevated_alt_score",
            confidence="medium" if total_windows >= 3 else "low",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 5.8: Excellent track stability + near-static + synced audio → REAL ─
    # When opencv reports robotically stable tracking (iou >= 0.90, centre drift
    # <= 3% of frame width, consistent face size), the video is near-static
    # (temporal_diversity < 0.06), this is a strong real-content signature for
    # interview/talking-head footage.
    #
    # AltFreezing and Xception misfire here because they cannot distinguish JPEG
    # blocking artefacts in near-static face crops from deepfake pixel artefacts.
    # Track geometry is immune to that confusion:
    #   Real faces: stable bbox, minimal drift, constant size
    #   Face-swap deepfakes: pasted face resizes subtly per frame → lower size_consistency
    #
    # Safety locks preventing this from firing on deepfakes:
    #   1. size_consistency >= 0.85  (face-swaps score 0.55–0.80)
    #   2. avg_iou >= 0.90           (face-swaps with head movement score lower)
    #   3. max_centre_drift <= 0.03  (compositing jitter raises drift)
    #   4. temporal_diversity < 0.06 (deepfakes with natural motion score 0.06+)
    #   5. adjusted_score <= 0.85    (extreme model scores still pass to Rule 7)
    opencv_stability = quality_gate.get("stability") or {}
    avg_iou = float(opencv_stability.get("avg_iou") or 0.0)
    max_centre_drift = float(opencv_stability.get("max_centre_drift") or 1.0)
    size_consistency_val = float(opencv_stability.get("size_consistency") or 0.0)
    excellent_tracking = (
        avg_iou >= 0.90
        and max_centre_drift <= 0.03
        and size_consistency_val >= 0.85
        and track_gap_count == 0
        and geometry_rejected_count == 0
    )
    if (
        excellent_tracking
        and temporal_diversity < 0.06
        and adjusted_score <= 0.85
        and seq_frames >= 16
    ):
        return _decision_payload(
            final_verdict="REAL",
            model_verdict="REAL",
            reason="excellent_track_static_real_override",
            confidence="medium",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 6: low score on decent quality → REAL ───────────────────────────
    if adjusted_score <= 0.30 and quality_band in {"moderate", "strong"}:
        return _decision_payload(
            final_verdict="REAL",
            model_verdict="REAL",
            reason="low_fake_score_with_good_quality",
            confidence="high" if evidence_strength == "strong" else "medium",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 7: very high score → SUSPICIOUS ────────────────────────────────
    if raw_score >= 0.90 or adjusted_score >= 0.85:
        downgrade_reason = (
            "high_score_but_weak_evidence"
            if weak_confidence_for_fake or temporal_diversity < 0.15
            else "high_score_downgraded_to_suspicious"
        )
        return _decision_payload(
            final_verdict="SUSPICIOUS",
            model_verdict="FAKE",
            reason=downgrade_reason,
            confidence="medium" if evidence_strength != "weak" else "low",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 8: weak quality + high score ────────────────────────────────────
    # Threshold raised from 0.65 to 0.80: browser JPEG crops score higher than
    # face-aligned crops, so a modest 0.65 score on weak quality is not reliable.
    if quality_band == "weak" and adjusted_score >= 0.80:
        return _decision_payload(
            final_verdict="SUSPICIOUS",
            model_verdict="FAKE",
            reason="elevated_score_on_weak_quality_sequence",
            confidence="low",
            quality_band=quality_band,
            high_frame_count=high_frame_count,
            score_std=score_std,
            score=adjusted_score,
            raw_score=raw_score,
            total_windows=total_windows,
            temporal_diversity=temporal_diversity,
            temporal_penalty=temporal_penalty,
            evidence_quality=evidence_quality,
            evidence_strength=evidence_strength,
        )

    # ── Rule 9: fallback ────────────────────────────────────────────────────
    return _decision_payload(
        final_verdict="INCONCLUSIVE",
        model_verdict="INCONCLUSIVE",
        reason="score_in_uncertain_band",
        confidence="low",
        quality_band=quality_band,
        high_frame_count=high_frame_count,
        score_std=score_std,
        score=adjusted_score,
        raw_score=raw_score,
        total_windows=total_windows,
        temporal_diversity=temporal_diversity,
        temporal_penalty=temporal_penalty,
        evidence_quality=evidence_quality,
        evidence_strength=evidence_strength,
    )

def _combine_verdicts(visual_decision: dict, wav2lip_result: dict) -> dict:
    """
    Merge AltFreezing visual verdict with Wav2Lip audio-visual sync result.

    Rules (in priority order):
      1.  Wav2Lip unavailable / low-confidence → keep visual verdict unchanged
      2.  Visual FAKE  + sync out_of_sync      → FAKE   (both agree)
      3.  Visual FAKE  + sync synced           → SUSPICIOUS (conflicting)
      4.  Visual REAL  + sync out_of_sync      → SUSPICIOUS (audio mismatch)
      5.  Visual REAL  + sync synced/uncertain → REAL   (keeps visual verdict)
      6.  Visual SUSPICIOUS                   → SUSPICIOUS (sync as support)
      7.  Visual INCONCLUSIVE + sync out_of_sync → SUSPICIOUS
      8.  Visual INCONCLUSIVE + sync synced   → REAL (audio evidence)
      9.  Fallback                            → keep visual verdict
    """
    visual_verdict = visual_decision.get("final_verdict", "INCONCLUSIVE")
    sync_ok        = wav2lip_result.get("ok", False)
    sync_score     = wav2lip_result.get("sync_score")
    sync_interp    = wav2lip_result.get("interpretation", "unavailable")
    sync_conf      = wav2lip_result.get("confidence", "low")

    # Rule 1: Skip if wav2lip unavailable or confidence too low
    if not sync_ok or sync_score is None or sync_conf == "low":
        return {**visual_decision, "wav2lip_applied": False, "combined_reason": "wav2lip_skipped"}

    out_of_sync = sync_interp == "out_of_sync"   # sync_score < 0.38
    synced      = sync_interp == "synced"         # sync_score > 0.65

    if visual_verdict == "FAKE":
        if out_of_sync:
            return {**visual_decision, "final_verdict": "FAKE",
                    "wav2lip_applied": True,
                    "combined_reason": "visual_fake_confirmed_by_audio_desync"}
        elif synced:
            return {**visual_decision, "final_verdict": "SUSPICIOUS",
                    "confidence": "medium",
                    "wav2lip_applied": True,
                    "combined_reason": "visual_fake_but_audio_synced_conflicting"}
        else:
            return {**visual_decision, "final_verdict": "SUSPICIOUS",
                    "confidence": "medium",
                    "wav2lip_applied": True,
                    "combined_reason": "visual_fake_audio_uncertain"}

    if visual_verdict == "REAL":
        if out_of_sync:
            return {**visual_decision, "final_verdict": "SUSPICIOUS",
                    "confidence": "medium",
                    "wav2lip_applied": True,
                    "combined_reason": "visual_real_but_audio_desync_detected"}
        else:
            return {**visual_decision, "wav2lip_applied": True,
                    "combined_reason": "visual_real_audio_confirms"}

    if visual_verdict == "SUSPICIOUS":
        if out_of_sync:
            return {**visual_decision, "final_verdict": "SUSPICIOUS",
                    "confidence": "medium",
                    "wav2lip_applied": True,
                    "combined_reason": "suspicious_confirmed_by_audio_desync"}
        else:
            return {**visual_decision, "wav2lip_applied": True,
                    "combined_reason": "suspicious_audio_not_conclusive"}

    if visual_verdict == "INCONCLUSIVE":
        if out_of_sync:
            return {**visual_decision, "final_verdict": "SUSPICIOUS",
                    "confidence": "low",
                    "wav2lip_applied": True,
                    "combined_reason": "inconclusive_visual_audio_desync_suggests_fake"}
        elif synced:
            return {**visual_decision, "final_verdict": "REAL",
                    "confidence": "low",
                    "wav2lip_applied": True,
                    "combined_reason": "inconclusive_visual_audio_synced_suggests_real"}

    return {**visual_decision, "wav2lip_applied": True,
            "combined_reason": "no_combination_rule_matched"}


def _combine_model_signals(
    visual_decision: dict,
    alt_result: dict,
    vit_result: dict,
    xception_result: dict,
    wav2lip_result: dict,
    quality_gate: dict,
) -> dict:
    calibration = (alt_result or {}).get("calibration") or {}

    alt_score = _clamp01(
        visual_decision.get("score")
        if visual_decision.get("score") is not None
        else (alt_result or {}).get("video_score")
    )
    vit_score = _clamp01((vit_result or {}).get("video_score")) if (vit_result or {}).get("ok") else None
    xception_score = _clamp01((xception_result or {}).get("video_score")) if (xception_result or {}).get("ok") else None
    wav2lip_risk = _wav2lip_fake_likelihood(wav2lip_result or {})

    raw_score = _clamp01(
        visual_decision.get("raw_score")
        if visual_decision.get("raw_score") is not None
        else (alt_result or {}).get("raw_video_score")
    )
    score_std = _safe_float(
        visual_decision.get("score_std")
        if visual_decision.get("score_std") is not None
        else (alt_result or {}).get("score_std")
    )
    total_windows = int(
        visual_decision.get("total_windows")
        or (alt_result or {}).get("total_windows")
        or len((alt_result or {}).get("per_frame") or [])
        or 0
    )
    temporal_diversity = _safe_float(
        visual_decision.get("temporal_diversity")
        if visual_decision.get("temporal_diversity") is not None
        else calibration.get("temporal_diversity")
    )
    temporal_penalty = _safe_float(visual_decision.get("temporal_penalty")) or 1.0
    quality_band = str(visual_decision.get("quality_band") or _metadata_quality_band(quality_gate or {})).lower()
    evidence_quality = _safe_float(
        visual_decision.get("evidence_quality")
        if visual_decision.get("evidence_quality") is not None
        else calibration.get("evidence_quality")
    )
    if evidence_quality is None:
        evidence_quality = 0.0

    usable_frames = int((quality_gate or {}).get("sequence_frames_used") or 0)
    high_frame_count = int(
        visual_decision.get("high_frame_count")
        or (alt_result or {}).get("high_frame_count")
        or 0
    )
    wav_sync_available = bool(wav2lip_result.get("ok")) and str(wav2lip_result.get("confidence") or "").lower() != "low"
    wav2lip_sync = None
    if wav_sync_available:
        interpretation = str(wav2lip_result.get("interpretation") or "").strip().lower()
        if interpretation == "synced":
            wav2lip_sync = True
        elif interpretation == "out_of_sync":
            wav2lip_sync = False
        elif wav2lip_risk is not None:
            wav2lip_sync = wav2lip_risk <= 0.35

    vit_score_std = _safe_float((vit_result or {}).get("score_std"))

    # ── Extract quality metrics for improvements 2–7 ─────────────────────────
    avg_blur       = float((quality_gate or {}).get("avg_blur") or 0.0)
    avg_brightness = float((quality_gate or {}).get("avg_brightness") or 0.0)
    stability_meta_qs = (quality_gate or {}).get("stability") or {}
    avg_iou         = float(stability_meta_qs.get("avg_iou") or 1.0)
    size_consistency = float(stability_meta_qs.get("size_consistency") or 1.0)

    # ── Improvement 7: Xception per-frame consistency ─────────────────────────
    xception_per_frame  = (xception_result or {}).get("per_frame") or []
    xception_consistency = _xception_consistency_check(xception_per_frame)

    # ── Improvement 5: Xception quality normalisation (by face sharpness) ────
    # Shrinks Xception score toward 0.5 when blur is too low for reliable detection
    xception_score_calibrated = (
        _normalise_xception_by_quality(xception_score, avg_blur)
        if xception_score is not None else None
    )

    # ── Improvement 1: Temperature scaling to reduce overconfidence ──────────
    # Apply after quality normalisation so both corrections compound correctly.
    alt_score_calibrated = (
        _calibrate_score(alt_score, _ALT_TEMPERATURE)
        if alt_score is not None else None
    )
    xception_score_calibrated = (
        _calibrate_score(xception_score_calibrated, _XCEPTION_TEMPERATURE)
        if xception_score_calibrated is not None else None
    )

    # ── Improvement 3: Video type classification ──────────────────────────────
    video_context = _classify_video_context(
        avg_blur, avg_iou, size_consistency, avg_brightness, temporal_diversity
    )

    # ── Improvement 2: Dynamic verdict thresholds ────────────────────────────
    fake_threshold, real_threshold = _get_verdict_thresholds(
        avg_blur, avg_iou, total_windows, temporal_diversity
    )

    fused = fuse_decision(
        altfreezing_score=alt_score_calibrated,
        altfreezing_std=score_std,
        temporal_diversity=temporal_diversity,
        wav2lip_sync=wav2lip_sync,
        vit_fake_score=vit_score,
        xception_fake_score=xception_score_calibrated,
        vit_score_std=vit_score_std,
        fake_threshold=fake_threshold,
        real_threshold=real_threshold,
        xception_confused=xception_consistency["confused"],
    )

    low_temporal_diversity = temporal_diversity is not None and temporal_diversity < 0.10
    single_window = total_windows <= 1
    flat_alt_predictions = score_std is None or score_std == 0.0
    insufficient_data = alt_score is None or usable_frames < 6

    # ── Verdict arbitration: rule-based vs fuse_decision ─────────────────────
    # fuse_decision is a weighted average across all models.  It works well when
    # models broadly agree.  But for near-static browser JPEG captures, AltFreezing
    # and Xception both score systematically high due to compression artefacts — the
    # fused score then incorrectly overrides a carefully guarded rule verdict (REAL).
    #
    # Two arbitration policies applied together:
    #
    # Policy A — REAL override:
    #   When a definitive-REAL rule fired, trust it over fuse.
    #   "excellent_track_static_real_override" is unconditional (overrides even FAKE).
    #   Other definitive-REAL rules override only when fuse didn't reach FAKE.
    #
    # Policy B — SUSPICIOUS floor:
    #   When a rule detected something suspicious (Rule 5.5, 7, 8, etc.) but fuse
    #   averaged down to REAL (because some models scored low), keep SUSPICIOUS.
    #   The rule system saw enough evidence to distrust the video; fuse must not
    #   silently clear that flag. Fuse can still escalate to FAKE.
    DEFINITIVE_REAL_REASONS = {
        "very_low_fake_score",
        "stable_track_low_model_score",
        "stable_talking_head_real_override",
        "excellent_track_static_real_override",
        "low_fake_score_with_good_quality",
    }
    # Highest-trust rule — overrides fuse even when fuse=FAKE
    UNCONDITIONAL_REAL_REASONS = {
        "excellent_track_static_real_override",
    }
    # Rules that set a SUSPICIOUS floor — fuse cannot go below SUSPICIOUS
    SUSPICIOUS_FLOOR_REASONS = {
        "decent_diversity_elevated_alt_score",      # Rule 5.5 — motion + high AltFreezing
        "track_instability_face_jump_detected",     # Rule 1   — face jump detected
        "high_score_but_weak_evidence",             # Rule 7
        "high_score_downgraded_to_suspicious",      # Rule 7 variant
        "elevated_score_on_weak_quality_sequence",  # Rule 8
    }

    rule_reason = visual_decision.get("reason", "")
    rule_verdict = visual_decision.get("final_verdict", "INCONCLUSIVE")

    rule_is_unconditional_real  = rule_verdict == "REAL" and rule_reason in UNCONDITIONAL_REAL_REASONS
    rule_is_definitive_real     = rule_verdict == "REAL" and rule_reason in DEFINITIVE_REAL_REASONS
    rule_sets_suspicious_floor  = rule_verdict in {"SUSPICIOUS", "FAKE"} and rule_reason in SUSPICIOUS_FLOOR_REASONS

    verdict = fused["verdict"]
    combined_reason = "weighted_fusion"

    if insufficient_data:
        verdict = "INCONCLUSIVE"
        combined_reason = "weighted_fusion_insufficient_data"
    elif rule_is_unconditional_real:
        verdict = "REAL"
        combined_reason = f"rule_override_{rule_reason}"
    elif rule_is_definitive_real and fused["verdict"] != "FAKE":
        verdict = "REAL"
        combined_reason = f"rule_override_{rule_reason}"
    elif rule_sets_suspicious_floor and fused["verdict"] == "REAL":
        verdict = "SUSPICIOUS"
        combined_reason = f"rule_floor_{rule_reason}"
    elif low_temporal_diversity:
        combined_reason = "weighted_fusion_low_temporal_diversity"
    elif single_window or flat_alt_predictions:
        combined_reason = "weighted_fusion_weak_alt_evidence"
    elif fused["disagreement"]:
        combined_reason = "weighted_fusion_model_disagreement"

    # ── Improvement 3: Video context arbitration ─────────────────────────────
    if verdict == "FAKE" and video_context == "conference" and (
        total_windows <= 2 or fused["final_score"] < 0.90
    ):
        # Conference footage: small faces make models unreliable — require stronger signal
        verdict = "SUSPICIOUS"
        combined_reason = "conference_context_insufficient_evidence"
    elif verdict in {"SUSPICIOUS", "INCONCLUSIVE"} and video_context == "interview" and rule_is_definitive_real:
        # Clear interview/talking-head + definitive rule says REAL → trust rule unconditionally
        verdict = "REAL"
        combined_reason = f"interview_context_rule_override_{rule_reason}"

    # ── Improvement 4: Require >= 2 independent models agreeing for FAKE ─────
    fake_votes = _count_fake_votes({
        "altfreezing": alt_score_calibrated,
        "xception":    xception_score_calibrated,
        "vit":         vit_score if not fused.get("vit_disqualified") else None,
        "wav2lip":     wav2lip_risk,
    })
    if verdict == "FAKE" and fake_votes < 2:
        verdict = "SUSPICIOUS"
        combined_reason = "insufficient_model_agreement_for_fake"

    # ── Improvement 6: Uncertainty cascade ───────────────────────────────────
    verdict, cascade_reason = _apply_uncertainty_cascade(
        verdict,
        total_windows=total_windows,
        avg_blur=avg_blur,
        wav2lip_available=wav_sync_available,
        avg_iou=avg_iou,
        seq_frames=usable_frames,
    )
    if cascade_reason != "no_cascade":
        combined_reason = cascade_reason

    evidence_strength = _evidence_strength_label(
        {
            "quality_band": quality_band,
            "total_windows": total_windows,
            "score_std": score_std,
            "temporal_diversity": temporal_diversity,
            "high_frame_count": high_frame_count,
            "evidence_quality": evidence_quality,
        }
    )

    return {
        **visual_decision,
        "final_verdict": verdict,
        "model_verdict": visual_decision.get("model_verdict", verdict),
        "score": 0.0 if verdict == "INCONCLUSIVE" else fused["final_score"],
        "final_score": 0.0 if verdict == "INCONCLUSIVE" else fused["final_score"],
        "raw_score": raw_score,
        "confidence": "low" if verdict == "INCONCLUSIVE" else fused["confidence"],
        "reason": combined_reason,
        "combined_reason": combined_reason,
        "explanation": fused["explanation"],
        "signals": {
            "altfreezing": alt_score,
            "vit": vit_score,
            "xception": xception_score,
            "wav2lip": wav2lip_risk,
        },
        "alt_score": alt_score,
        "vit_score": vit_score,
        "xception_score": xception_score,
        "wav2lip_score": wav2lip_risk,
        "disagreement_flag": fused["disagreement"],
        "wav2lip_applied": wav2lip_risk is not None,
        "vit_applied": vit_score is not None,
        "vit_disqualified": fused.get("vit_disqualified", False),
        "xception_applied": xception_score is not None,
        "xception_confused": xception_consistency["confused"],
        "xception_consistency": xception_consistency,
        "weights_used": fused["weights_used"],
        "evidence_strength": evidence_strength,
        "temporal_penalty": temporal_penalty,
        "disagreement_boost": fused.get("disagreement_boost", False),
        "video_context": video_context,
        "fake_votes": fake_votes,
        "fake_threshold": fake_threshold,
        "real_threshold": real_threshold,
        "alt_score_calibrated": alt_score_calibrated,
        "xception_score_calibrated": xception_score_calibrated,
    }


@app.post("/api/analysis/video")
async def video_analysis(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    platform: Optional[str] = Form(None),
    page_url: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Accept a video file upload, run AltFreezing (visual) + Wav2Lip (audio-visual
    sync) and return a combined deepfake verdict.
    """
    upload_dir = Path(__file__).resolve().parent / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    # ── Save uploaded video to a temp file ────────────────────────────────────
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    import tempfile as _tempfile
    with _tempfile.NamedTemporaryFile(
        dir=str(upload_dir), suffix=suffix, delete=False
    ) as tmp:
        video_tmp_path = tmp.name
        tmp.write(await file.read())

    meta_data: dict = {
        "capture_mode": "video_upload",
        "filename": file.filename,
        "platform": platform,
        "page_url": page_url,
        "title": title,
    }

    analysis = MediaAnalysis(
        user_id=current_user.id,
        platform=platform,
        page_url=page_url,
        title=title,
        capture_mode="video_upload",
        meta=meta_data,
        verdict="PENDING",
        score=0.0,
    )
    db.add(analysis)
    db.commit()
    db.refresh(analysis)

    try:
        # ── Extract frames from video as JPEG bytes ────────────────────────────
        import cv2 as _cv2
        cap = _cv2.VideoCapture(video_tmp_path)
        src_fps = cap.get(_cv2.CAP_PROP_FPS) or 25.0
        from scripts.wav2lip_config import WAV2LIP_FPS as _TARGET_FPS
        step = max(1, int(src_fps / _TARGET_FPS))
        frames_for_cv = []
        idx = 0
        while cap.isOpened():
            cap.set(_cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                break
            ret, buf = _cv2.imencode(".jpg", frame, [_cv2.IMWRITE_JPEG_QUALITY, 90])
            if ret:
                frames_for_cv.append((f"frame_{idx:06d}.jpg", bytes(buf)))
            idx += step
        cap.release()

        if not frames_for_cv:
            raise ValueError("no_frames_extracted_from_video")

        # ── opencv_pipeline: face detection + quality gating ──────────────────
        opencv_summary = process_frames_for_sequence(
            analysis_id=analysis.id,
            frames=frames_for_cv,
            uploads_dir=str(upload_dir),
            sequence_length=ALT_ANALYSIS_SEQUENCE_LENGTH,
            save_crops=True,
        )

        per_frame   = opencv_summary.get("per_frame", []) if isinstance(opencv_summary, dict) else []
        total_frames  = int(opencv_summary.get("frames_total", 0) or 0)
        frames_with_face = int(opencv_summary.get("frames_with_face", 0) or 0)
        seq_frames    = int(opencv_summary.get("sequence_frames_used", 0) or 0)

        reject_reasons: dict = {}
        blur_used:   list = []
        bright_used: list = []
        for pf in per_frame:
            if not isinstance(pf, dict):
                continue
            if pf.get("used") is True:
                if pf.get("blur_var") is not None:
                    blur_used.append(float(pf["blur_var"]))
                if pf.get("brightness") is not None:
                    bright_used.append(float(pf["brightness"]))
            else:
                r = pf.get("reason") or "unknown"
                reject_reasons[r] = reject_reasons.get(r, 0) + 1

        avg_blur       = sum(blur_used) / len(blur_used) if blur_used else 0.0
        avg_brightness = sum(bright_used) / len(bright_used) if bright_used else 0.0
        usable_ratio   = (seq_frames / total_frames) if total_frames else 0.0

        MIN_SEQUENCE_FRAMES = 6
        MIN_USABLE_RATIO    = 0.10
        MIN_AVG_BLUR        = 2.0
        MIN_AVG_BRIGHTNESS  = 15.0

        quality_pass = True
        quality_fail_reasons = []
        if seq_frames < MIN_SEQUENCE_FRAMES:
            quality_pass = False
            quality_fail_reasons.append(f"too_few_sequence_frames:{seq_frames}")
        if usable_ratio < MIN_USABLE_RATIO:
            quality_pass = False
            quality_fail_reasons.append(f"usable_ratio_too_low:{usable_ratio:.2f}")
        if avg_blur < MIN_AVG_BLUR:
            quality_pass = False
            quality_fail_reasons.append(f"avg_blur_too_low:{avg_blur:.2f}")
        if avg_brightness < MIN_AVG_BRIGHTNESS:
            quality_pass = False
            quality_fail_reasons.append(f"avg_brightness_too_low:{avg_brightness:.2f}")

        meta_data["opencv"] = opencv_summary
        track_summary    = opencv_summary.get("track_summary", {}) if isinstance(opencv_summary, dict) else {}
        stability_meta   = opencv_summary.get("stability", {}) if isinstance(opencv_summary, dict) else {}
        track_gap_count  = int(track_summary.get("gap_count", 0) or 0)
        geometry_rejected_count = sum(
            v for k, v in reject_reasons.items()
            if isinstance(k, str) and "geometry_rejected" in k
        )
        quality_gate = {
            "pass":                   quality_pass,
            "fail_reasons":           quality_fail_reasons,
            "frames_total":           total_frames,
            "frames_with_face":       frames_with_face,
            "sequence_frames_used":   seq_frames,
            "usable_ratio":           usable_ratio,
            "avg_blur":               avg_blur,
            "avg_brightness":         avg_brightness,
            "reject_reasons":         reject_reasons,
            "track_gap_count":        track_gap_count,
            "geometry_rejected_count": geometry_rejected_count,
            "sequence_stable":        stability_meta.get("stable", True),
            # Include full opencv stability metrics for Rule 5.8
            # (avg_iou, max_centre_drift, size_consistency)
            "stability":              stability_meta,
            "thresholds": {
                "MIN_SEQUENCE_FRAMES": MIN_SEQUENCE_FRAMES,
                "MIN_USABLE_RATIO":    MIN_USABLE_RATIO,
                "MIN_AVG_BLUR":        MIN_AVG_BLUR,
                "MIN_AVG_BRIGHTNESS":  MIN_AVG_BRIGHTNESS,
            },
        }
        meta_data["quality_gate"] = quality_gate

        # ── AltFreezing visual verdict ─────────────────────────────────────────
        if not quality_pass:
            alt_result = {
                "ok": False, "error": "quality_gate_failed",
                "video_score": None, "frames_used": seq_frames,
                "sequence_length": opencv_summary.get("sequence_length", 16), "per_frame": [],
            }
        else:
            alt_result = altfreezing_service.predict_from_sequence(
                analysis_id=analysis.id,
                uploads_dir=upload_dir,
                sequence_length=ALT_ANALYSIS_SEQUENCE_LENGTH,
                weights_path="checkpoints/model.pth",
            )

        alt_score = alt_result.get("video_score")
        visual_decision = _decide_altfreezing_verdict(alt_score, quality_gate, alt_result)
        crop_paths = opencv_summary.get("sequence_crop_paths") or []
        vit_result = (
            vit_service.predict_from_crops(crop_paths)
            if crop_paths
            else {
                "ok": False,
                "error": "no_sequence_crops",
                "video_score": None,
                "frames_used": 0,
                "per_frame": [],
                "model_name": "ViT",
            }
        )
        meta_data["vit"] = vit_result
        xception_result = xception_service.predict_from_analysis(
            analysis_id=analysis.id,
            uploads_dir=upload_dir,
            max_frames=8,
            aggregation="mean",
            threshold=0.5,
        )
        meta_data["xception"] = xception_result

        # ── Wav2Lip audio-visual sync scoring ─────────────────────────────────
        wav2lip_result = wav2lip_service.wav2lip_sync_score(
            video_path=video_tmp_path,
            weights_path="checkpoints/wav2lip_gan.pth",
        )
        meta_data["wav2lip"] = wav2lip_result

        # ── Combined verdict ───────────────────────────────────────────────────
        def _reasoning_meta(dp: dict, ar: dict, vr: dict, xr: dict) -> dict:
            calibration = (ar or {}).get("calibration") or {}
            return {
                "verdict":            dp.get("final_verdict"),
                "final_verdict":      dp.get("final_verdict"),
                "score":              dp.get("final_score", dp.get("score")),
                "raw_score":          dp.get("raw_score"),
                "confidence":         dp.get("confidence"),
                "reason":             dp.get("reason"),
                "quality_band":       dp.get("quality_band"),
                "usable_frames":      seq_frames,
                "usable_ratio":       usable_ratio,
                "temporal_diversity": dp.get("temporal_diversity", calibration.get("temporal_diversity")),
                "duplicate_frames":   reject_reasons.get("duplicate_frame", 0),
                "stability":          stability_meta.get("stable"),
                "drift":              stability_meta.get("max_centre_drift"),
                "blur":               avg_blur,
                "brightness":         avg_brightness,
                "fail_reasons":       quality_fail_reasons,
                "high_frame_count":   dp.get("high_frame_count", (ar or {}).get("high_frame_count")),
                "score_std":          dp.get("score_std", (ar or {}).get("score_std")),
                "total_windows":      dp.get("total_windows", (ar or {}).get("total_windows")),
                "temporal_penalty":   dp.get("temporal_penalty"),
                "evidence_quality":   dp.get("evidence_quality", calibration.get("evidence_quality")),
                "evidence_strength":  dp.get("evidence_strength"),
                "vit_score":          dp.get("vit_score", (vr or {}).get("video_score")),
                "xception_score":     dp.get("xception_score", (xr or {}).get("video_score")),
                "wav2lip_score":      dp.get("wav2lip_score"),
                "disagreement_flag":  dp.get("disagreement_flag"),
            }

        combined_decision = _combine_model_signals(
            visual_decision,
            alt_result,
            vit_result,
            xception_result,
            wav2lip_result,
            quality_gate,
        )
        combined_decision["final_explanation"] = combined_decision.get("explanation") or generate_verdict_reason(
            _reasoning_meta(combined_decision, alt_result, vit_result, xception_result)
        )
        combined_decision["verdict_reason"] = combined_decision["final_explanation"]

        analysis.score   = float(combined_decision.get("score") or 0.0)
        analysis.verdict = combined_decision["final_verdict"]
        analysis.status  = "DONE"
        analysis.completed_at = datetime.utcnow()

        meta_data["altfreezing"] = alt_result
        meta_data["decision"]    = combined_decision
        analysis.meta = meta_data
        _persist_model_runs(
            db,
            analysis,
            alt_result=alt_result,
            visual_decision=visual_decision,
            vit_result=vit_result,
            xception_result=xception_result,
            wav2lip_result=wav2lip_result,
        )
        db.commit()

        try:
            _maybe_insert_blocklist(analysis, db)
        except Exception as e:
            print(f"[Blocklist] Failed to auto-insert: {e}")

        _prune_analysis_uploads(analysis.id)

        return {
            "ok":          True,
            "analysis_id": analysis.id,
            "verdict":     analysis.verdict,
            "score":       analysis.score,
            "final_score": combined_decision.get("final_score", analysis.score),
            "status":      analysis.status,
            "confidence":  combined_decision.get("confidence"),
            "reason":      combined_decision.get("final_explanation"),
            "signals":     combined_decision.get("signals"),
            "weights_used": combined_decision.get("weights_used"),
            "sync_score":  wav2lip_result.get("sync_score"),
            "sync_interpretation": wav2lip_result.get("interpretation"),
            "combined_reason": combined_decision.get("combined_reason"),
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        analysis.verdict = "INCONCLUSIVE"
        analysis.status  = "ERROR"
        analysis.meta    = {**meta_data, "error": str(e)}
        db.commit()
        raise HTTPException(status_code=500, detail=f"Video analysis failed: {e}")

    finally:
        try:
            os.remove(video_tmp_path)
        except Exception:
            pass


@app.post("/api/analysis/capture")
async def capture_analysis(
    request: Request,
    meta: str = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    form_data = await request.form()
    files = form_data.getlist("files")
    if not files:
        single_file = form_data.get("file")
        files = [single_file] if single_file else []

    if not files:
        raise HTTPException(status_code=400, detail="No media files uploaded")

    # Optional audio blob sent by the extension when it uses offscreen capture
    audio_upload = form_data.get("audio")
    print(
        f"[Capture] Received request: frames={len(files)} "
        f"audio_present={audio_upload is not None} "
        f"field_names={list(form_data.keys())}"
    )

    try:
        meta_data = json.loads(meta)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid meta JSON: {e}")

    received_count = len(files)
    capture_mode = meta_data.get("capture_mode") or ("multi_frame" if received_count > 1 else "single_screenshot")
    meta_data["capture_mode"] = capture_mode
    meta_data["frame_count"] = received_count or meta_data.get("frame_count") or 0

    extension_version = meta_data.get("extension_version")
    user_agent = meta_data.get("user_agent")

    viewport = meta_data.get("viewport") or {}
    viewport_w = viewport.get("w") if isinstance(viewport, dict) else None
    viewport_h = viewport.get("h") if isinstance(viewport, dict) else None

    _captured_at_raw = meta_data.get("captured_at")
    try:
        captured_at_client = (
            datetime.fromisoformat(_captured_at_raw.replace("Z", "+00:00")).replace(tzinfo=None)
            if _captured_at_raw else None
        )
    except (ValueError, AttributeError):
        captured_at_client = None

    frame_count = meta_data.get("frame_count") or (len(files) if files else None)
    frame_interval_ms = meta_data.get("frame_interval_ms")

    analysis = MediaAnalysis(
        user_id=current_user.id,
        platform=meta_data.get("platform"),
        page_url=meta_data.get("page_url"),
        video_id=meta_data.get("video_id"),
        title=meta_data.get("title"),
        content_url=meta_data.get("content_url"),
        capture_mode=capture_mode,
        extension_version=extension_version,
        user_agent=user_agent,
        viewport_w=viewport_w,
        viewport_h=viewport_h,
        captured_at_client=captured_at_client,
        video_ts_ms=int((meta_data.get("video_ts") or 0) * 1000),
        frame_count=frame_count,
        frame_interval_ms=frame_interval_ms,
        meta=meta_data,
        verdict="PENDING",
        score=0.0,
    )

    db.add(analysis)
    db.commit()
    db.refresh(analysis)

    upload_dir = Path(__file__).resolve().parent / "uploads"
    raw_dir = upload_dir / f"{analysis.id}_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    frames_for_cv = []
    for idx, file in enumerate(files):
        content = await file.read()
        orig_name = file.filename or f"frame_{idx}.jpg"
        file_path = raw_dir / orig_name
        with open(file_path, "wb") as f:
            f.write(content)
        frames_for_cv.append((orig_name, content))

    opencv_summary = process_frames_for_sequence(
        analysis_id=analysis.id,
        frames=frames_for_cv,
        uploads_dir=str(upload_dir),
        sequence_length=ALT_ANALYSIS_SEQUENCE_LENGTH,
        save_crops=True,
    )

    per_frame = opencv_summary.get("per_frame", []) if isinstance(opencv_summary, dict) else []
    total_frames = int(opencv_summary.get("frames_total", 0) or 0)
    frames_with_face = int(opencv_summary.get("frames_with_face", 0) or 0)
    seq_frames = int(opencv_summary.get("sequence_frames_used", 0) or 0)

    reject_reasons = {}
    blur_used = []
    bright_used = []
    for pf in per_frame:
        if not isinstance(pf, dict):
            continue
        if pf.get("used") is True:
            if pf.get("blur_var") is not None:
                blur_used.append(float(pf["blur_var"]))
            if pf.get("brightness") is not None:
                bright_used.append(float(pf["brightness"]))
        else:
            r = pf.get("reason") or "unknown"
            reject_reasons[r] = reject_reasons.get(r, 0) + 1

    avg_blur = sum(blur_used) / len(blur_used) if blur_used else 0.0
    avg_brightness = sum(bright_used) / len(bright_used) if bright_used else 0.0
    usable_ratio = (seq_frames / total_frames) if total_frames else 0.0

    # Quality gate — lowered thresholds for browser canvas JPEG captures.
    # Original values (MIN_AVG_BLUR=8, MIN_AVG_BRIGHTNESS=25) were calibrated
    # for clean video files. Browser captures at JPEG quality 0.8 have lower
    # Laplacian variance and can have lower brightness on dark-background sets.
    MIN_SEQUENCE_FRAMES = 6     # was 8  — let short captures through
    MIN_USABLE_RATIO    = 0.10  # was 0.2 — 10% usable frames is enough to try
    MIN_AVG_BLUR        = 2.0   # was 8.0 — browser JPEG reduces sharpness
    MIN_AVG_BRIGHTNESS  = 15.0  # was 25.0 — dark studio lighting is common

    quality_pass = True
    quality_fail_reasons = []
    if seq_frames < MIN_SEQUENCE_FRAMES:
        quality_pass = False
        quality_fail_reasons.append(f"too_few_sequence_frames:{seq_frames}")
    if usable_ratio < MIN_USABLE_RATIO:
        quality_pass = False
        quality_fail_reasons.append(f"usable_ratio_too_low:{usable_ratio:.2f}")
    if avg_blur < MIN_AVG_BLUR:
        quality_pass = False
        quality_fail_reasons.append(f"avg_blur_too_low:{avg_blur:.2f}")
    if avg_brightness < MIN_AVG_BRIGHTNESS:
        quality_pass = False
        quality_fail_reasons.append(f"avg_brightness_too_low:{avg_brightness:.2f}")

    meta_data["opencv"] = opencv_summary
    track_summary = opencv_summary.get("track_summary", {}) if isinstance(opencv_summary, dict) else {}
    stability_meta = opencv_summary.get("stability", {}) if isinstance(opencv_summary, dict) else {}
    track_gap_count = int(track_summary.get("gap_count", 0) or 0)
    geometry_rejected_count = sum(
        v for k, v in reject_reasons.items()
        if isinstance(k, str) and "geometry_rejected" in k
    )
    meta_data["quality_gate"] = {
        "pass": quality_pass,
        "fail_reasons": quality_fail_reasons,
        "frames_total": total_frames,
        "frames_with_face": frames_with_face,
        "sequence_frames_used": seq_frames,
        "usable_ratio": usable_ratio,
        "avg_blur": avg_blur,
        "avg_brightness": avg_brightness,
        "reject_reasons": reject_reasons,
        "track_gap_count": track_gap_count,
        "geometry_rejected_count": geometry_rejected_count,
        "sequence_stable": stability_meta.get("stable", True),
        # Full stability metrics needed by _classify_video_context and _apply_uncertainty_cascade
        "stability": stability_meta,
        "thresholds": {
            "MIN_SEQUENCE_FRAMES": MIN_SEQUENCE_FRAMES,
            "MIN_USABLE_RATIO": MIN_USABLE_RATIO,
            "MIN_AVG_BLUR": MIN_AVG_BLUR,
            "MIN_AVG_BRIGHTNESS": MIN_AVG_BRIGHTNESS,
        },
    }

    crop_paths = opencv_summary.get("sequence_crop_paths") or []
    vit_result = (
        vit_service.predict_from_crops(crop_paths)
        if quality_pass and crop_paths
        else {
            "ok": False,
            "error": "quality_gate_failed" if not quality_pass else "no_sequence_crops",
            "video_score": None,
            "frames_used": 0,
            "per_frame": [],
            "model_name": "ViT",
        }
    )
    meta_data["vit"] = vit_result
    xception_result = (
        xception_service.predict_from_analysis(
            analysis_id=analysis.id,
            uploads_dir=upload_dir,
            max_frames=8,
            aggregation="mean",
            threshold=0.5,
        )
        if quality_pass
        else {
            "ok": False,
            "error": "quality_gate_failed",
            "video_score": None,
            "frames_used": 0,
            "per_frame": [],
            "model_name": "Xception",
        }
    )
    meta_data["xception"] = xception_result

    def _reasoning_metadata_for(decision_payload: dict, alt_payload: dict, vit_payload: dict, xception_payload: dict) -> dict:
        calibration = (alt_payload or {}).get("calibration") or {}
        return {
            "verdict": decision_payload.get("final_verdict"),
            "final_verdict": decision_payload.get("final_verdict"),
            "score": decision_payload.get("final_score", decision_payload.get("score")),
            "raw_score": decision_payload.get("raw_score"),
            "confidence": decision_payload.get("confidence"),
            "reason": decision_payload.get("reason"),
            "quality_band": decision_payload.get("quality_band"),
            "usable_frames": seq_frames,
            "usable_ratio": usable_ratio,
            "temporal_diversity": decision_payload.get("temporal_diversity", calibration.get("temporal_diversity")),
            "duplicate_frames": reject_reasons.get("duplicate_frame", 0),
            "stability": stability_meta.get("stable"),
            "drift": stability_meta.get("max_centre_drift"),
            "blur": avg_blur,
            "brightness": avg_brightness,
            "fail_reasons": quality_fail_reasons,
            "high_frame_count": decision_payload.get("high_frame_count", (alt_payload or {}).get("high_frame_count")),
            "score_std": decision_payload.get("score_std", (alt_payload or {}).get("score_std")),
            "total_windows": decision_payload.get("total_windows", (alt_payload or {}).get("total_windows")),
            "temporal_penalty": decision_payload.get("temporal_penalty"),
            "evidence_quality": decision_payload.get("evidence_quality", calibration.get("evidence_quality")),
            "evidence_strength": decision_payload.get("evidence_strength"),
            "vit_score": decision_payload.get("vit_score", (vit_payload or {}).get("video_score")),
            "xception_score": decision_payload.get("xception_score", (xception_payload or {}).get("video_score")),
            "wav2lip_score": decision_payload.get("wav2lip_score"),
            "disagreement_flag": decision_payload.get("disagreement_flag"),
        }

    if not quality_pass:
        alt_result = {
            "ok": False,
            "error": "quality_gate_failed",
            "video_score": None,
            "frames_used": seq_frames,
            "sequence_length": opencv_summary.get("sequence_length", 16),
            "per_frame": [],
        }
        decision = _decide_altfreezing_verdict(None, meta_data["quality_gate"], alt_result)
        decision["signals"] = {
            "altfreezing": None,
            "vit": _clamp01(vit_result.get("video_score")) if vit_result.get("ok") else None,
            "xception": _clamp01(xception_result.get("video_score")) if xception_result.get("ok") else None,
            "wav2lip": None,
        }
        decision["final_score"] = 0.0
        decision["vit_score"] = decision["signals"]["vit"]
        decision["xception_score"] = decision["signals"]["xception"]
        decision["wav2lip_score"] = None
        decision["disagreement_flag"] = False
        decision["weights_used"] = {"altfreezing": 0.40, "wav2lip": 0.25, "vit": 0.15, "xception": 0.20}
        decision["final_explanation"] = generate_verdict_reason(_reasoning_metadata_for(decision, alt_result, vit_result, xception_result))
        decision["verdict_reason"] = decision["final_explanation"]
        analysis.score = 0.0
        analysis.verdict = decision["final_verdict"]
        analysis.status = "DONE"
        analysis.completed_at = datetime.utcnow()
        meta_data["altfreezing"] = alt_result
        meta_data["decision"] = decision
        analysis.meta = meta_data
        _persist_model_runs(
            db,
            analysis,
            alt_result=alt_result,
            visual_decision=decision,
            vit_result=vit_result,
            xception_result=xception_result,
            wav2lip_result={"ok": False, "error": "skipped_due_to_quality_gate", "sync_score": None, "interpretation": "unavailable", "confidence": "low"},
        )
        db.commit()
        return {
            "ok": True,
            "analysis_id": analysis.id,
            "verdict": analysis.verdict,
            "score": analysis.score,
            "final_score": decision.get("final_score", analysis.score),
            "status": analysis.status,
            "confidence": decision.get("confidence"),
            "reason": decision.get("final_explanation"),
            "signals": decision.get("signals"),
            "weights_used": decision.get("weights_used"),
        }

    alt_result = altfreezing_service.predict_from_sequence(
        analysis_id=analysis.id,
        uploads_dir=upload_dir,
        sequence_length=ALT_ANALYSIS_SEQUENCE_LENGTH,
        weights_path="checkpoints/model.pth",
    )

    # ── Wav2Lip audio-visual sync (only when extension sent audio) ────────────
    wav2lip_result = {"ok": False, "error": "no_audio_uploaded", "sync_score": None, "interpretation": "unavailable"}
    audio_debug = {
        "uploaded": audio_upload is not None,
        "filename": getattr(audio_upload, "filename", None) if audio_upload is not None else None,
        "content_type": getattr(audio_upload, "content_type", None) if audio_upload is not None else None,
        "byte_size": 0,
        "saved_path": None,
    }
    if audio_upload is not None:
        audio_content = await audio_upload.read()
        audio_debug["byte_size"] = len(audio_content)
        print(
            f"[Capture][Audio] Received audio upload: "
            f"filename={audio_debug['filename']} "
            f"content_type={audio_debug['content_type']} "
            f"bytes={audio_debug['byte_size']}"
        )
        audio_tmp_path = None
        try:
            suffix = Path(audio_upload.filename or "audio.webm").suffix or ".webm"
            audio_tmp_path = upload_dir / f"{analysis.id}_audio{suffix}"
            with open(audio_tmp_path, "wb") as f:
                f.write(audio_content)
            audio_debug["saved_path"] = str(audio_tmp_path)
            seq_dir = upload_dir / f"{analysis.id}_seq"
            wav2lip_result = wav2lip_service.wav2lip_sync_score(
                frames_dir=str(seq_dir),
                audio_path=str(audio_tmp_path),
                weights_path="checkpoints/wav2lip_gan.pth",
            )
            print(
                f"[Capture][Audio] Wav2Lip invoked with audio_path={audio_debug['saved_path']} "
                f"ok={wav2lip_result.get('ok')} interpretation={wav2lip_result.get('interpretation')}"
            )
        except Exception as _e:
            wav2lip_result = {"ok": False, "error": f"wav2lip_error:{_e}", "sync_score": None, "interpretation": "unavailable"}
            print(f"[Capture][Audio] Wav2Lip failed: {_e}")
        if audio_debug["byte_size"] == 0:
            wav2lip_result = {"ok": False, "error": "empty_audio_uploaded", "sync_score": None, "interpretation": "unavailable"}
            print("[Capture][Audio] Audio upload existed but contained 0 bytes.")
    else:
        print("[Capture][Audio] No audio file was included in the multipart request.")
    meta_data["audio_debug"] = audio_debug
    meta_data["wav2lip"] = wav2lip_result

    # ── Combine visual + sync verdicts ────────────────────────────────────────
    score = alt_result.get("video_score")
    visual_decision = _decide_altfreezing_verdict(score, meta_data["quality_gate"], alt_result)
    decision = _combine_model_signals(
        visual_decision,
        alt_result,
        vit_result,
        xception_result,
        wav2lip_result,
        meta_data["quality_gate"],
    )
    decision["final_explanation"] = decision.get("explanation") or generate_verdict_reason(_reasoning_metadata_for(decision, alt_result, vit_result, xception_result))
    decision["verdict_reason"] = decision["final_explanation"]

    analysis.score = float(decision.get("score")) if decision.get("score") is not None else 0.0
    analysis.verdict = decision["final_verdict"]
    analysis.status = "DONE"
    analysis.completed_at = datetime.utcnow()

    meta_data["altfreezing"] = alt_result
    meta_data["decision"] = decision
    analysis.meta = meta_data
    _persist_model_runs(
        db,
        analysis,
        alt_result=alt_result,
        visual_decision=visual_decision,
        vit_result=vit_result,
        xception_result=xception_result,
        wav2lip_result=wav2lip_result,
    )
    db.commit()

    # Auto-insert into global blocklist when result meets the risk threshold
    try:
        _maybe_insert_blocklist(analysis, db)
    except Exception as e:
        print(f"[Blocklist] Failed to auto-insert: {e}")

    _prune_analysis_uploads(analysis.id)

    return {
        "ok": True,
        "analysis_id": analysis.id,
        "verdict": analysis.verdict,
        "score": analysis.score,
        "final_score": decision.get("final_score", analysis.score),
        "status": analysis.status,
        "confidence": decision.get("confidence"),
        "reason": decision.get("final_explanation"),
        "signals": decision.get("signals"),
        "weights_used": decision.get("weights_used"),
        "sync_score": wav2lip_result.get("sync_score"),
        "sync_interpretation": wav2lip_result.get("interpretation"),
        "combined_reason": decision.get("combined_reason"),
    }


# ─── Blocklist Policy ────────────────────────────────────────────────────────
BLOCKLIST_RISK_THRESHOLD = int(os.getenv("BLOCKLIST_RISK_THRESHOLD", "70"))

def _maybe_insert_blocklist(analysis: MediaAnalysis, db: Session):
    """Insert into global_blocklist only when the result is strong enough."""
    score_pct = round(float(analysis.score or 0) * 100)
    verdict = (analysis.verdict or "").upper()

    if verdict not in ("FAKE", "SUSPICIOUS") or score_pct < BLOCKLIST_RISK_THRESHOLD:
        return  # Not strong enough — skip

    # Build a stable fingerprint from what we know:
    # Prefer video_id (most stable), else hash of page_url
    raw_key = analysis.video_id or analysis.page_url or analysis.content_url or str(analysis.id)
    fingerprint = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:64]

    # Avoid duplicate entries
    existing = db.query(GlobalBlocklist).filter(
        GlobalBlocklist.fingerprint_hash == fingerprint
    ).first()
    if existing:
        return

    risk_score = max(score_pct, BLOCKLIST_RISK_THRESHOLD)
    risk_level = "High" if risk_score >= 70 else "Medium"

    entry = GlobalBlocklist(
        fingerprint_hash=fingerprint,
        source_url=analysis.page_url or analysis.content_url,
        video_id=analysis.video_id,
        platform=analysis.platform,
        title=analysis.title,
        verdict=verdict,
        risk_score=risk_score,
        risk_level=risk_level,
        analysis_id=analysis.id,
        status="active",
    )
    db.add(entry)
    db.commit()

@app.get("/api/history")
@app.get("/api/analysis")
def list_user_analyses(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    analyses = (
        db.query(MediaAnalysis)
        .filter(MediaAnalysis.user_id == current_user.id)
        .order_by(MediaAnalysis.created_at.desc())
        .all()
    )
    return {"ok": True, "data": [_serialize_analysis(a) for a in analyses]}


@app.get("/api/analysis/stats")
def get_user_analysis_stats(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    total = db.query(MediaAnalysis).filter(MediaAnalysis.user_id == current_user.id).count()
    fake = db.query(MediaAnalysis).filter(
        MediaAnalysis.user_id == current_user.id,
        MediaAnalysis.verdict.in_(["FAKE", "SUSPICIOUS"])
    ).count()
    real = db.query(MediaAnalysis).filter(
        MediaAnalysis.user_id == current_user.id,
        MediaAnalysis.verdict == "REAL"
    ).count()

    return {
        "ok": True,
        "stats": {
            "totalScans": total,
            "threatsBlocked": fake,
            "trustedMedia": real,
            "queueReview": 0
        }
    }


@app.delete("/api/history/clear")
def clear_user_history(db: Session = Depends(get_db), current_user: User = Depends(get_portal_user)):
    analyses = (
        db.query(MediaAnalysis)
        .filter(MediaAnalysis.user_id == current_user.id)
        .all()
    )

    deleted_count, files_removed = _delete_analysis_records(db, analyses, current_user.id)
    return {
        "ok": True,
        "deleted": deleted_count,
        "files_removed": files_removed,
        "message": "Detection history cleared." if deleted_count else "Detection history is already empty.",
    }


@app.delete("/api/history/{analysis_id}")
@app.delete("/api/analysis/{analysis_id}")
def delete_user_history_item(analysis_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_portal_user)):
    analysis = _get_user_analysis_or_404(db, current_user.id, analysis_id)
    deleted_count, files_removed = _delete_analysis_records(db, [analysis], current_user.id)
    return {
        "ok": True,
        "deleted": deleted_count,
        "files_removed": files_removed,
        "message": "Detection record deleted.",
    }


@app.get("/api/analysis/{analysis_id}")
def get_user_analysis(analysis_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    analysis = _get_user_analysis_or_404(db, current_user.id, analysis_id)
    return {"ok": True, "data": _serialize_analysis(analysis, include_model_runs=True)}

@app.get("/api/analysis/{analysis_id}/preview")
def get_user_analysis_preview(analysis_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    analysis = _get_user_analysis_or_404(db, current_user.id, analysis_id)

    upload_dir = _uploads_root()
    raw_dir = upload_dir / f"{analysis.id}_raw"

    if raw_dir.exists() and raw_dir.is_dir():
        files = list(raw_dir.glob("*.jpg"))
        if files:
            # Sort to ensure we get frame_0 / frame_000
            files.sort()
            return FileResponse(files[0])

    raise HTTPException(status_code=404, detail="Preview image not available")


# ─── Blocklist API Endpoints ─────────────────────────────────────────────────

@app.get("/api/blocklist/sync")
def sync_blocklist(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Extension-facing endpoint: return all active blocklist fingerprints + video IDs for local sync."""
    entries = (
        db.query(GlobalBlocklist)
        .filter(GlobalBlocklist.status == "active")
        .order_by(GlobalBlocklist.created_at.desc())
        .all()
    )
    return {
        "ok": True,
        "count": len(entries),
        "entries": [
            {
                "fingerprint_hash": e.fingerprint_hash,
                "video_id": e.video_id,
                "source_url": e.source_url,
                "platform": e.platform,
                "title": e.title,
                "verdict": e.verdict,
                "risk_score": e.risk_score,
                "risk_level": e.risk_level,
                "status": e.status,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in entries
        ]
    }


@app.get("/api/blocklist")
def list_blocklist(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Portal-facing authenticated endpoint: full blocklist with analysis source info."""
    entries = (
        db.query(GlobalBlocklist)
        .filter(GlobalBlocklist.status == "active")
        .order_by(GlobalBlocklist.created_at.desc())
        .all()
    )
    return {
        "ok": True,
        "data": [_serialize_blocklist_entry(e) for e in entries]
    }


@app.delete("/api/blocklist/{entry_id}")
def remove_blocklist_entry(entry_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_portal_user)):
    entry = (
        db.query(GlobalBlocklist)
        .filter(
            GlobalBlocklist.id == entry_id,
            GlobalBlocklist.status == "active",
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Blocklist entry not found")

    entry.status = "unblocked"
    entry.updated_at = _utcnow()
    db.commit()
    db.refresh(entry)

    return {
        "ok": True,
        "message": "Media removed from the blocklist.",
        "data": _serialize_blocklist_entry(entry),
    }


@app.post("/api/blocklist/check")
def check_blocklist(payload: dict, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Check one or more fingerprint_hashes/video_ids against the active blocklist."""
    hashes = payload.get("hashes", [])
    video_ids = [v for v in payload.get("video_ids", []) if v]

    matched_hashes = set()
    matched_video_ids = set()

    if hashes:
        rows = db.query(GlobalBlocklist.fingerprint_hash).filter(
            GlobalBlocklist.fingerprint_hash.in_(hashes),
            GlobalBlocklist.status == "active"
        ).all()
        matched_hashes = {r[0] for r in rows}

    if video_ids:
        rows = db.query(GlobalBlocklist.video_id).filter(
            GlobalBlocklist.video_id.in_(video_ids),
            GlobalBlocklist.status == "active"
        ).all()
        matched_video_ids = {r[0] for r in rows if r[0]}

    return {
        "ok": True,
        "matched_hashes": list(matched_hashes),
        "matched_video_ids": list(matched_video_ids),
    }