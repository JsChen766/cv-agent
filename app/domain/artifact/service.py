from __future__ import annotations

from app.core.errors import NotFoundError
from app.core.types import ARTIFACT_PREFIX, generate_id
from app.domain.artifact.models import Artifact
from app.domain.artifact.repository import ArtifactRepository


class ArtifactService:
    def __init__(self, repo: ArtifactRepository) -> None:
        self._repo = repo

    async def list_artifacts(
        self,
        user_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        type: str | None = None,
    ) -> tuple[list[Artifact], str | None]:
        return await self._repo.list(user_id, limit=limit, cursor=cursor, type=type)

    async def get_artifact(self, user_id: str, artifact_id: str) -> Artifact:
        artifact = await self._repo.get(user_id, artifact_id)
        if not artifact:
            raise NotFoundError(f"Artifact not found: {artifact_id}")
        return artifact

    async def create_artifact(self, user_id: str, data: dict) -> Artifact:
        artifact_id = generate_id(ARTIFACT_PREFIX)
        content = data.get("content", "")
        data["word_count"] = len(content.split())
        return await self._repo.create(artifact_id, user_id, data)

    async def update_artifact(
        self,
        user_id: str,
        artifact_id: str,
        patch: dict,
    ) -> Artifact:
        await self.get_artifact(user_id, artifact_id)  # ownership check
        if "content" in patch:
            patch["word_count"] = len(patch["content"].split())
        return await self._repo.update(user_id, artifact_id, patch)

    async def delete_artifact(self, user_id: str, artifact_id: str) -> None:
        await self.get_artifact(user_id, artifact_id)
        await self._repo.delete(user_id, artifact_id)
