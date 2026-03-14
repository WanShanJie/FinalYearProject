import os
import secrets
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile, File, Form, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from dotenv import load_dotenv
from starlette.middleware.sessions import SessionMiddleware
from jose import jwt, JWTError

from db import SessionLocal, engine, Base
from models import User, OAuthAccount, PasswordReset, MfaChallenge, EmailVerification, TrustedDevice, MediaAnalysis
from schemas import RegisterIn, LoginIn, UserOut, ForgotPasswordIn, ResetPasswordIn, MfaVerifyIn, VerifyEmailOtpIn
from auth import hash_password, verify_password, create_token
from oauth_routes import router as oauth_router
from password_reset import make_reset_token, hash_token, expires_at_dt
from email_utils import send_reset_email, send_mfa_code, send_email_verification_code
from typing import List, Optional

from opencv_pipeline import process_frames_for_sequence
import os as _os
# Force UTF-8 output so AltFreezing's logger doesn't crash on Windows
_os.environ.setdefault("PYTHONUTF8", "1")
from scripts import altfreezing_service

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

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    from auth import SECRET_KEY, ALGORITHM
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str = payload.get("sub")
        if user_id_str is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = int(user_id_str)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def get_optional_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    if not token:
        return None
    try:
        from auth import SECRET_KEY, ALGORITHM
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get("sub"))
        return db.query(User).filter(User.id == user_id).first()
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
        trusted_until=expires_at_dt(),
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




def _decide_altfreezing_verdict(score: Optional[float], quality_gate: dict, alt_result: dict) -> dict:
    if score is None:
        return {
            "final_verdict": "INCONCLUSIVE",
            "model_verdict": "INCONCLUSIVE",
            "reason": alt_result.get("error") or "no_score",
            "confidence": "low",
            "quality_band": "weak",
            "high_frame_count": 0,
            "score_std": None,
            "score": None,
            "raw_score": None,
        }

    avg_blur = float(quality_gate.get("avg_blur") or 0.0)
    avg_brightness = float(quality_gate.get("avg_brightness") or 0.0)
    usable_ratio = float(quality_gate.get("usable_ratio") or 0.0)
    seq_frames = int(quality_gate.get("sequence_frames_used") or 0)

    score_std = alt_result.get("score_std")
    high_frame_count = int(alt_result.get("high_frame_count") or 0)
    raw_score = float(alt_result.get("raw_video_score", score))

    calibration = alt_result.get("calibration") or {}
    evidence_quality = float(calibration.get("evidence_quality") or 0.0)
    diversity_quality = float(calibration.get("diversity_quality") or 0.0)
    temporal_diversity = float(calibration.get("temporal_diversity") or 0.0)

    quality_band = "strong" if (avg_blur >= 20.0 and usable_ratio >= 0.65 and seq_frames >= 24) else "weak"

    # Stable bright talking-head override.
    # Real interview/news clips can get inflated raw scores from the pretrained model.
    if (
        quality_band == "strong"
        and avg_brightness >= 80.0
        and evidence_quality >= 0.82
        and seq_frames >= 24
        and temporal_diversity <= 0.08
        and raw_score < 0.97
    ):
        return {
            "final_verdict": "REAL",
            "model_verdict": "REAL",
            "reason": "stable_bright_talking_head_override",
            "confidence": "medium",
            "quality_band": quality_band,
            "high_frame_count": high_frame_count,
            "score_std": score_std,
            "score": score,
            "raw_score": raw_score,
        }

    # Very high raw score on a strong sequence -> FAKE.
    if (
        raw_score >= 0.97
        and quality_band == "strong"
        and evidence_quality >= 0.75
        and seq_frames >= 24
    ):
        return {
            "final_verdict": "FAKE",
            "model_verdict": "FAKE",
            "reason": "very_high_raw_fake_score_on_strong_sequence",
            "confidence": "high",
            "quality_band": quality_band,
            "high_frame_count": high_frame_count,
            "score_std": score_std,
            "score": score,
            "raw_score": raw_score,
        }

    if score <= 0.20 and quality_band == "strong":
        return {
            "final_verdict": "REAL",
            "model_verdict": "REAL",
            "reason": "low_fake_score_with_strong_quality",
            "confidence": "medium",
            "quality_band": quality_band,
            "high_frame_count": high_frame_count,
            "score_std": score_std,
            "score": score,
            "raw_score": raw_score,
        }

    if score >= 0.90 or raw_score >= 0.90:
        return {
            "final_verdict": "SUSPICIOUS",
            "model_verdict": "FAKE",
            "reason": "high_score_downgraded_to_suspicious",
            "confidence": "medium" if quality_band == "strong" else "low",
            "quality_band": quality_band,
            "high_frame_count": high_frame_count,
            "score_std": score_std,
            "score": score,
            "raw_score": raw_score,
        }

    if quality_band == "weak" and score >= 0.15:
        return {
            "final_verdict": "SUSPICIOUS",
            "model_verdict": "FAKE",
            "reason": "anomaly_detected_on_weak_quality_sequence",
            "confidence": "low",
            "quality_band": quality_band,
            "high_frame_count": high_frame_count,
            "score_std": score_std,
            "score": score,
            "raw_score": raw_score,
        }

    return {
        "final_verdict": "INCONCLUSIVE",
        "model_verdict": "INCONCLUSIVE",
        "reason": "score_in_uncertain_band",
        "confidence": "low",
        "quality_band": quality_band,
        "high_frame_count": high_frame_count,
        "score_std": score_std,
        "score": score,
        "raw_score": raw_score,
    }

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
        sequence_length=32,   # matches AltFreezing clip_size and DEFAULT_SEQUENCE_LENGTH
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

    MIN_SEQUENCE_FRAMES = 8
    MIN_USABLE_RATIO = 0.2
    MIN_AVG_BLUR = 8.0
    MIN_AVG_BRIGHTNESS = 25.0

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
        "thresholds": {
            "MIN_SEQUENCE_FRAMES": MIN_SEQUENCE_FRAMES,
            "MIN_USABLE_RATIO": MIN_USABLE_RATIO,
            "MIN_AVG_BLUR": MIN_AVG_BLUR,
            "MIN_AVG_BRIGHTNESS": MIN_AVG_BRIGHTNESS,
        },
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
        analysis.score = 0.0
        analysis.verdict = decision["final_verdict"]
        analysis.status = "DONE"
        analysis.completed_at = datetime.utcnow()
        meta_data["altfreezing"] = alt_result
        meta_data["decision"] = decision
        analysis.meta = meta_data
        db.commit()
        return {"ok": True, "analysis_id": analysis.id, "verdict": analysis.verdict, "score": analysis.score, "status": analysis.status}

    alt_result = altfreezing_service.predict_from_sequence(
        analysis_id=analysis.id,
        uploads_dir=upload_dir,
        sequence_length=16,
        weights_path="checkpoints/model.pth",
    )

    score = alt_result.get("video_score")
    decision = _decide_altfreezing_verdict(score, meta_data["quality_gate"], alt_result)

    analysis.score = float(score) if score is not None else 0.0
    analysis.verdict = decision["final_verdict"]
    analysis.status = "DONE"
    analysis.completed_at = datetime.utcnow()

    meta_data["altfreezing"] = alt_result
    meta_data["decision"] = decision
    analysis.meta = meta_data
    db.commit()

    return {
        "ok": True,
        "analysis_id": analysis.id,
        "verdict": analysis.verdict,
        "score": analysis.score,
        "status": analysis.status,
    }

@app.get("/api/analysis/{analysis_id}")
def get_user_analyses(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    analysis = (
        db.query(MediaAnalysis)
        .filter(
            MediaAnalysis.id == analysis_id,
            MediaAnalysis.user_id == current_user.id,
        )
        .first()
    )
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return {"ok": True, "data": serialize_analysis(analysis)}

    results = []
    for a in analyses:
        results.append({
            "id": a.id,
            "title": a.title or "Unknown Media",
            "platform": a.platform,
            "page_url": a.page_url,
            "verdict": a.verdict,
            "score": a.score,
            "status": a.status,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "meta": a.meta
        })
    return {"ok": True, "data": results}

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
            "queueReview": 0 # TODO: logic for review queue
        }
    }
