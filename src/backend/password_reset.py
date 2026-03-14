import hashlib
import secrets
from datetime import datetime, timedelta

RESET_EXP_MINUTES = 30

def make_reset_token() -> str:
    return secrets.token_urlsafe(32)

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def expires_at_dt() -> datetime:
    return datetime.utcnow() + timedelta(minutes=RESET_EXP_MINUTES)
