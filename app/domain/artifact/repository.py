from __future__ import annotations

from typing import Protocol

from app.domain.artifact.models import Artifact


class ArtifactRepository(Protocol):
    async def list(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        type: str | None = None,
    ) -> tuple[list[Artifact], str | None]: ...

    async def get(self, user_id: str, artifact_id: str) -> Artifact | None: ...

    async def create(self, artifact_id: str, user_id: str, data: dict[str, object]) -> Artifact: ...

    async def update(self, user_id: str, artifact_id: str, patch: dict[str, object]) -> Artifact: ...

    async def delete(self, user_id: str, artifact_id: str) -> None: ...
