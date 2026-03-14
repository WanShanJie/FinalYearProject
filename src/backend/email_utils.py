import os
import smtplib
from email.message import EmailMessage

def send_reset_email(to_email: str, reset_link: str):
    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASS")
    sender = os.getenv("SMTP_FROM") or user

    if not host or not user or not password or not sender:
        raise RuntimeError(
            "SMTP settings missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in .env"
        )

    msg = EmailMessage()
    msg["Subject"] = "Reset your password"
    msg["From"] = sender
    msg["To"] = to_email

    msg.set_content(
        f"""Hi,

We received a request to reset your password.

Click this link to reset it:
{reset_link}

If you didn’t request this, ignore this email.

Thanks,
Context-Aware Deepfake Verification System
"""
    )

    with smtplib.SMTP(host, port) as smtp:
        smtp.ehlo()
        smtp.starttls()
        smtp.ehlo()
        smtp.login(user, password)
        smtp.send_message(msg)


def send_verification_email(to_email: str, verify_link: str):
    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASS")
    sender = os.getenv("SMTP_FROM") or user

    if not host or not user or not password or not sender:
        raise RuntimeError(
            "SMTP settings missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in .env"
        )

    msg = EmailMessage()
    msg["Subject"] = "Verify your email"
    msg["From"] = sender
    msg["To"] = to_email

    msg.set_content(
        f"""Hi,

Please verify your email address by clicking the link below:
{verify_link}

If you didn't create an account, ignore this email.

Thanks,
Context-Aware Deepfake Verification System
"""
    )

    with smtplib.SMTP(host, port) as smtp:
        smtp.ehlo()
        smtp.starttls()
        smtp.ehlo()
        smtp.login(user, password)
        smtp.send_message(msg)

def send_mfa_code(to_email: str, code: str, ttl_minutes: int = 5):
    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASS")
    sender = os.getenv("SMTP_FROM") or user

    if not host or not user or not password or not sender:
        raise RuntimeError(
            "SMTP settings missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in .env"
        )

    msg = EmailMessage()
    msg["Subject"] = "Your login verification code"
    msg["From"] = sender
    msg["To"] = to_email

    msg.set_content(
        f"""Hi,

Your verification code is: {code}

This code expires in {ttl_minutes} minutes.
If you didn't try to sign in, you can ignore this email.

"""
    )

    # Attempt to send via SMTP and optionally print to console for dev troubleshooting.
    try:
        with smtplib.SMTP(host, port) as s:
            s.ehlo()
            s.starttls()
            s.ehlo()
            s.login(user, password)
            s.send_message(msg)
    except Exception:
        # Re-raise after logging to help debugging
        print(f"[email_utils] Failed to send MFA email to {to_email}")
        raise

    # If enabled, print MFA codes to stdout for local/dev debugging.
    if os.getenv("DEV_PRINT_EMAILS", "false").lower() == "true":
        print(f"[DEV_PRINT_EMAILS] MFA code for {to_email}: {code} (expires in {ttl_minutes} min)")


def send_email_verification_code(to_email: str, code: str, ttl_minutes: int = 10):
    """Send a one-time code to verify ownership of the email (used right after signup)."""
    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASS")
    sender = os.getenv("SMTP_FROM") or user

    if not host or not user or not password or not sender:
        raise RuntimeError(
            "SMTP settings missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in .env"
        )

    msg = EmailMessage()
    msg["Subject"] = "Verify your email (code)"
    msg["From"] = sender
    msg["To"] = to_email

    msg.set_content(
        f"""Hi,

Your email verification code is: {code}

This code expires in {ttl_minutes} minutes.
If you didn't create an account, you can ignore this email.

Thanks,
Context-Aware Deepfake Verification System
"""
    )

    try:
        with smtplib.SMTP(host, port) as s:
            s.ehlo()
            s.starttls()
            s.ehlo()
            s.login(user, password)
            s.send_message(msg)
    except Exception:
        print(f"[email_utils] Failed to send email verification code to {to_email}")
        raise

    if os.getenv("DEV_PRINT_EMAILS", "false").lower() == "true":
        print(f"[DEV_PRINT_EMAILS] Email verification code for {to_email}: {code} (expires in {ttl_minutes} min)")
