import os
from passlib.context import CryptContext
from jose import jwt
from datetime import datetime, timedelta
from typing import Iterable

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("JWT_SECRET_KEY is missing from .env. Secure communication cannot be established.")
ALGORITHM = "HS256"
TOKEN_EXPIRE_MIN = 1440  # 24 hours

def hash_password(password: str) -> str:
    return pwd_ctx.hash(password)

def verify_password(password: str, hashed: str) -> bool:
    return pwd_ctx.verify(password, hashed)

def create_token(user_id: int, email: str):
    expire = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MIN)
    payload = {"sub": str(user_id), "email": email, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def create_extension_token(user_id: int, email: str, linked_extension_id: int, scopes: Iterable[str] | None = None, expires_days: int = 30):
    expire = datetime.utcnow() + timedelta(days=expires_days)
    payload = {
        "sub": str(user_id),
        "email": email,
        "type": "extension",
        "linked_extension_id": linked_extension_id,
        "scope": list(scopes or ["analysis:create", "analysis:read:self"]),
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)