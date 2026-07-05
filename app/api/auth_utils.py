"""JWT token creation and verification helpers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt

from app.core.config import settings
from app.core.errors import UnauthorizedError

ALGORITHM = "HS256"


def create_access_token(user_id: str) -> str:
    expire = datetime.now(UTC) + timedelta(
        minutes=settings.access_token_expire_minutes
    )
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> str:
    """Return user_id from a valid token, raise UnauthorizedError otherwise."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        user_id: str | None = payload.get("sub")
        if not user_id:
            raise UnauthorizedError("Invalid token payload")
        return user_id
    except JWTError as e:
        raise UnauthorizedError(f"Token invalid or expired: {e}") from e
