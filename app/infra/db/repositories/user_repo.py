from __future__ import annotations

import asyncpg

from app.domain.user.models import User, UserProfile
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
        return self._to_user(row)  # type: ignore[arg-type]

    async def get_profile(self, user_id: str) -> UserProfile | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM user_profiles WHERE user_id = $1", user_id
            )
        return self._to_profile(row) if row else None

    async def upsert_profile(self, user_id: str, data: dict) -> UserProfile:
        fields = [
            "full_name", "email", "phone", "location",
            "linkedin_url", "github_url", "personal_website",
            "current_title", "current_company", "years_of_experience",
            "career_stage", "preferred_language", "resume_style",
        ]
        json_fields = ["target_roles", "target_industries", "target_locations"]

        set_parts = []
        values: list = [user_id]
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
