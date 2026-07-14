from __future__ import annotations

from datetime import datetime
from typing import Protocol

from app.domain.user.models import User, UserProfile, UserSession


class UserRepository(Protocol):
    async def get_by_id(self, user_id: str) -> User | None: ...

    async def get_by_email(self, email: str) -> User | None: ...

    async def create(self, user_id: str, email: str, hashed_password: str) -> User: ...

    async def update_password(self, user_id: str, hashed_password: str) -> None: ...

    async def delete(self, user_id: str) -> None: ...

    async def get_profile(self, user_id: str) -> UserProfile | None: ...

    async def upsert_profile(self, user_id: str, data: dict[str, object]) -> UserProfile: ...

    # ── Sessions ──────────────────────────────────────────────────────────────

    async def create_session(
        self,
        session_id: str,
        user_id: str,
        token_hash: str,
        expires_at: datetime,
    ) -> UserSession: ...

    async def get_session(self, session_id: str) -> UserSession | None: ...

    async def list_sessions(self, user_id: str) -> list[UserSession]: ...

    async def delete_session(self, session_id: str, user_id: str) -> bool: ...

    async def delete_all_sessions_for_user(
        self, user_id: str, *, except_session_id: str | None = None
    ) -> int: ...

    async def purge_expired_sessions(self) -> int: ...
