"""JWT token creation and verification helpers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import cast

from jose import JWTError, jwt

from app.core.config import settings
from app.core.errors import UnauthorizedError

ALGORITHM = "HS256"


def create_access_token(user_id: str) -> str:
    expire = datetime.now(UTC) + timedelta(
        minutes=settings.access_token_expire_minutes
    )
    payload = {"sub": user_id, "exp": expire}
    return str(jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM))


def decode_access_token(token: str) -> str:
    """Return user_id from a valid token, raise UnauthorizedError otherwise."""
    try:
        payload = cast("dict[str, object]", jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM]))
        user_id = payload.get("sub")
        if not isinstance(user_id, str) or not user_id:
            raise UnauthorizedError("Invalid token payload")
        return user_id
    except JWTError as e:
        raise UnauthorizedError(f"Token invalid or expired: {e}") from e
