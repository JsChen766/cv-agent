from __future__ import annotations

from typing import Protocol

from app.domain.resume.retrieval.models import ExperienceFactBundle


class FactRetrievalRepository(Protocol):
    async def load_current_experience_facts(
        self,
        user_id: str,
        *,
        embedding_model: str,
    ) -> list[ExperienceFactBundle]: ...

    async def get_requirement_embeddings(
        self,
        user_id: str,
        requirements_fingerprint: str,
        embedding_model: str,
        text_hashes: dict[str, str],
    ) -> dict[str, tuple[float, ...]]: ...

    async def save_requirement_embeddings(
        self,
        user_id: str,
        requirements_fingerprint: str,
        embedding_model: str,
        text_hashes: dict[str, str],
        embeddings: dict[str, tuple[float, ...]],
    ) -> None: ...
