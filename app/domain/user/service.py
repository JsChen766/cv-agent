from __future__ import annotations

from passlib.context import CryptContext

from app.core.errors import ConflictError, NotFoundError, UnauthorizedError
from app.core.types import USER_PREFIX, generate_id
from app.domain.user.models import User, UserProfile
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
