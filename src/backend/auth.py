import os
from passlib.context import CryptContext
from jose import jwt
from datetime import datetime, timedelta

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

SECRET_KEY = os.getenv("JWT_SECRET_KEY", "1234567890abcdef")
ALGORITHM = "HS256"
TOKEN_EXPIRE_MIN = 60

def hash_password(password: str) -> str:
    return pwd_ctx.hash(password)

def verify_password(password: str, hashed: str) -> bool:
    return pwd_ctx.verify(password, hashed)

def create_token(user_id: int, email: str):
    expire = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MIN)
    payload = {"sub": str(user_id), "email": email, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
