from pydantic import BaseModel, EmailStr, Field

class RegisterIn(BaseModel): 
    first_name: str | None = None
    last_name: str | None = None
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    
    agreed_terms: bool = False
    terms_version: str | None = None
    privacy_version: str | None = None
    
class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
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