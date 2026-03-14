import os
import secrets
import logging
import token
from urllib import request
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from dotenv import load_dotenv
from authlib.integrations.starlette_client import OAuth
import httpx
from datetime import datetime

from db import SessionLocal
from models import User, OAuthAccount
from auth import create_token, hash_password

load_dotenv()
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/oauth", tags=["oauth"])

oauth = OAuth()

# --------- Helpers ---------
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def env_required(key: str) -> str:
    val = os.getenv(key)
    if not val:
        raise RuntimeError(f"Missing required env var: {key}")
    return val

def frontend_redirect(token: str) -> RedirectResponse:
    frontend = os.getenv("OAUTH_REDIRECT_FRONTEND", "http://localhost:5173/oauth/callback")
    # token in URL is ok for dev/demo; for production, use HttpOnly cookie
    return RedirectResponse(f"{frontend}?token={token}")

# --------- Register OAuth providers ---------
# Google OpenID Connect (best for getting email/profile)
oauth.register(
    name="google",
    client_id=env_required("GOOGLE_CLIENT_ID"),
    client_secret=env_required("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

# oauth.register(
#     name="google",
#     client_id=os.getenv("GOOGLE_CLIENT_ID"),
#     client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
#     server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
#     client_kwargs={"scope": "openid email profile"},
# )


# X OAuth2 (email usually NOT provided)
oauth.register(
    name="x",
    client_id=env_required("X_CLIENT_ID"),
    client_secret=env_required("X_CLIENT_SECRET"),
    authorize_url="https://twitter.com/i/oauth2/authorize",
    access_token_url="https://api.twitter.com/2/oauth2/token",
    client_kwargs={"scope": "tweet.read users.read offline.access"},
)

# --------- Google Flow ---------
@router.get("/google/login")
async def google_login(request: Request):
    base = os.getenv("BASE_BACKEND_URL", "http://127.0.0.1:8000")
    redirect_uri = f"{base}/api/oauth/google/callback"
    return await oauth.google.authorize_redirect(request, redirect_uri, prompt="consent")

@router.get("/google/callback")
async def google_callback(request: Request, db: Session = Depends(get_db)):
    try:
        token = await oauth.google.authorize_access_token(request)

        # ✅ Robust way to get user info (avoids None userinfo)
        userinfo = token.get("userinfo")
        # userinfo = await oauth.google.parse_id_token(request, token)

        if not userinfo:
            userinfo = await oauth.google.parse_id_token(token, None) 

        if not userinfo:
            raise HTTPException(status_code=400, detail="Google userinfo not available")
        

        provider = "google"
        provider_user_id = str(userinfo["sub"])
        email = userinfo.get("email")

        if not email:
            raise HTTPException(status_code=400, detail="Google account has no email")

        first_name = userinfo.get("given_name")
        last_name = userinfo.get("family_name")

        # 1) check existing oauth link
        oauth_account = db.query(OAuthAccount).filter(
            OAuthAccount.provider == provider,
            OAuthAccount.provider_user_id == provider_user_id
        ).first()

        if oauth_account:
            user = db.query(User).filter(User.id == oauth_account.user_id).first()
            if not user:
                raise HTTPException(status_code=400, detail="Linked user not found")
        else:
            # 2) if no link, try find user by email
            user = db.query(User).filter(User.email == email).first()

            # 3) create user if not exists
            if not user:
                user = User(
                    first_name=first_name,
                    last_name=last_name,
                    email=email,
                    provider='google',
                    email_verified=True,
                    email_verified_at=datetime.utcnow(),
                    password_hash=hash_password(secrets.token_hex(16)),  # random unused password
                )
                db.add(user)
                db.commit()
                db.refresh(user)

            # 4) link oauth account
            oauth_link = OAuthAccount(
                user_id=user.id,
                provider=provider,
                provider_user_id=provider_user_id,
                email=email
            )
            db.add(oauth_link)
            db.commit()

        jwt_token = create_token(user.id, user.email)
        return frontend_redirect(jwt_token)

    except HTTPException:
        raise
    except Exception as e:
        # Return readable error instead of generic 500
        logger.error(f"Google OAuth failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Google OAuth failed: {str(e)}")


# --------- X Flow ---------
@router.get("/x/login")
async def x_login(request: Request):
    base = os.getenv("BASE_BACKEND_URL", "http://127.0.0.1:8000")
    redirect_uri = f"{base}/api/oauth/x/callback"
    return await oauth.x.authorize_redirect(
        request,
        redirect_uri,
        code_challenge_method="S256",  # PKCE
    )

@router.get("/x/callback")
async def x_callback(request: Request, db: Session = Depends(get_db)):
    try:
        token = await oauth.x.authorize_access_token(request)

        access_token = token.get("access_token")
        if not access_token:
            raise HTTPException(status_code=400, detail="X access token missing")

        # Fetch X profile
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                "https://api.twitter.com/2/users/me",
                headers={"Authorization": f"Bearer {access_token}"},
            )
        if r.status_code != 200:
            raise HTTPException(status_code=400, detail=f"X profile fetch failed: {r.text}")

        data = r.json()
        userinfo = data.get("data")
        if not userinfo:
            raise HTTPException(status_code=400, detail="X userinfo missing")

        provider = "x"
        provider_user_id = str(userinfo["id"])

        # X OAuth2 usually doesn't provide email -> placeholder
        placeholder_email = f"x_{provider_user_id}@no-email.local"

        # 1) check existing oauth link
        oauth_account = db.query(OAuthAccount).filter(
            OAuthAccount.provider == provider,
            OAuthAccount.provider_user_id == provider_user_id
        ).first()

        if oauth_account:
            user = db.query(User).filter(User.id == oauth_account.user_id).first()
            if not user:
                raise HTTPException(status_code=400, detail="Linked user not found")
        else:
            # find/create user via placeholder email
            user = db.query(User).filter(User.email == placeholder_email).first()
            if not user:
                user = User(
                    first_name=userinfo.get("name"),
                    last_name=None,
                    email=placeholder_email,
                    password_hash=hash_password(secrets.token_hex(16)),
                )
                db.add(user)
                db.commit()
                db.refresh(user)

            # link oauth account
            oauth_link = OAuthAccount(
                user_id=user.id,
                provider=provider,
                provider_user_id=provider_user_id,
                email=None
            )
            db.add(oauth_link)
            db.commit()

        jwt_token = create_token(user.id, user.email)
        return frontend_redirect(jwt_token)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"X OAuth failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"X OAuth failed: {str(e)}")
