from __future__ import annotations

from datetime import date

from app.domain.resume.candidates.models import CandidateBullet
from app.domain.resume.compiler.models import CompiledResume
from app.domain.resume.compiler.service import ResumeLayoutCompiler
from app.domain.resume.layout_models import (
    BulletFitReport,
    LayoutConstraint,
    LayoutReport,
    LayoutTuning,
    PageReport,
)
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.quality.models import (
    LocalRepairBatchDraft,
    LocalRepairCandidateDraft,
    LocalRepairChoiceDraft,
)
from app.domain.resume.quality.repair import ResumeLocalCandidateRepairService
from app.domain.resume.quality.service import ResumeQualityGateService
from app.domain.resume.retrieval.models import (
    FactScoreBreakdown,
    HybridRetrievalResult,
    RankedFact,
    RetrievalDiagnostics,
    RetrievalExperience,
    RetrievalRequirement,
)
from app.infra.layout import PillowFontMetrics
from app.providers.base import StructuredCallBudgetError, StructuredCallResult
from app.providers.resume_repair import ResumeLocalRepairWriter
from scripts.benchmark_resume_layout_compiler import _inputs as _benchmark_inputs
from scripts.benchmark_resume_quality_gate import _retrieval as _benchmark_retrieval


def _fixture(
    *,
    text: str = "使用 Python 优化接口处理流程，将响应时间降低 20%",
    covered_requirement_ids: tuple[str, ...] = ("req-python",),
    fit_status: str = "pass",
) -> tuple[
    ResumePlan,
    HybridRetrievalResult,
    tuple[CandidateBullet, ...],
    CompiledResume,
    LayoutConstraint,
]:
    requirement = RetrievalRequirement(
        requirement_id="req-python",
        description="Python backend",
        category="technology",
        keywords=("Python",),
        importance="must_have",
        weight=1.0,
    )
    score = FactScoreBreakdown(
        semantic_similarity=0.9,
        lexical_technology_match=1.0,
        uncovered_requirement_gain=1.0,
        evidence_strength=0.9,
        recency=0.5,
        weighted_total=0.9,
    )
    fact = RankedFact(
        fact_id="fact-1",
        experience_id="exp-1",
        source_revision_id="rev-1",
        source_text="使用 Python 优化接口处理流程，将响应时间降低 20%",
        technologies=("Python",),
        selected=True,
        rank=1,
        score=score,
        marginal_value=1.0,
        matched_requirement_ids=("req-python",),
    )
    experience = RetrievalExperience(
        experience_id="exp-1",
        revision_id="rev-1",
        revision_hash="hash-1",
        title="后端工程师",
        organization="示例公司",
        role="开发者",
        category="work",
        start_date=date(2023, 1, 1),
        end_date=date(2025, 1, 1),
        content=fact.source_text,
        factbank_status="ready",
    )
    retrieval = HybridRetrievalResult(
        requirements=(requirement,),
        experiences=(experience,),
        facts=(fact,),
        selected_fact_ids=("fact-1",),
        diagnostics=RetrievalDiagnostics(
            total_experiences=1,
            total_facts=1,
            selected_facts=1,
            ready_facts=1,
            fallback_facts=0,
            ranking_version="test",
        ),
    )
    plan = ResumePlan(
        plan_version="plan-test",
        requirements=(requirement,),
        selected_experience_ids=("exp-1",),
        selected_fact_ids=("fact-1",),
        fact_requirement_map={"fact-1": ("req-python",)},
        section_height_budgets_mm={"work": 200.0},
        experience_height_budgets_mm={"exp-1": 200.0},
        target_candidate_lines=10,
        target_final_usage_ratio=0.9,
        estimated_page_height_mm=250.0,
        estimated_usage_ratio=0.9,
        objective_score=1.0,
        selection_reasons={"fact-1": ("selected",)},
        rejection_reasons={},
    )
    candidate = CandidateBullet(
        bullet_id="bullet-1",
        candidate_group_id="group-1",
        experience_id="exp-1",
        text=text,
        source_fact_ids=("fact-1",),
        covered_requirement_ids=covered_requirement_ids,
        quality_score=1.0,
        estimated_lines=1,
        estimated_height_mm=4.0,
        length_variant="medium",
    )
    fit = BulletFitReport(
        bullet_id="bullet-1",
        section_type="experience",
        item_id="item-1",
        line_count=2,
        line_widths_mm=[120.0, 100.0],
        last_line_width_mm=100.0,
        last_line_ratio=0.75,
        target_ratio=0.70,
        gate_ratio=0.667,
        status=fit_status,  # type: ignore[arg-type]
        recommendation="none" if fit_status == "pass" else "rephrase",  # type: ignore[arg-type]
    )
    report = LayoutReport(
        profile_version="test-profile",
        profile_hash="test-hash",
        content_width_mm=192.0,
        page_available_height_mm=279.0,
        page_count=1,
        overflow_mm=0.0,
        minimum_page_usage_ratio=0.85,
        target_page_usage_ratio=0.90,
        maximum_page_usage_ratio=0.98,
        pages=[
            PageReport(
                page_number=1,
                available_height_mm=279.0,
                used_height_mm=251.1,
                usage_ratio=0.90,
            )
        ],
        bullet_fits=[fit],
        status="pass" if fit_status == "pass" else "needs_revision",
    )
    structure = {
        "language": "zh-CN",
        "contact": {"name": "测试用户"},
        "sections": [
            {
                "id": "experience",
                "type": "experience",
                "heading": "工作经历",
                "items": [
                    {
                        "id": "item-1",
                        "source_experience_id": "exp-1",
                        "title": "后端工程师",
                        "organization": "示例公司",
                        "role": "开发者",
                        "start_date": "2023-01-01",
                        "end_date": "2025-01-01",
                        "bullets": [
                            {
                                "id": "bullet-1",
                                "text": text,
                                "source_fact_ids": ["fact-1"],
                                "matched_jd_requirement_ids": list(covered_requirement_ids),
                            }
                        ],
                    }
                ],
            }
        ],
    }
    compiled = CompiledResume(
        plan_version="plan-test",
        selected_candidate_ids=("bullet-1",),
        selected_candidate_group_ids=("group-1",),
        selected_fact_ids=("fact-1",),
        structured_resume=structure,
        layout_report=report,
        layout_tuning=LayoutTuning(),
        actions=(),
    )
    constraint = LayoutConstraint(
        max_pages=1,
        requested_pages=1,
        minimum_page_usage_ratio=0.85,
        target_page_usage_ratio=0.90,
        maximum_page_usage_ratio=0.98,
    )
    return plan, retrieval, (candidate,), compiled, constraint


def test_quality_gate_passes_grounded_compiled_resume() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.status == "passed"
    assert report.grounding.ungrounded_bullets == 0
    assert report.coverage.must_have_coverage_ratio == 1.0


def test_quality_gate_marks_local_number_and_technology_failures_repairable() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(
        text="使用 Kubernetes 优化接口处理流程，将响应时间降低 30%"
    )

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.status == "repairable"
    assert report.repairable_bullet_ids == ("bullet-1",)
    assert {value.code for value in report.issues} == {
        "bullet_number_mismatch",
        "bullet_technology_mismatch",
    }


def test_quality_gate_fails_closed_on_metadata_mismatch() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()
    compiled.structured_resume["sections"][0]["items"][0]["organization"] = "虚构公司"

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.status == "failed"
    assert "metadata_organization_mismatch" in {value.code for value in report.issues}


def test_quality_gate_fails_closed_when_source_metadata_is_omitted() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()
    compiled.structured_resume["sections"][0]["items"][0].pop("title")

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.status == "failed"
    assert "metadata_title_mismatch" in {value.code for value in report.issues}


def test_quality_gate_rejects_fact_from_stale_experience_revision() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()
    retrieval = retrieval.model_copy(
        update={
            "facts": (retrieval.facts[0].model_copy(update={"source_revision_id": "rev-stale"}),)
        }
    )

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.status == "failed"
    assert report.grounding.stale_revision_fact_ids == ("fact-1",)
    assert "bullet_grounding_invalid" in {value.code for value in report.issues}


def test_quality_gate_fails_when_must_have_coverage_is_below_threshold() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(covered_requirement_ids=())

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.status == "failed"
    assert report.coverage.must_have_coverage_ratio == 0.0
    assert "must_have_coverage_below_threshold" in {value.code for value in report.issues}


def test_quality_gate_treats_exact_eighty_percent_must_have_coverage_as_passing() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()
    requirements = tuple(
        plan.requirements[0].model_copy(update={"requirement_id": f"req-{index}"})
        for index in range(5)
    )
    covered = tuple(value.requirement_id for value in requirements[:4])
    plan = plan.model_copy(
        update={
            "requirements": requirements,
            "fact_requirement_map": {"fact-1": covered},
        }
    )
    retrieval = retrieval.model_copy(update={"requirements": requirements})
    candidates = (candidates[0].model_copy(update={"covered_requirement_ids": covered}),)
    compiled.structured_resume["sections"][0]["items"][0]["bullets"][0][
        "matched_jd_requirement_ids"
    ] = list(covered)

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.coverage.must_have_coverage_ratio == 0.8
    assert report.status == "passed"


def test_quality_gate_routes_tail_failure_to_one_local_repair() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")

    report = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)

    assert report.status == "repairable"
    assert report.repairable_bullet_ids == ("bullet-1",)


def test_quality_gate_fails_when_two_final_bullets_reuse_one_source_fact() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()
    second = candidates[0].model_copy(
        update={
            "bullet_id": "bullet-2",
            "candidate_group_id": "group-2",
            "text": "基于 Python 优化接口处理流程，实现响应时间降低 20%",
        }
    )
    compiled.selected_candidate_ids = ("bullet-1", "bullet-2")
    compiled.selected_candidate_group_ids = ("group-1", "group-2")
    compiled.structured_resume["sections"][0]["items"][0]["bullets"].append(
        {
            "id": "bullet-2",
            "text": second.text,
            "source_fact_ids": ["fact-1"],
            "matched_jd_requirement_ids": ["req-python"],
        }
    )
    compiled.layout_report.bullet_fits.append(
        compiled.layout_report.bullet_fits[0].model_copy(update={"bullet_id": "bullet-2"})
    )

    report = ResumeQualityGateService().validate(
        plan, retrieval, (*candidates, second), compiled, constraint
    )

    assert report.status == "failed"
    assert report.grounding.duplicate_fact_ids == ("fact-1",)
    assert "duplicate_source_fact" in {value.code for value in report.issues}


def test_quality_gate_fails_when_one_bullet_repeats_a_source_fact_id() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture()
    repeated = candidates[0].model_copy(update={"source_fact_ids": ("fact-1", "fact-1")})
    compiled.structured_resume["sections"][0]["items"][0]["bullets"][0]["source_fact_ids"] = [
        "fact-1",
        "fact-1",
    ]

    report = ResumeQualityGateService().validate(
        plan,
        retrieval,
        (repeated,),
        compiled,
        constraint,
    )

    assert report.status == "failed"
    assert "duplicate_source_fact_within_bullet" in {value.code for value in report.issues}


def test_local_candidate_repair_preserves_evidence_and_returns_transient_candidate() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")
    quality = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)
    draft = LocalRepairBatchDraft(
        repairs=(
            LocalRepairChoiceDraft(
                bullet_id="bullet-1",
                candidates=(
                    LocalRepairCandidateDraft(
                        text=(
                            "使用 Python 对接口处理流程进行系统优化，"
                            "通过重构处理逻辑将接口响应时间降低 20%"
                        ),
                        source_fact_ids=("fact-1",),
                        covered_requirement_ids=("req-python",),
                    ),
                ),
            ),
        )
    )

    result = ResumeLocalCandidateRepairService(ResumeLayoutService(PillowFontMetrics())).apply(
        plan,
        retrieval,
        candidates,
        compiled.selected_candidate_ids,
        quality.repairable_bullet_ids,
        draft,
        language="zh-CN",
    )

    assert result.status == "applied"
    assert result.added_candidate_ids
    repaired = next(
        value for value in result.candidates if value.bullet_id in result.added_candidate_ids
    )
    assert repaired.source_fact_ids == ("fact-1",)
    assert repaired.covered_requirement_ids == ("req-python",)


def test_local_candidate_repair_rejects_changed_fact_ids_atomically() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")
    quality = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)
    draft = LocalRepairBatchDraft(
        repairs=(
            LocalRepairChoiceDraft(
                bullet_id="bullet-1",
                candidates=(
                    LocalRepairCandidateDraft(
                        text="使用 Python 优化接口处理流程",
                        source_fact_ids=("invented-fact",),
                        covered_requirement_ids=("req-python",),
                    ),
                ),
            ),
        )
    )

    result = ResumeLocalCandidateRepairService(ResumeLayoutService(PillowFontMetrics())).apply(
        plan,
        retrieval,
        candidates,
        compiled.selected_candidate_ids,
        quality.repairable_bullet_ids,
        draft,
        language="zh-CN",
    )

    assert result.status == "rejected"
    assert result.candidates == candidates


def test_local_candidate_repair_falls_back_to_verbatim_grounded_facts() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")
    grounded_text = (
        "使用 Python 对接口处理流程进行系统优化，"
        "通过重构处理逻辑将接口响应时间降低 20%"
    )
    retrieval = retrieval.model_copy(
        update={
            "facts": (
                retrieval.facts[0].model_copy(update={"source_text": grounded_text}),
            )
        }
    )
    quality = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)
    draft = LocalRepairBatchDraft(
        repairs=(
            LocalRepairChoiceDraft(
                bullet_id="bullet-1",
                candidates=(
                    LocalRepairCandidateDraft(
                        text="使用 Kubernetes 优化接口处理流程",
                        source_fact_ids=("fact-1",),
                        covered_requirement_ids=("req-python",),
                    ),
                ),
            ),
        )
    )

    result = ResumeLocalCandidateRepairService(ResumeLayoutService(PillowFontMetrics())).apply(
        plan,
        retrieval,
        candidates,
        compiled.selected_candidate_ids,
        quality.repairable_bullet_ids,
        draft,
        language="zh-CN",
    )

    assert result.status == "applied"
    repaired = next(
        value for value in result.candidates if value.bullet_id in result.added_candidate_ids
    )
    assert repaired.text == grounded_text
    assert repaired.source_fact_ids == ("fact-1",)


def test_local_candidate_repair_prefers_grounded_facts_for_browser_orphan() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")
    grounded_text = (
        "使用 Python 对接口处理流程进行系统优化，"
        "通过重构处理逻辑将接口响应时间降低 20%"
    )
    retrieval = retrieval.model_copy(
        update={
            "facts": (
                retrieval.facts[0].model_copy(update={"source_text": grounded_text}),
            )
        }
    )
    quality = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)
    draft = LocalRepairBatchDraft(
        repairs=(
            LocalRepairChoiceDraft(
                bullet_id="bullet-1",
                candidates=(
                    LocalRepairCandidateDraft(
                        text="使用 Python 优化接口处理流程，将响应时间降低 20%，并建立回归验证流程",
                        source_fact_ids=("fact-1",),
                        covered_requirement_ids=("req-python",),
                    ),
                ),
            ),
        )
    )

    result = ResumeLocalCandidateRepairService(ResumeLayoutService(PillowFontMetrics())).apply(
        plan,
        retrieval,
        candidates,
        compiled.selected_candidate_ids,
        quality.repairable_bullet_ids,
        draft,
        language="zh-CN",
        prefer_grounded_fallback_ids=("bullet-1",),
    )

    assert result.status == "applied"
    repaired = next(
        value for value in result.candidates if value.bullet_id in result.added_candidate_ids
    )
    assert repaired.text == grounded_text


class _BoundedRepairProvider:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[float, int]] = []

    async def chat_structured_bounded(
        self,
        messages,
        schema,
        *,
        temperature,
        deadline_seconds,
        max_attempts,
    ):
        self.calls.append((deadline_seconds, max_attempts))
        if self.fail:
            raise StructuredCallBudgetError(
                "timeout",
                attempts=1,
                protocol="json_schema",
                error_category="TimeoutError",
            )
        return StructuredCallResult(
            value={
                "repairs": [
                    {
                        "bullet_id": "bullet-1",
                        "candidates": [
                            {
                                "text": (
                                    "使用 Python 对接口处理流程进行系统优化，"
                                    "通过重构处理逻辑将接口响应时间降低 20%"
                                ),
                                "source_fact_ids": ["fact-1"],
                                "covered_requirement_ids": ["req-python"],
                            }
                        ],
                    }
                ]
            },
            attempts=1,
            protocol="json_schema",
        )


async def test_local_repair_writer_uses_exactly_one_bounded_provider_attempt() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")
    quality = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)
    provider = _BoundedRepairProvider()

    result = await ResumeLocalRepairWriter(provider).write(  # type: ignore[arg-type]
        quality,
        candidates,
        retrieval,
        compiled,
        language="zh-CN",
        deadline_seconds=15.0,
    )

    assert result.draft is not None
    assert result.attempts == 1
    assert provider.calls == [(15.0, 1)]


async def test_local_repair_writer_does_not_retry_after_budget_failure() -> None:
    plan, retrieval, candidates, compiled, constraint = _fixture(fit_status="awkward_wrap")
    quality = ResumeQualityGateService().validate(plan, retrieval, candidates, compiled, constraint)
    provider = _BoundedRepairProvider(fail=True)

    result = await ResumeLocalRepairWriter(provider).write(  # type: ignore[arg-type]
        quality,
        candidates,
        retrieval,
        compiled,
        language="zh-CN",
        deadline_seconds=15.0,
    )

    assert result.draft is None
    assert result.attempts == 1
    assert result.error_category == "TimeoutError"
    assert provider.calls == [(15.0, 1)]


def test_real_font_compile_repair_recompile_and_revalidate_cycle() -> None:
    plan, candidates, scaffold = _benchmark_inputs(100, 10)
    constraint = LayoutConstraint(
        max_pages=1,
        requested_pages=1,
        minimum_page_usage_ratio=0.85,
        target_page_usage_ratio=0.90,
        maximum_page_usage_ratio=0.98,
    )
    layout = ResumeLayoutService(PillowFontMetrics())
    first = ResumeLayoutCompiler(layout, exact_candidate_limit=64).compile(
        plan,
        candidates,
        scaffold,
        constraint,
        template_id="resume-standard",
        language="zh-CN",
    )
    assert first.compiled_resume is not None
    retrieval = _benchmark_retrieval(plan.requirements, candidates, scaffold)
    baseline = ResumeQualityGateService().validate(
        plan,
        retrieval,
        candidates,
        first.compiled_resume,
        constraint,
    )
    assert baseline.status == "passed"

    target_id = first.compiled_resume.selected_candidate_ids[0]
    original = next(value for value in candidates if value.bullet_id == target_id)
    corrupted = original.model_copy(
        update={"text": original.text + "，使用 Kubernetes 将效率提升 9999%"}
    )
    corrupted_candidates = tuple(
        corrupted if value.bullet_id == target_id else value for value in candidates
    )
    corrupted_compiled = first.compiled_resume.model_copy(deep=True)
    for section in corrupted_compiled.structured_resume["sections"]:
        for item in section.get("items") or []:
            for bullet in item.get("bullets") or []:
                if bullet.get("id") == target_id:
                    bullet["text"] = corrupted.text
    failed = ResumeQualityGateService().validate(
        plan,
        retrieval,
        corrupted_candidates,
        corrupted_compiled,
        constraint,
    )
    assert failed.status == "repairable"
    assert failed.repairable_bullet_ids == (target_id,)

    repaired = ResumeLocalCandidateRepairService(layout).apply(
        plan,
        retrieval,
        corrupted_candidates,
        corrupted_compiled.selected_candidate_ids,
        failed.repairable_bullet_ids,
        LocalRepairBatchDraft(
            repairs=(
                LocalRepairChoiceDraft(
                    bullet_id=target_id,
                    candidates=(
                        LocalRepairCandidateDraft(
                            text=original.text,
                            source_fact_ids=original.source_fact_ids,
                            covered_requirement_ids=original.covered_requirement_ids,
                        ),
                    ),
                ),
            )
        ),
        language="zh-CN",
    )
    assert repaired.status == "applied"
    second = ResumeLayoutCompiler(layout, exact_candidate_limit=64).compile(
        plan,
        repaired.candidates,
        scaffold,
        constraint,
        template_id="resume-standard",
        language="zh-CN",
    )
    assert second.compiled_resume is not None
    final = ResumeQualityGateService().validate(
        plan,
        retrieval,
        repaired.candidates,
        second.compiled_resume,
        constraint,
    )
    assert final.status == "passed"
    assert final.grounding.ungrounded_bullets == 0
    assert 0.85 <= final.page_usage_ratio <= 0.98
