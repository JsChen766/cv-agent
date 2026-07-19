from __future__ import annotations

from datetime import datetime
from typing import Protocol

from app.domain.resume.factbank.models import (
    FactBankRevisionTask,
    FactRecord,
    ReusableFactBank,
)


class FactBankRepository(Protocol):
    async def claim_next(
        self,
        *,
        worker_id: str,
        lease_until: datetime,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
    ) -> FactBankRevisionTask | None: ...

    async def find_reusable(
        self,
        task: FactBankRevisionTask,
        *,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
    ) -> ReusableFactBank | None: ...

    async def load_facts(self, revision_id: str) -> list[FactRecord]: ...

    async def replace_facts(
        self,
        task: FactBankRevisionTask,
        facts: list[FactRecord],
        *,
        mode: str,
        schema_version: str,
        extractor_version: str,
    ) -> None: ...

    async def complete(
        self,
        task: FactBankRevisionTask,
        facts: list[FactRecord],
        fact_embeddings: list[list[float]],
        content_embedding: list[float],
        *,
        mode: str,
        schema_version: str,
        extractor_version: str,
        embedding_model: str,
    ) -> None: ...

    async def schedule_retry(
        self,
        task: FactBankRevisionTask,
        *,
        error: str,
        next_attempt_at: datetime | None,
        terminal: bool,
    ) -> None: ...

    async def enqueue_legacy_revisions(self, *, limit: int) -> int: ...
