from __future__ import annotations

from datetime import datetime

import asyncpg

from app.core.errors import ExternalServiceError
from app.domain.user.models import User, UserProfile, UserSession
from app.infra.db.helpers import parse_jsonb


class PostgresUserRepository:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get_by_id(self, user_id: str) -> User | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
        return self._to_user(row) if row else None

    async def get_by_email(self, email: str) -> User | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM users WHERE email = $1", email)
        return self._to_user(row) if row else None

    async def create(self, user_id: str, email: str, hashed_password: str) -> User:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO users (id, email, hashed_password)
                VALUES ($1, $2, $3)
                RETURNING *
                """,
                user_id, email, hashed_password,
            )
        if row is None:
            raise ExternalServiceError("Failed to create user")
        return self._to_user(row)

    async def get_profile(self, user_id: str) -> UserProfile | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM user_profiles WHERE user_id = $1", user_id
            )
        return self._to_profile(row) if row else None

    async def upsert_profile(self, user_id: str, data: dict[str, object]) -> UserProfile:
        fields = [
            "full_name", "email", "phone", "location",
            "linkedin_url", "github_url", "personal_website",
            "current_title", "current_company", "years_of_experience",
            "career_stage", "preferred_language", "resume_style",
        ]
        json_fields = ["target_roles", "target_industries", "target_locations"]

        set_parts = []
        values: list[object] = [user_id]
        idx = 2
        for f in fields:
            if f in data:
                set_parts.append(f"{f} = ${idx}")
                values.append(data[f])
                idx += 1
        for f in json_fields:
            if f in data:
                import json
                set_parts.append(f"{f} = ${idx}::jsonb")
                values.append(json.dumps(data[f]))
                idx += 1

        if not set_parts:
            # Nothing to update; ensure row exists
            async with self._pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
                    user_id,
                )
        else:
            set_parts.append("updated_at = NOW()")
            sql = f"""
                INSERT INTO user_profiles (user_id) VALUES ($1)
                ON CONFLICT (user_id) DO UPDATE SET {', '.join(set_parts)}
            """
            async with self._pool.acquire() as conn:
                await conn.execute(sql, *values)

        return (await self.get_profile(user_id)) or UserProfile(user_id=user_id)

    async def update_password(self, user_id: str, hashed_password: str) -> None:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "UPDATE users SET hashed_password=$1, updated_at=NOW() WHERE id=$2",
                hashed_password, user_id,
            )
        if result.split()[-1] == "0":
            raise ExternalServiceError(f"Failed to update password for user: {user_id}")

    async def delete(self, user_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute("DELETE FROM users WHERE id=$1", user_id)

    # ── Sessions ──────────────────────────────────────────────────────────────

    async def create_session(
        self,
        session_id: str,
        user_id: str,
        token_hash: str,
        expires_at: datetime,
    ) -> UserSession:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
                VALUES ($1, $2, $3, $4)
                RETURNING *
                """,
                session_id, user_id, token_hash, expires_at,
            )
        if row is None:
            raise ExternalServiceError("Failed to create user session")
        return self._to_session(row)

    async def get_session(self, session_id: str) -> UserSession | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM user_sessions WHERE id=$1 AND expires_at > NOW()",
                session_id,
            )
        return self._to_session(row) if row else None

    async def list_sessions(self, user_id: str) -> list[UserSession]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM user_sessions
                WHERE user_id=$1 AND expires_at > NOW()
                ORDER BY created_at DESC
                """,
                user_id,
            )
        return [self._to_session(r) for r in rows]

    async def delete_session(self, session_id: str, user_id: str) -> bool:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM user_sessions WHERE id=$1 AND user_id=$2",
                session_id, user_id,
            )
        return result.split()[-1] != "0"

    async def delete_all_sessions_for_user(
        self, user_id: str, *, except_session_id: str | None = None
    ) -> int:
        async with self._pool.acquire() as conn:
            if except_session_id is None:
                result = await conn.execute(
                    "DELETE FROM user_sessions WHERE user_id=$1", user_id
                )
            else:
                result = await conn.execute(
                    "DELETE FROM user_sessions WHERE user_id=$1 AND id<>$2",
                    user_id, except_session_id,
                )
        return int(result.split()[-1])

    async def purge_expired_sessions(self) -> int:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM user_sessions WHERE expires_at <= NOW()"
            )
        return int(result.split()[-1])

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _to_user(row: asyncpg.Record) -> User:
        return User(
            id=row["id"],
            email=row["email"],
            hashed_password=row["hashed_password"],
            is_active=row["is_active"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _to_session(row: asyncpg.Record) -> UserSession:
        return UserSession(
            id=row["id"],
            user_id=row["user_id"],
            token_hash=row["token_hash"],
            expires_at=row["expires_at"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _to_profile(row: asyncpg.Record) -> UserProfile:
        return UserProfile(
            user_id=row["user_id"],
            full_name=row["full_name"],
            email=row["email"],
            phone=row["phone"],
            location=row["location"],
            linkedin_url=row["linkedin_url"],
            github_url=row["github_url"],
            personal_website=row["personal_website"],
            current_title=row["current_title"],
            current_company=row["current_company"],
            years_of_experience=row["years_of_experience"],
            career_stage=row["career_stage"],
            target_roles=parse_jsonb(row["target_roles"]) or [],
            target_industries=parse_jsonb(row["target_industries"]) or [],
            target_locations=parse_jsonb(row["target_locations"]) or [],
            preferred_language=row["preferred_language"] or "zh-CN",
            resume_style=row["resume_style"],
            updated_at=row["updated_at"],
        )
