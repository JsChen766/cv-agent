from __future__ import annotations

from datetime import date

from app.domain.jd.models import JdRequirement
from app.domain.resume.retrieval.models import ExperienceFactBundle, RetrievalFact
from app.rag.evidence.hybrid_retrieval import HybridFactRetrievalService


class _Repository:
    def __init__(self, bundles: list[ExperienceFactBundle]) -> None:
        self.bundles = bundles
        self.cache: dict[str, tuple[float, ...]] = {}
        self.saved = 0

    async def load_current_experience_facts(
        self,
        user_id: str,
        *,
        embedding_model: str,
    ) -> list[ExperienceFactBundle]:
        assert user_id == "user-1"
        assert embedding_model == "test-model"
        return self.bundles

    async def get_requirement_embeddings(
        self,
        user_id: str,
        requirements_fingerprint: str,
        embedding_model: str,
        text_hashes: dict[str, str],
    ) -> dict[str, tuple[float, ...]]:
        return {key: value for key, value in self.cache.items() if key in text_hashes}

    async def save_requirement_embeddings(
        self,
        user_id: str,
        requirements_fingerprint: str,
        embedding_model: str,
        text_hashes: dict[str, str],
        embeddings: dict[str, tuple[float, ...]],
    ) -> None:
        self.saved += 1
        self.cache.update(embeddings)


class _Embedder:
    def __init__(self) -> None:
        self.calls = 0

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        return [[1.0, 0.0] if "Python" in text else [0.0, 1.0] for text in texts]


def _ready_bundle() -> ExperienceFactBundle:
    return ExperienceFactBundle(
        experience_id="exp-1",
        revision_id="rev-1",
        revision_hash="hash-1",
        content="Built Python APIs",
        title="Backend Engineer",
        organization="Example",
        category="work",
        end_date=date(2024, 1, 1),
        factbank_status="ready",
        facts=(
            RetrievalFact(
                fact_id="fact-1",
                experience_id="exp-1",
                source_revision_id="rev-1",
                source_revision_hash="hash-1",
                source_text="Built Python APIs",
                technologies=("Python",),
                lexical_tokens=("python", "apis"),
                strength_score=0.8,
                experience_category="work",
                experience_title="Backend Engineer",
                organization="Example",
                end_date=date(2024, 1, 1),
                embedding=(1.0, 0.0),
            ),
        ),
    )


async def test_hybrid_service_caches_requirements_and_projects_fact_ids() -> None:
    repository = _Repository([_ready_bundle()])
    embedder = _Embedder()
    service = HybridFactRetrievalService(
        repository,
        embedder,
        embedding_model="test-model",
        max_candidates=10,
        semantic_match_threshold=0.45,
    )
    requirements = [
        JdRequirement(
            id="req-python",
            text="Python backend",
            category="skill",
            importance="high",
            keywords=("Python",),
            weight=1.0,
            v2_importance="must_have",
        )
    ]

    first = await service.retrieve("user-1", requirements)
    second = await service.retrieve("user-1", requirements)

    assert embedder.calls == 1
    assert repository.saved == 1
    assert first.retrieval_result.selected_fact_ids == ("fact-1",)
    assert second.retrieval_result.diagnostics.requirement_embedding_cache_hits == 1
    assert first.experiences[0].claims[0].fact_id == "fact-1"
    assert first.evidence_pack.matches[0].matched_claims[0].experience_id == "exp-1"


async def test_pending_revision_uses_deterministic_fallback_with_diagnostics() -> None:
    pending = ExperienceFactBundle(
        experience_id="exp-pending",
        revision_id="rev-pending",
        revision_hash="hash-pending",
        content="- Built Python APIs\n- Reduced latency 30%",
        title="Engineer",
        category="work",
        factbank_status="pending",
    )
    service = HybridFactRetrievalService(
        _Repository([pending]),
        _Embedder(),
        embedding_model="test-model",
        max_candidates=10,
        semantic_match_threshold=0.45,
    )

    result = await service.retrieve(
        "user-1",
        [JdRequirement(id="req-python", text="Python", importance="high")],
    )

    assert result.retrieval_result.diagnostics.fallback_facts == 2
    assert all(
        "deterministic_revision_fallback" in fact.degradation_sources
        for fact in result.retrieval_result.facts
    )
    assert {claim.text for claim in result.experiences[0].claims} == {
        "Built Python APIs",
        "Reduced latency 30%",
    }
