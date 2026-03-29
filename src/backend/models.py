from sqlalchemy import Column, BigInteger, String, Boolean, Integer, Float, Text, TIMESTAMP, text, ForeignKey, DateTime, JSON
from sqlalchemy.dialects.mysql import BIGINT
from db import Base
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

class User(Base):
    __tablename__ = "users"

    id = Column(BIGINT(unsigned=True), primary_key=True, index=True)
    first_name = Column(String(80), nullable=True)
    last_name = Column(String(80), nullable=True)
    email = Column(String(190), unique=True, index=True, nullable=False)
    provider = Column(String(50), nullable=False, server_default=text("'local'"))
    password_hash = Column(String(255), nullable=False)
    created_at = Column(TIMESTAMP, server_default=text("CURRENT_TIMESTAMP"))
    agreed_terms = Column(Boolean, nullable=False, server_default=text("0"))
    agreed_terms_at = Column(TIMESTAMP, nullable=True)
    terms_version = Column(String(20), nullable=True)
    privacy_version = Column(String(20), nullable=True)
    email_verified = Column(Boolean, nullable=False, server_default=text("0"))
    email_verified_at = Column(TIMESTAMP, nullable=True)

class OAuthAccount(Base):
    __tablename__ = "oauth_accounts"

    id = Column(BIGINT(unsigned=True), primary_key=True, index=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(50), nullable=False)  # "google", "x", etc.
    provider_user_id = Column(String(255), nullable=False)
    email = Column(String(190), nullable=True)
    created_at = Column(TIMESTAMP, server_default=text("CURRENT_TIMESTAMP"))

class PasswordReset(Base):
    __tablename__ = "password_resets"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)

    token_hash = Column(String(255), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)

    created_at = Column(TIMESTAMP, nullable=False, server_default=func.now())


class EmailVerification(Base):
    __tablename__ = "email_verifications"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
    token_hash = Column(String(255), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(TIMESTAMP, nullable=False, server_default=func.now())


class TrustedDevice(Base):
    __tablename__ = "trusted_devices"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False, index=True)

    # Matches MySQL schema: device_hash CHAR(64), trusted_until DATETIME
    device_hash = Column(String(64), nullable=False, index=True)  # sha256 hex
    trusted_until = Column(DateTime, nullable=False)

    created_at = Column(TIMESTAMP, nullable=False, server_default=func.now())
    last_used_at = Column(TIMESTAMP, nullable=True)


class MfaChallenge(Base):
    __tablename__ = "mfa_challenges"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False, index=True)

    # We never store the raw mfa_token or raw OTP.
    mfa_token_hash = Column(String(255), nullable=False, index=True)
    otp_hash = Column(String(255), nullable=False)

    expires_at = Column(DateTime, nullable=False)
    attempts = Column(Integer, nullable=False, server_default=text("0"))
    consumed_at = Column(DateTime, nullable=True)

    created_at = Column(TIMESTAMP, nullable=False, server_default=func.now())

# 28/2/2026 - For extension analysis
class MediaAnalysis(Base):
    __tablename__ = "media_analysis"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True, index=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id"), nullable=False)

    platform = Column(String(50))
    page_url = Column(Text)
    video_id = Column(String(255))
    title = Column(Text)

    content_url = Column(Text, nullable=True)
    capture_mode = Column(String(30), nullable=True)
    extension_version = Column(String(30), nullable=True)
    user_agent = Column(Text, nullable=True)
    viewport_w = Column(Integer, nullable=True)
    viewport_h = Column(Integer, nullable=True)

    captured_at_client = Column(DateTime(timezone=True), nullable=True)
    video_ts_ms = Column(Integer, nullable=True)

    frame_count = Column(Integer, nullable=True)
    frame_interval_ms = Column(Integer, nullable=True)

    meta = Column(JSON, nullable=True)

    verdict = Column(String(50), default="PENDING")
    score = Column(Float, default=0.0)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(String(30), default="PENDING")
    user = relationship("User")
    model_runs = relationship("ModelRun", back_populates="analysis", cascade="all, delete-orphan")


class ModelRun(Base):
    __tablename__ = "model_runs"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True, index=True)
    analysis_id = Column(BIGINT(unsigned=True), ForeignKey("media_analysis.id", ondelete="CASCADE"), nullable=False, index=True)
    model_name = Column(String(50), nullable=False, index=True)
    model_version = Column(String(255), nullable=True)
    status = Column(String(30), nullable=False, server_default=text("'PENDING'"))
    score = Column(Float, nullable=True)
    confidence = Column(String(30), nullable=True)
    verdict = Column(String(30), nullable=True)
    reason = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    run_meta = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    analysis = relationship("MediaAnalysis", back_populates="model_runs")


class ExtensionLinkRequest(Base):
    __tablename__ = "extension_link_requests"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    request_id = Column(String(128), nullable=False, unique=True, index=True)
    code_challenge = Column(String(255), nullable=False)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id"), nullable=True, index=True)
    device_name = Column(String(255), nullable=False, server_default=text("'Chrome Extension'"))
    extension_version = Column(String(50), nullable=True)
    status = Column(String(30), nullable=False, server_default=text("'pending'"))
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(TIMESTAMP, nullable=False, server_default=func.now())
    approved_at = Column(DateTime, nullable=True)
    redeemed_at = Column(DateTime, nullable=True)


class LinkedExtension(Base):
    __tablename__ = "linked_extensions"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id"), nullable=False, index=True)
    link_request_id = Column(BIGINT(unsigned=True), ForeignKey("extension_link_requests.id"), nullable=True)
    device_name = Column(String(255), nullable=False)
    extension_version = Column(String(50), nullable=True)
    token_hash = Column(String(255), nullable=False, index=True)
    last_seen_at = Column(DateTime, nullable=True)
    created_at = Column(TIMESTAMP, nullable=False, server_default=func.now())
    revoked_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, nullable=False, server_default=text("1"))

    user = relationship("User")


class GlobalBlocklist(Base):
    __tablename__ = "global_blocklist"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    fingerprint_hash = Column(String(128), nullable=False, unique=True, index=True)  # URL or media hash
    source_url = Column(Text, nullable=True)
    video_id = Column(String(255), nullable=True, index=True)
    platform = Column(String(50), nullable=True)
    title = Column(Text, nullable=True)
    verdict = Column(String(30), nullable=False, server_default=text("'FAKE'"))
    risk_score = Column(Integer, nullable=False, server_default=text("70"))
    risk_level = Column(String(20), nullable=False, server_default=text("'High'"))
    analysis_id = Column(BIGINT(unsigned=True), ForeignKey("media_analysis.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), nullable=False, server_default=text("'active'"))
    created_at = Column(TIMESTAMP, nullable=False, server_default=func.now())
    updated_at = Column(TIMESTAMP, nullable=True, onupdate=func.now())
