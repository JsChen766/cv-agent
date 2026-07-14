from __future__ import annotations

from datetime import datetime

from passlib.context import CryptContext

from app.core.errors import ConflictError, NotFoundError, UnauthorizedError
from app.core.types import USER_PREFIX, generate_id
from app.domain.user.models import User, UserProfile, UserSession
from app.domain.user.repository import UserRepository

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


class UserService:
    def __init__(self, repo: UserRepository) -> None:
        self._repo = repo

    # ── Auth ──────────────────────────────────────────────────────────────────

    def hash_password(self, plain: str) -> str:
        return str(_pwd_ctx.hash(plain))

    def verify_password(self, plain: str, hashed: str) -> bool:
        return bool(_pwd_ctx.verify(plain, hashed))

    async def register(self, email: str, password: str) -> User:
        existing = await self._repo.get_by_email(email)
        if existing:
            raise ConflictError(f"Email already registered: {email}")
        user_id = generate_id(USER_PREFIX)
        hashed = self.hash_password(password)
        return await self._repo.create(user_id, email, hashed)

    async def authenticate(self, email: str, password: str) -> User:
        user = await self._repo.get_by_email(email)
        if not user or not self.verify_password(password, user.hashed_password):
            raise UnauthorizedError("Invalid email or password")
        return user

    async def get_by_id(self, user_id: str) -> User:
        user = await self._repo.get_by_id(user_id)
        if not user:
            raise NotFoundError(f"User not found: {user_id}")
        return user

    async def change_password(
        self, user_id: str, current_password: str, new_password: str
    ) -> None:
        """Verify current password, then rotate the stored hash.

        Callers should validate `new_password` strength BEFORE invoking this
        (via `app.api.auth_utils.validate_password_strength`).
        """
        user = await self.get_by_id(user_id)
        if not self.verify_password(current_password, user.hashed_password):
            raise UnauthorizedError("Current password is incorrect")
        if self.verify_password(new_password, user.hashed_password):
            # Not a security issue but a UX signal — reject silently-equal update.
            raise UnauthorizedError("New password must differ from the current one")
        await self._repo.update_password(user_id, self.hash_password(new_password))

    async def delete_user(self, user_id: str) -> None:
        """Delete the user and cascade-remove owned rows (FKs enforce cascade)."""
        # Existence check so we return a clean 404 instead of a silent no-op.
        await self.get_by_id(user_id)
        await self._repo.delete(user_id)

    # ── Profile ───────────────────────────────────────────────────────────────

    async def get_profile(self, user_id: str) -> UserProfile:
        profile = await self._repo.get_profile(user_id)
        if not profile:
            # Return empty profile rather than 404
            return UserProfile(user_id=user_id)
        return profile

    async def update_profile(self, user_id: str, patch: dict[str, object]) -> UserProfile:
        # Ensure user exists
        await self.get_by_id(user_id)
        return await self._repo.upsert_profile(user_id, patch)

    # ── Sessions ──────────────────────────────────────────────────────────────

    async def create_session(
        self,
        session_id: str,
        user_id: str,
        token_hash: str,
        expires_at: datetime,
    ) -> UserSession:
        return await self._repo.create_session(session_id, user_id, token_hash, expires_at)

    async def get_session(self, session_id: str) -> UserSession | None:
        return await self._repo.get_session(session_id)

    async def list_sessions(self, user_id: str) -> list[UserSession]:
        return await self._repo.list_sessions(user_id)

    async def delete_session(self, session_id: str, user_id: str) -> bool:
        return await self._repo.delete_session(session_id, user_id)

    async def delete_all_sessions(
        self, user_id: str, *, except_session_id: str | None = None
    ) -> int:
        return await self._repo.delete_all_sessions_for_user(
            user_id, except_session_id=except_session_id
        )
