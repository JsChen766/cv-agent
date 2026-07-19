from __future__ import annotations

from app.domain.resume.candidates.models import CandidateBullet
from app.domain.resume.compiler.service import ResumeLayoutCompiler
from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import RetrievalRequirement
from app.infra.layout import PillowFontMetrics


def _inputs(
    group_count: int = 45,
) -> tuple[ResumePlan, tuple[CandidateBullet, ...], dict[str, object]]:
    requirement = RetrievalRequirement(
        requirement_id="req-python",
        description="Python backend engineering",
        category="technology",
        keywords=("Python",),
        importance="must_have",
        weight=1.0,
    )
    fact_ids = tuple(f"fact-{index}" for index in range(group_count))
    candidates: list[CandidateBullet] = []
    for index, fact_id in enumerate(fact_ids):
        experience_id = "exp-work" if index % 2 == 0 else "exp-project"
        base = f"使用 Python 完成第{index + 1}项后端服务设计、测试与交付"
        texts = {
            "short": base,
            "medium": base + "，建立可复用的数据校验与异常处理流程",
            "long": base + "，建立可复用的数据校验、异常处理、发布监控与协作流程",
        }
        for variant, text in texts.items():
            candidates.append(
                CandidateBullet(
                    bullet_id=f"bullet-{index}-{variant}",
                    candidate_group_id=f"group-{index}",
                    experience_id=experience_id,
                    text=text,
                    source_fact_ids=(fact_id,),
                    covered_requirement_ids=("req-python",),
                    quality_score=round(1.0 - index * 0.01, 4),
                    estimated_lines=1,
                    estimated_height_mm=4.0,
                    length_variant=variant,  # type: ignore[arg-type]
                )
            )
    plan = ResumePlan(
        plan_version="plan-test",
        requirements=(requirement,),
        selected_experience_ids=("exp-work", "exp-project", "exp-education"),
        selected_fact_ids=fact_ids,
        fact_requirement_map={value: ("req-python",) for value in fact_ids},
        section_height_budgets_mm={"work": 80.0, "project": 60.0},
        experience_height_budgets_mm={"exp-work": 80.0, "exp-project": 60.0},
        target_candidate_lines=35,
        target_final_usage_ratio=0.90,
        estimated_page_height_mm=250.0,
        estimated_usage_ratio=0.90,
        objective_score=1.0,
        selection_reasons={value: ("selected",) for value in fact_ids},
        rejection_reasons={},
    )
    profile = DEFAULT_RESUME_LAYOUT_PROFILE
    scaffold: dict[str, object] = {
        "language": "zh-CN",
        "layout_template_id": "resume-standard",
        "layout_profile_version": profile.version,
        "layout_profile_hash": profile.profile_hash,
        "contact": {"name": "测试用户", "email": "user@example.com"},
        "sections": [
            {
                "id": "education",
                "type": "education",
                "heading": "教育经历",
                "items": [
                    {
                        "id": "item-education",
                        "source_experience_id": "exp-education",
                        "title": "计算机科学",
                        "organization": "示例大学",
                        "start_date": "2018-09",
                        "end_date": "2022-06",
                        "raw_text": "工学学士",
                        "bullets": [],
                    }
                ],
            },
            {
                "id": "experience",
                "type": "experience",
                "heading": "工作经历",
                "items": [
                    {
                        "id": "item-work",
                        "source_experience_id": "exp-work",
                        "title": "后端工程师",
                        "organization": "示例公司",
                        "start_date": "2022-07",
                        "end_date": "2025-06",
                        "bullets": [],
                    }
                ],
            },
            {
                "id": "project",
                "type": "project",
                "heading": "项目经历",
                "items": [
                    {
                        "id": "item-project",
                        "source_experience_id": "exp-project",
                        "title": "服务治理平台",
                        "role": "项目负责人",
                        "start_date": "2023-01",
                        "end_date": "2024-12",
                        "bullets": [],
                    }
                ],
            },
        ],
    }
    return plan, tuple(candidates), scaffold


def _constraint() -> LayoutConstraint:
    return LayoutConstraint(
        max_pages=1,
        requested_pages=1,
        minimum_page_usage_ratio=0.85,
        target_page_usage_ratio=0.90,
        maximum_page_usage_ratio=0.98,
    )


def test_compiler_selects_one_version_per_group_in_v2_height_band() -> None:
    plan, candidates, scaffold = _inputs()
    compiler = ResumeLayoutCompiler(
        ResumeLayoutService(PillowFontMetrics()), beam_width=256, exact_candidate_limit=48
    )

    result = compiler.compile(
        plan,
        candidates,
        scaffold,
        _constraint(),
        template_id="resume-standard",
        language="zh-CN",
    )

    assert result.status == "compiled"
    assert result.compiled_resume is not None
    compiled = result.compiled_resume
    report = compiled.layout_report
    assert report.page_count == 1
    assert report.overflow_mm == 0
    assert 0.85 <= report.pages[0].usage_ratio <= 0.98
    assert len(compiled.selected_candidate_group_ids) == len(
        set(compiled.selected_candidate_group_ids)
    )
    assert len(compiled.selected_fact_ids) == len(set(compiled.selected_fact_ids))
    section_types = {value["type"] for value in compiled.structured_resume["sections"]}
    assert {"education", "experience", "project"}.issubset(section_types)


def test_compiler_measurement_cache_is_stable_across_recompile() -> None:
    plan, candidates, scaffold = _inputs()
    compiler = ResumeLayoutCompiler(ResumeLayoutService(PillowFontMetrics()))

    first = compiler.compile(
        plan,
        candidates,
        scaffold,
        _constraint(),
        template_id="resume-standard",
        language="zh-CN",
    )
    second = compiler.compile(
        plan,
        candidates,
        scaffold,
        _constraint(),
        template_id="resume-standard",
        language="zh-CN",
    )

    assert first.status == second.status == "compiled"
    assert first.compiled_resume == second.compiled_resume
    assert first.diagnostics.measurement_cache_misses == len(candidates)
    assert second.diagnostics.measurement_cache_hits == len(candidates)
    assert second.diagnostics.measurement_cache_misses == 0


def test_underfilled_pool_is_exhausted_without_delete_or_shorten_actions() -> None:
    plan, candidates, scaffold = _inputs(group_count=1)
    result = ResumeLayoutCompiler(ResumeLayoutService(PillowFontMetrics())).compile(
        plan,
        candidates,
        scaffold,
        _constraint(),
        template_id="resume-standard",
        language="zh-CN",
    )

    assert result.status == "underfilled"
    assert result.compiled_resume is None
    assert result.diagnostics.unused_candidate_groups == 0
    assert result.failure_reasons == ("maximum_grounded_candidate_height_below_minimum",)


def test_browser_scale_recompile_still_requires_backend_and_browser_bands() -> None:
    plan, candidates, scaffold = _inputs()
    result = ResumeLayoutCompiler(
        ResumeLayoutService(PillowFontMetrics()), exact_candidate_limit=64
    ).compile(
        plan,
        candidates,
        scaffold,
        _constraint(),
        template_id="resume-standard",
        language="zh-CN",
        browser_scale=0.93,
    )

    assert result.status == "compiled"
    assert result.compiled_resume is not None
    backend = result.compiled_resume.layout_report.pages[0].usage_ratio
    assert 0.85 <= backend <= 0.98
    assert 0.85 <= backend * result.diagnostics.browser_scale <= 0.98


def test_compiler_fails_closed_when_planned_fact_has_no_candidate() -> None:
    plan, candidates, scaffold = _inputs(group_count=3)
    candidates = tuple(value for value in candidates if value.source_fact_ids != ("fact-2",))

    result = ResumeLayoutCompiler(ResumeLayoutService(PillowFontMetrics())).compile(
        plan,
        candidates,
        scaffold,
        _constraint(),
        template_id="resume-standard",
        language="zh-CN",
    )

    assert result.status == "infeasible"
    assert result.failure_reasons == ("planned_fact_missing_from_candidate_pool",)
    assert result.diagnostics.exact_layout_calls == 0
