from __future__ import annotations

from typing import Protocol

from app.domain.user.models import User, UserProfile


class UserRepository(Protocol):
    async def get_by_id(self, user_id: str) -> User | None: ...

    async def get_by_email(self, email: str) -> User | None: ...

    async def create(self, user_id: str, email: str, hashed_password: str) -> User: ...

    async def get_profile(self, user_id: str) -> UserProfile | None: ...

    async def upsert_profile(self, user_id: str, data: dict) -> UserProfile: ...
