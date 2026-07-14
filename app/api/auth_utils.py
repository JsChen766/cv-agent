"""JWT token creation / verification and password-strength helpers."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import cast

from jose import JWTError, jwt

from app.core.config import settings
from app.core.errors import UnauthorizedError, ValidationError

ALGORITHM = "HS256"

MIN_PASSWORD_LENGTH = 8


def create_access_token(user_id: str, session_id: str | None = None) -> str:
    """Create a JWT with `sub`=user_id and optional `sid`=session_id.

    A token minted without a session id is treated as "stateless" — used by dev
    auto-auth. Real user logins always mint tokens with a session id so they
    can be revoked via the user_sessions table.
    """
    now = datetime.now(UTC)
    expire = now + timedelta(minutes=settings.access_token_expire_minutes)
    payload: dict[str, object] = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": expire,
    }
    if session_id:
        payload["sid"] = session_id
    return str(jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM))


def decode_access_token(token: str) -> tuple[str, str | None]:
    """Return (user_id, session_id) from a valid token; raise UnauthorizedError otherwise."""
    try:
        payload = cast(
            "dict[str, object]",
            jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM]),
        )
    except JWTError as e:
        raise UnauthorizedError(f"Token invalid or expired: {e}") from e
    user_id = payload.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise UnauthorizedError("Invalid token payload")
    raw_sid = payload.get("sid")
    session_id = raw_sid if isinstance(raw_sid, str) and raw_sid else None
    return user_id, session_id


def hash_token(token: str) -> str:
    """Stable hash of a JWT for the user_sessions.token_hash column."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_expiry() -> datetime:
    """Compute an absolute expiry timestamp for a new session using current settings."""
    return datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)


def validate_password_strength(password: str) -> None:
    """Enforce a baseline password policy at every write boundary.

    Rules (kept intentionally simple, universally understood):
      - At least 8 characters
      - At least one letter
      - At least one digit
    """
    if not isinstance(password, str):
        raise ValidationError("Password must be a string")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValidationError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
        )
    if not any(ch.isalpha() for ch in password):
        raise ValidationError("Password must contain at least one letter")
    if not any(ch.isdigit() for ch in password):
        raise ValidationError("Password must contain at least one digit")
