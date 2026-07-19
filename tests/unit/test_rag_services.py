from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from unittest.mock import AsyncMock

from app.domain.jd.models import JdRequirement
from app.rag.evidence.models import Claim, ExperienceWithClaims
from app.rag.evidence.service import EvidenceRagService
from app.rag.guideline.service import GuidelineRagService


class _Acquire(AbstractAsyncContextManager):
    def __init__(self, connection) -> None:
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, *args):
        return None


class _Pool:
    def __init__(self, connection) -> None:
        self.connection = connection

    def acquire(self):
        return _Acquire(self.connection)


class _EmbeddingProvider:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [([1.0, 0.0] if "Python" in text else [0.0, 1.0]) for text in texts]


async def test_evidence_pack_scores_and_projects_matching_claims(monkeypatch) -> None:
    service = EvidenceRagService(_Pool(object()))  # type: ignore[arg-type]
    service._embed = _EmbeddingProvider()  # type: ignore[assignment]
    monkeypatch.setattr("app.rag.evidence.service.settings.evidence_similarity_threshold", 0.65)
    requirement = JdRequirement(
        id="req-1",
        text="Python backend development",
        category="skill",
        importance="high",
    )
    experience = ExperienceWithClaims(
        experience_id="exp-1",
        title="Backend Engineer",
        content="Built Python APIs",
        claims=[Claim(text="Built Python APIs", category="achievement")],
        claims_indexed=True,
    )

    pack = await service.build_evidence_pack([requirement], [experience])

    assert pack.coverage_ratio == 1.0
    assert pack.matches[0].match_score == 1.0
    assert pack.matches[0].matched_claims[0].text == "Built Python APIs"


def test_pending_revision_uses_deterministic_claim_fallback() -> None:
    row = {
        "id": "exp-1",
        "revision_id": "rev-1",
        "title": "Backend Engineer",
        "organization": "Example",
        "role": "Engineer",
        "category": "work",
        "start_date": None,
        "end_date": None,
        "tags": [],
        "content": "- Built Python APIs\n- Reduced latency 30%",
        "claims": None,
        "revision_hash": None,
        "factbank_status": "pending",
        "relevance_score": 0.0,
    }

    first = EvidenceRagService._to_experience(row)  # type: ignore[arg-type]
    second = EvidenceRagService._to_experience(row)  # type: ignore[arg-type]

    assert [claim.text for claim in first.claims] == [
        "Built Python APIs",
        "Reduced latency 30%",
    ]
    assert all(claim.fact_id for claim in first.claims)
    assert [claim.fact_id for claim in first.claims] == [claim.fact_id for claim in second.claims]
    assert first.claims_indexed is False


class _GuidelineConnection:
    def __init__(self) -> None:
        self.query = ""

    async def fetch(self, query: str, text: str, limit: int):
        self.query = query
        return [{"content": "Use quantified, evidence-backed bullets."}]


async def test_guideline_rag_uses_safe_plaintext_fallback(monkeypatch) -> None:
    connection = _GuidelineConnection()
    service = GuidelineRagService(_Pool(connection))  # type: ignore[arg-type]
    monkeypatch.setattr(
        "app.rag.guideline.service.column_is_vector",
        AsyncMock(return_value=False),
    )

    result = await service.retrieve("Python & backend | resume", top_k=3)

    assert result == ["Use quantified, evidence-backed bullets."]
    assert "plainto_tsquery" in connection.query
