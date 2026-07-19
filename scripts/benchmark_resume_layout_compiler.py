from __future__ import annotations

import argparse
import statistics
import time
from typing import Literal

from app.domain.resume.candidates.models import CandidateBullet
from app.domain.resume.compiler.service import ResumeLayoutCompiler
from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.planning.models import ResumePlan
from app.domain.resume.retrieval.models import RetrievalRequirement
from app.infra.layout import PillowFontMetrics


def _inputs(
    groups: int,
    experiences: int,
) -> tuple[ResumePlan, tuple[CandidateBullet, ...], dict[str, object]]:
    requirement_values = tuple(
        RetrievalRequirement(
            requirement_id=f"req-{index}",
            description=f"岗位核心要求 {index}",
            category="responsibility",
            keywords=("Python", f"能力{index}"),
            importance="must_have" if index < 3 else "preferred",
            weight=1.0 if index < 3 else 0.6,
        )
        for index in range(6)
    )
    experience_ids = tuple(f"exp-{index}" for index in range(experiences))
    fact_ids = tuple(f"fact-{index}" for index in range(groups))
    candidates: list[CandidateBullet] = []
    for index, fact_id in enumerate(fact_ids):
        experience_id = experience_ids[index % experiences]
        requirement_id = f"req-{index % len(requirement_values)}"
        base = (
            f"负责第{index + 1}项 Python 服务的方案设计、核心开发与测试交付，"
            "建立可追溯的数据校验和异常处理流程"
        )
        texts: tuple[tuple[Literal["short", "medium", "long"], str], ...] = (
            ("short", base),
            ("medium", base + "，完善发布监控、故障定位和跨团队协作机制"),
            (
                "long",
                base + "，完善发布监控、故障定位、容量评估和跨团队协作机制，沉淀复用规范与交付文档",
            ),
        )
        for variant, text in texts:
            candidates.append(
                CandidateBullet(
                    bullet_id=f"bullet-{index}-{variant}",
                    candidate_group_id=f"group-{index}",
                    experience_id=experience_id,
                    text=text,
                    source_fact_ids=(fact_id,),
                    covered_requirement_ids=(requirement_id,),
                    quality_score=round(0.9 - index * 0.005, 4),
                    estimated_lines=2,
                    estimated_height_mm=8.0,
                    length_variant=variant,
                )
            )
    plan = ResumePlan(
        plan_version="benchmark-plan",
        requirements=requirement_values,
        selected_experience_ids=(*experience_ids, "exp-education"),
        selected_fact_ids=fact_ids,
        fact_requirement_map={
            fact_id: (f"req-{index % len(requirement_values)}",)
            for index, fact_id in enumerate(fact_ids)
        },
        section_height_budgets_mm={"work": 120.0, "project": 60.0},
        experience_height_budgets_mm={value: 40.0 for value in experience_ids},
        target_candidate_lines=45,
        target_final_usage_ratio=0.90,
        estimated_page_height_mm=251.0,
        estimated_usage_ratio=0.90,
        objective_score=1.0,
        selection_reasons={value: ("selected",) for value in fact_ids},
        rejection_reasons={},
    )
    work_ids = experience_ids[:-1] if experiences > 1 else experience_ids
    project_ids = experience_ids[-1:] if experiences > 1 else ()
    profile = DEFAULT_RESUME_LAYOUT_PROFILE
    sections: list[dict[str, object]] = [
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
            "items": [_item(value, index) for index, value in enumerate(work_ids)],
        },
    ]
    if project_ids:
        sections.append(
            {
                "id": "project",
                "type": "project",
                "heading": "项目经历",
                "items": [_item(value, experiences) for value in project_ids],
            }
        )
    scaffold: dict[str, object] = {
        "language": "zh-CN",
        "layout_template_id": "resume-standard",
        "layout_profile_version": profile.version,
        "layout_profile_hash": profile.profile_hash,
        "contact": {
            "name": "测试用户",
            "email": "user@example.com",
            "phone": "+86 138 0000 0000",
        },
        "sections": sections,
    }
    return plan, tuple(candidates), scaffold


def _item(experience_id: str, index: int) -> dict[str, object]:
    return {
        "id": f"item-{experience_id}",
        "source_experience_id": experience_id,
        "title": f"后端工程师 {index}",
        "organization": f"示例组织 {index}",
        "start_date": "2022-01",
        "end_date": "2025-06",
        "bullets": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark the stage-G height-constrained resume layout compiler."
    )
    parser.add_argument("--groups", type=int, default=30)
    parser.add_argument("--experiences", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--beam-width", type=int, default=256)
    args = parser.parse_args()
    plan, candidates, scaffold = _inputs(args.groups, args.experiences)
    constraint = LayoutConstraint(
        max_pages=1,
        requested_pages=1,
        minimum_page_usage_ratio=0.85,
        target_page_usage_ratio=0.90,
        maximum_page_usage_ratio=0.98,
    )
    compiler = ResumeLayoutCompiler(
        ResumeLayoutService(PillowFontMetrics()),
        beam_width=args.beam_width,
        exact_candidate_limit=32,
    )
    durations: list[float] = []
    result = None
    for _ in range(args.iterations):
        started = time.perf_counter()
        result = compiler.compile(
            plan,
            candidates,
            scaffold,
            constraint,
            template_id="resume-standard",
            language="zh-CN",
        )
        durations.append((time.perf_counter() - started) * 1000)
    if result is None or result.compiled_resume is None:
        raise RuntimeError(f"compiler did not find a feasible result: {result}")
    diagnostics = result.diagnostics
    print(
        " ".join(
            (
                f"groups={args.groups}",
                f"candidates={len(candidates)}",
                f"experiences={args.experiences}",
                f"iterations={args.iterations}",
                f"cold_ms={durations[0]:.2f}",
                f"warm_median_ms={statistics.median(durations[1:] or durations):.2f}",
                f"max_ms={max(durations):.2f}",
                f"usage={diagnostics.final_usage_ratio:.4f}",
                f"selected={diagnostics.selected_candidates}",
                f"expanded={diagnostics.expanded_states}",
                f"cache_hits={diagnostics.measurement_cache_hits}",
                f"exact_calls={diagnostics.exact_layout_calls}",
            )
        )
    )


if __name__ == "__main__":
    main()
