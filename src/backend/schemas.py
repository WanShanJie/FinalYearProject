import re
from pydantic import BaseModel, EmailStr, Field, field_validator

# Strong password rules (checked via validator, not regex pattern — pydantic-core
# uses Rust's regex engine which does not support lookaheads)
_PW_RULES = [
    (r'[a-z]',                              "at least one lowercase letter"),
    (r'[A-Z]',                              "at least one uppercase letter"),
    (r'\d',                                 "at least one digit"),
    (r'[!@#$%^&*()\-_=+\[\]{};:\'",.<>/?`~|\\]', "at least one special character"),
]

def _validate_strong_password(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters.")
    if len(v) > 72:
        raise ValueError("Password must not exceed 72 characters.")
    for pattern, desc in _PW_RULES:
        if not re.search(pattern, v):
            raise ValueError(f"Password must contain {desc}.")
    return v


class RegisterIn(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    agreed_terms: bool = False
    terms_version: str | None = None
    privacy_version: str | None = None

    @field_validator("password")
    @classmethod
    def password_strength(cls, v):
        return _validate_strong_password(v)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)
    device_id: str | None = None

class VerifyEmailOtpIn(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)
    device_id: str | None = None
    trust_device: bool | None = True

class UserOut(BaseModel):
    id: int
    email: EmailStr
    first_name: str | None = None
    last_name: str | None = None

class ForgotPasswordIn(BaseModel):
    email: EmailStr

class ResetPasswordIn(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=72)

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v):
        return _validate_strong_password(v)

class MfaVerifyIn(BaseModel):
    mfa_token: str
    code: str = Field(min_length=6, max_length=6)
    device_id: str | None = None
    trust_device: bool | None = False

class ExtensionLinkRequestIn(BaseModel):
    request_id: str = Field(min_length=8, max_length=128)
    code_challenge: str = Field(min_length=16, max_length=255)
    device_name: str | None = Field(default="Chrome Extension", max_length=255)
    extension_version: str | None = Field(default=None, max_length=50)

class ExtensionLinkApproveIn(BaseModel):
    request_id: str = Field(min_length=8, max_length=128)

class ExtensionLinkRedeemIn(BaseModel):
    request_id: str = Field(min_length=8, max_length=128)
    code_verifier: str = Field(min_length=32, max_length=255)


# ── Admin Request Schemas ──────────────────────────────────────────────────────

class SetRoleIn(BaseModel):
    """Payload for POST /api/admin/users/{id}/set-role."""
    role: str = Field(..., pattern="^(USER|ADMIN|ANALYST|VIEWER)$")

class UpdateProfileIn(BaseModel):
    """Payload for PUT /api/me"""
    first_name: str | None = Field(default=None, max_length=80)
    last_name: str | None = Field(default=None, max_length=80)

class AdminCreateUserIn(BaseModel):
    """Payload for POST /api/admin/users/create — admin-provisioned accounts."""
    email: EmailStr
    first_name: str | None = Field(default=None, max_length=80)
    last_name: str | None = Field(default=None, max_length=80)
    role: str = Field(default="USER", pattern="^(USER|ADMIN)$")

class SetInitialPasswordIn(BaseModel):
    """Payload for POST /api/auth/set-initial-password (force-change on first login)."""
    new_password: str = Field(min_length=8, max_length=72)

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v):
        return _validate_strong_password(v)

class UserSettingsIn(BaseModel):
    """Payload for PUT /api/settings — all fields optional so partial updates work."""
    analyst_review: bool | None = None
    notifications: bool | None = None
    strict_mode: bool | None = None
    auto_sync: bool | None = None
    threshold: int | None = Field(default=None, ge=50, le=99)
    auto_block: bool | None = None
    global_protection: bool | None = None
