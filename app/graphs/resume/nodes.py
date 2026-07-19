"""
Resume Generation subgraph nodes.

Flow:
  context_assembly → cot_planning → draft_generation →
  layout_measure → fact_check → coverage_check → self_review → quality_gate
"""

import asyncio
import json
import logging
import math
import re
import time
import uuid
from collections.abc import Mapping
from typing import Literal, cast

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field, JsonValue, ValidationError

from app.core.config import settings
from app.core.events import AgentInterruptEvent
from app.core.observability import current_recorder, observation_span
from app.domain.resume.content_budget import build_resume_content_budget
from app.domain.resume.content_style import normalize_resume_narrative_punctuation
from app.domain.resume.layout_models import LayoutConstraint, LayoutReport, LayoutViolation
from app.domain.resume.layout_optimizer import ResumeLayoutOptimizer
from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.domain.resume.layout_templates import (
    STANDARD_RESUME_TEMPLATE,
    ResumeTemplateDefinition,
    get_resume_template,
    select_resume_template,
)
from app.domain.resume.models import ResumeVariantCreate
from app.domain.resume.observability_models import BrowserLayoutObservationInput
from app.domain.resume.planning.projection import project_resume_plan
from app.domain.resume.planning.service import ResumePlanService
from app.domain.resume.render import render_structured_to_markdown
from app.domain.resume.repair_models import BulletRepairBatch
from app.domain.resume.repair_service import ResumeBulletRepairService
from app.domain.resume.retrieval.models import HybridRetrievalResult
from app.domain.resume.sufficiency.models import MaterialSufficiencyReport
from app.domain.resume.sufficiency.service import MaterialSufficiencyService
from app.graphs.resume.state import ResumeGenerationState
from app.graphs.runtime import pool_from_config, services_from_config
from app.graphs.streaming import (
    emit_content_diff_progress,
    emit_thinking,
    get_optional_stream_writer,
)
from app.providers.base import LLMProvider
from app.providers.factory import get_provider
from app.tools.actions import capabilities as action_capabilities
from app.tools.actions.models import VariantInput

logger = logging.getLogger(__name__)

# ── 1. Context Assembly ───────────────────────────────────────────────────────


async def context_assembly_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Gather all context needed for resume generation."""
    if state.get("resume_context_ready"):
        return {}
    from app.memory.context_assembly import assemble_context

    extracted = state.get("extracted_params", {})
    raw_jd = extracted.get("raw_jd_text") or extracted.get("jd_text")
    fallback_jd_text = raw_jd if isinstance(raw_jd, str) and raw_jd.strip() else None

    try:
        pool = pool_from_config(config)
        if pool is None:
            return {
                "jd_text": fallback_jd_text,
                "resume_context_ready": True,
            }
        ctx = await assemble_context(
            state,
            pool,
            services=services_from_config(config),
        )
        return {
            "jd_text": ctx.jd_text or fallback_jd_text,
            "jd_requirements": ctx.jd_requirements,
            "relevant_experiences": ctx.experiences,
            "guideline_instructions": ctx.guideline_instructions,
            "user_preferences": ctx.preferences,
            "user_profile": ctx.user_profile,
            "evidence_pack": ctx.evidence_pack.model_dump() if ctx.evidence_pack else None,
            "fact_retrieval_result": ctx.fact_retrieval_result,
            "resume_context_ready": True,
        }
    except RuntimeError:
        # Pool not available (test mode)
        return {
            "jd_text": fallback_jd_text,
            "resume_context_ready": True,
        }


# ── 1.25. Full-FactBank material sufficiency ─────────────────────────────────


async def material_sufficiency_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Prove whether the complete FactBank can support the minimum page height."""
    if not settings.resume_material_sufficiency_enabled:
        return {"material_sufficiency_status": "disabled"}
    raw_retrieval = state.get("fact_retrieval_result")
    services = services_from_config(config)
    layout = services.resume_layout if services is not None else None
    if not isinstance(raw_retrieval, dict) or layout is None:
        logger.warning(
            "Material sufficiency unavailable: retrieval=%s layout=%s",
            isinstance(raw_retrieval, dict),
            layout is not None,
        )
        return _material_sufficiency_unavailable("fact_retrieval_or_layout_unavailable")

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在核算完整经历库可支持的简历高度…")
    try:
        retrieval = HybridRetrievalResult.model_validate(raw_retrieval)
    except ValidationError as exc:
        logger.warning("Material sufficiency retrieval payload is invalid: %s", exc)
        return _material_sufficiency_unavailable("invalid_fact_retrieval_result")
    integrity_error = _retrieval_integrity_error(retrieval)
    if integrity_error is not None:
        logger.warning(
            "Material sufficiency retrieval payload failed integrity checks: %s",
            integrity_error,
        )
        return _material_sufficiency_unavailable(integrity_error)
    profile = state.get("user_profile") or {}
    language = _normalize_resume_language(profile.get("preferred_language")) or "zh-CN"
    constraint = _layout_constraint_from_state(state)
    started_at = time.perf_counter()
    try:
        report = MaterialSufficiencyService(
            layout,
            minimum_fact_score=settings.resume_material_min_fact_score,
            minimum_fact_strength=settings.resume_material_min_fact_strength,
            maximum_fact_lines=settings.resume_material_max_fact_lines,
        ).assess(
            retrieval,
            user_profile=profile,
            minimum_usage_ratio=constraint.minimum_page_usage_ratio,
            language=language,
        )
    except Exception:  # noqa: BLE001 -- a broken measurement must never allow a gap prompt
        logger.exception("Material sufficiency measurement failed")
        return _material_sufficiency_unavailable("layout_measurement_failed")
    logger.info(
        "Material sufficiency completed",
        extra={
            "status": report.status,
            "total_experiences": report.total_experiences,
            "total_facts": report.total_facts,
            "qualified_facts": report.qualified_facts,
            "global_supported_height_mm": report.global_supported_height_mm,
            "minimum_required_height_mm": report.minimum_required_height_mm,
            "missing_height_mm": report.missing_height_mm,
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 2),
        },
    )
    return {
        "material_sufficiency_report": report.model_dump(mode="json"),
        "material_sufficiency_status": report.status,
        "layout_constraint": constraint.model_dump(mode="json"),
    }


def material_sufficiency_route(state: ResumeGenerationState) -> str:
    status = state.get("material_sufficiency_status")
    if status == "insufficient":
        return "content_gap"
    if status == "unavailable":
        return "failed"
    if status == "sufficient" and settings.resume_plan_enabled:
        return "resume_planning"
    return "experience_selection"


def _material_sufficiency_unavailable(reason: str) -> dict[str, object]:
    return {
        "material_sufficiency_status": "unavailable",
        "quality_status": "failed",
        "quality_issues": [
            {
                "code": "material_sufficiency_unavailable",
                "message": reason,
            }
        ],
    }


def _retrieval_integrity_error(retrieval: HybridRetrievalResult) -> str | None:
    experience_ids = [value.experience_id for value in retrieval.experiences]
    fact_ids = [value.fact_id for value in retrieval.facts]
    requirement_ids = [value.requirement_id for value in retrieval.requirements]
    if len(retrieval.experiences) != retrieval.diagnostics.total_experiences:
        return "incomplete_retrieval_experience_metadata"
    if len(retrieval.facts) != retrieval.diagnostics.total_facts:
        return "incomplete_retrieval_fact_payload"
    if len(experience_ids) != len(set(experience_ids)):
        return "duplicate_retrieval_experience_id"
    if len(fact_ids) != len(set(fact_ids)):
        return "duplicate_retrieval_fact_id"
    if len(requirement_ids) != len(set(requirement_ids)):
        return "duplicate_retrieval_requirement_id"
    experience_by_id = {value.experience_id: value for value in retrieval.experiences}
    requirement_id_set = set(requirement_ids)
    for fact in retrieval.facts:
        experience = experience_by_id.get(fact.experience_id)
        if experience is None:
            return "incomplete_retrieval_experience_metadata"
        if fact.source_revision_id != experience.revision_id:
            return "fact_revision_ownership_mismatch"
        if not set(fact.matched_requirement_ids).issubset(requirement_id_set):
            return "fact_requirement_ownership_mismatch"
    selected_fact_ids = set(retrieval.selected_fact_ids)
    if len(selected_fact_ids) != len(retrieval.selected_fact_ids):
        return "duplicate_selected_fact_id"
    if not selected_fact_ids.issubset(set(fact_ids)):
        return "selected_fact_missing_from_retrieval"
    return None


# ── 1.375. Authoritative ResumePlan ─────────────────────────────────────────


async def resume_planning_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    raw_retrieval = state.get("fact_retrieval_result")
    raw_sufficiency = state.get("material_sufficiency_report")
    services = services_from_config(config)
    layout = services.resume_layout if services is not None else None
    if (
        not isinstance(raw_retrieval, dict)
        or not isinstance(raw_sufficiency, dict)
        or layout is None
    ):
        return _resume_plan_failure("resume_plan_inputs_unavailable")
    try:
        retrieval = HybridRetrievalResult.model_validate(raw_retrieval)
        sufficiency = MaterialSufficiencyReport.model_validate(raw_sufficiency)
        constraint = LayoutConstraint.model_validate(
            state.get("layout_constraint") or _layout_constraint_from_state(state).model_dump()
        )
    except ValidationError as exc:
        logger.warning("ResumePlan input validation failed: %s", exc)
        return _resume_plan_failure("invalid_resume_plan_inputs")

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在生成统一的事实选择与页面高度计划…")
    started_at = time.perf_counter()
    result = ResumePlanService(
        beam_width=settings.resume_plan_beam_width,
        max_optimizer_facts=settings.resume_plan_max_optimizer_facts,
        near_duplicate_threshold=settings.resume_plan_near_duplicate_threshold,
    ).build(
        retrieval,
        sufficiency,
        minimum_usage_ratio=constraint.minimum_page_usage_ratio,
        target_usage_ratio=constraint.target_page_usage_ratio,
        maximum_usage_ratio=constraint.maximum_page_usage_ratio,
        line_height_mm=layout.profile.body.line_height_mm,
        candidate_pool_target_ratio=settings.resume_candidate_pool_target_ratio,
    )
    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    logger.info(
        "ResumePlan completed",
        extra={
            "status": result.status,
            "considered_facts": result.diagnostics.considered_facts,
            "qualified_facts": result.diagnostics.qualified_facts,
            "expanded_states": result.diagnostics.expanded_states,
            "pruned_states": result.diagnostics.pruned_states,
            "duration_ms": duration_ms,
        },
    )
    if result.plan is None:
        return {
            **_resume_plan_failure("resume_plan_infeasible"),
            "resume_plan_status": result.status,
            "resume_plan_diagnostics": result.diagnostics.model_dump(mode="json"),
            "quality_issues": [
                {
                    "code": "resume_plan_infeasible",
                    "message": ", ".join(result.failure_reasons),
                }
            ],
        }
    projection = project_resume_plan(
        retrieval,
        result.plan,
        candidate_pool_target_ratio=settings.resume_candidate_pool_target_ratio,
    )
    return {
        "resume_plan": result.plan.model_dump(mode="json"),
        "resume_plan_status": "ready",
        "resume_plan_diagnostics": result.diagnostics.model_dump(mode="json"),
        **projection,
        "layout_constraint": constraint.model_dump(mode="json"),
        "layout_profile_version": layout.profile.version,
        "layout_profile_hash": layout.profile.profile_hash,
        "layout_template_id": STANDARD_RESUME_TEMPLATE.template_id,
    }


def resume_planning_route(state: ResumeGenerationState) -> str:
    return "draft_generation" if state.get("resume_plan_status") == "ready" else "failed"


def _resume_plan_failure(reason: str) -> dict[str, object]:
    return {
        "resume_plan": None,
        "resume_plan_status": "infeasible",
        "quality_status": "failed",
        "quality_issues": [{"code": "resume_plan_infeasible", "message": reason}],
    }


# ── 1.5. Experience Selection ────────────────────────────────────────────────


async def experience_selection_node(
    state: ResumeGenerationState,
) -> dict[str, object]:
    """Deterministic scoring and selection of experiences for resume inclusion."""
    from app.domain.resume.experience_selector import select_experiences

    experiences = state.get("relevant_experiences") or []
    evidence_pack = state.get("evidence_pack") or {}

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在筛选与岗位最匹配的经历…")

    result = select_experiences(
        experiences,
        evidence_pack,
        max_narrative_experiences=settings.resume_max_narrative_experiences,
        min_composite_score=settings.resume_min_experience_score,
        target_total_bullets=settings.resume_target_total_bullets,
    )

    selected_ids = {s.experience_id for s in result.selected}
    selected_experiences = [exp for exp in experiences if str(exp.get("id") or "") in selected_ids]

    return {
        "selected_experiences": selected_experiences,
        "experience_selection_result": result.model_dump(mode="json"),
    }


# ── 2. CoT Planning ───────────────────────────────────────────────────────────


class CoveragePlanItem(BaseModel):
    requirement_id: str
    requirement_text: str
    planned_source_experience_ids: list[str] = Field(default_factory=list)


class MatchingPlan(BaseModel):
    strategy: str
    key_experiences_to_highlight: list[str]
    skills_to_emphasize: list[str]
    tone: str = "professional"
    structure_suggestions: list[str] = Field(default_factory=list)
    coverage_plan: list[CoveragePlanItem] = Field(default_factory=list)


async def cot_planning_node(state: ResumeGenerationState) -> dict[str, object]:
    """Build a deterministic JD/evidence content budget without an LLM call."""
    experiences = (
        state.get("selected_experiences")
        or state.get("relevant_experiences")
        or state.get("assembled_experiences", [])
    )
    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在计算岗位匹配度与一页简历内容预算…")
    budget = build_resume_content_budget(
        experiences,
        state.get("evidence_pack") or {},
        target_usage_ratio=settings.resume_target_page_usage_ratio,
        candidate_pool_target_ratio=settings.resume_candidate_pool_target_ratio,
    )
    layout_constraint = _layout_constraint_from_state(state)
    ranked = sorted(budget.experiences, key=lambda value: value.jd_match_score, reverse=True)
    plan = {
        "strategy": "deterministic_evidence_budget",
        "key_experiences_to_highlight": [value.experience_id for value in ranked[:4]],
        "skills_to_emphasize": [],
        "tone": "professional",
        "structure_suggestions": [],
        "coverage_plan": [],
    }
    return {
        "matching_plan": plan,
        "generation_strategy": "deterministic_evidence_budget",
        "content_budget": budget.model_dump(),
        "layout_constraint": layout_constraint.model_dump(),
        "layout_profile_version": DEFAULT_RESUME_LAYOUT_PROFILE.version,
        "layout_profile_hash": DEFAULT_RESUME_LAYOUT_PROFILE.profile_hash,
        "layout_template_id": STANDARD_RESUME_TEMPLATE.template_id,
    }


# ── 3. Draft Generation ───────────────────────────────────────────────────────


def _layout_constraint_from_state(state: ResumeGenerationState) -> LayoutConstraint:
    extracted = state.get("extracted_params", {})
    raw_pages = extracted.get("page_count") or extracted.get("pages")
    if isinstance(raw_pages, int) and raw_pages == 1:
        return LayoutConstraint(
            max_pages=1,
            requested_pages=1,
            minimum_page_usage_ratio=settings.resume_min_page_usage_ratio,
            target_page_usage_ratio=settings.resume_target_page_usage_ratio,
            maximum_page_usage_ratio=settings.resume_max_page_usage_ratio,
        )
    if isinstance(raw_pages, int) and raw_pages >= 2:
        return LayoutConstraint(
            max_pages=None,
            requested_pages=raw_pages,
            minimum_page_usage_ratio=settings.resume_min_page_usage_ratio,
            target_page_usage_ratio=settings.resume_target_page_usage_ratio,
            maximum_page_usage_ratio=settings.resume_max_page_usage_ratio,
        )
    intent = str(state.get("intent_description") or "")
    if re.search(r"(?:two|2|两|二)\s*(?:pages?|页)", intent, re.IGNORECASE):
        return LayoutConstraint(
            max_pages=None,
            requested_pages=2,
            minimum_page_usage_ratio=settings.resume_min_page_usage_ratio,
            target_page_usage_ratio=settings.resume_target_page_usage_ratio,
            maximum_page_usage_ratio=settings.resume_max_page_usage_ratio,
        )
    if re.search(r"(?:multi|multiple|多)\s*(?:pages?|页)", intent, re.IGNORECASE):
        return LayoutConstraint(
            max_pages=None,
            minimum_page_usage_ratio=settings.resume_min_page_usage_ratio,
            target_page_usage_ratio=settings.resume_target_page_usage_ratio,
            maximum_page_usage_ratio=settings.resume_max_page_usage_ratio,
        )
    if re.search(r"(?:one|1|single|一|单)\s*(?:pages?|页(?:纸)?)", intent, re.IGNORECASE):
        return LayoutConstraint(
            max_pages=1,
            requested_pages=1,
            minimum_page_usage_ratio=settings.resume_min_page_usage_ratio,
            target_page_usage_ratio=settings.resume_target_page_usage_ratio,
            maximum_page_usage_ratio=settings.resume_max_page_usage_ratio,
        )
    # Product default is a hard single page. Only explicit multi-page input above
    # may remove the cap.
    return LayoutConstraint(
        max_pages=1,
        requested_pages=1,
        minimum_page_usage_ratio=settings.resume_min_page_usage_ratio,
        target_page_usage_ratio=settings.resume_target_page_usage_ratio,
        maximum_page_usage_ratio=settings.resume_max_page_usage_ratio,
    )


def _layout_budget_instruction(constraint: LayoutConstraint) -> str:
    target = f"{constraint.minimum_page_usage_ratio:.0%}"
    if constraint.is_single_page:
        return (
            "Layout objective (explicit hard one-page request): fill at least "
            f"{target} of the printable A4 height without exceeding one page. Start from a "
            "comprehensive grounded draft; remove only the lowest-value duplicate material if "
            "measurement later proves it overflows."
        )
    if constraint.targets_one_page:
        return (
            "Layout objective (default comprehensive mode): use at least "
            f"{target} of the first A4 page's printable height. One full page is the density "
            "target, not a content ceiling: crossing onto a second page is acceptable when the "
            "source contains additional distinct, useful facts. Do not shorten or omit grounded "
            "material merely to force a one-page result."
        )
    requested = (
        f" Aim for approximately {constraint.requested_pages} pages."
        if constraint.requested_pages
        else ""
    )
    return (
        "Layout objective: multiple A4 pages are allowed; keep page breaks natural and make "
        f"the content comprehensive and information-dense.{requested}"
    )


def _normalize_resume_language(value: object) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized.startswith("en") or normalized in {"english", "英文", "英语"}:
        return "en-US"
    if normalized.startswith("zh") or normalized in {"chinese", "中文", "汉语", "普通话"}:
        return "zh-CN"
    return None


def _requested_resume_language(
    state: ResumeGenerationState,
    profile: dict[str, object],
) -> str:
    """Resolve output language without letting a profile default override this turn."""
    extracted = state.get("extracted_params") or {}
    for key in ("output_language", "language", "locale"):
        explicit = _normalize_resume_language(extracted.get(key))
        if explicit:
            return explicit

    request_parts = [str(state.get("intent_description") or "")]
    messages = state.get("messages") or []
    if messages and isinstance(messages[-1], dict) and messages[-1].get("role") == "user":
        request_parts.append(str(messages[-1].get("content") or ""))
    request_text = "\n".join(request_parts)
    english_request = re.search(
        r"(?:英文|英语)(?:版简历|简历|版)|(?:用|使用)(?:英文|英语)|"
        r"\benglish\s+(?:resume|cv)\b|\b(?:resume|cv)\s+(?:in\s+)?english\b|"
        r"\b(?:write|make|translate)[^\n]{0,24}\benglish\b",
        request_text,
        re.IGNORECASE,
    )
    if english_request:
        return "en-US"
    chinese_request = re.search(
        r"(?:中文|汉语)(?:版简历|简历|版)|(?:用|使用)(?:中文|汉语)|"
        r"\bchinese\s+(?:resume|cv)\b|\b(?:resume|cv)\s+(?:in\s+)?chinese\b|"
        r"\b(?:write|make|translate)[^\n]{0,24}\bchinese\b",
        request_text,
        re.IGNORECASE,
    )
    if chinese_request:
        return "zh-CN"

    for key in ("previous_structured", "resume_structure"):
        structured = state.get(key)
        if isinstance(structured, dict):
            existing = _normalize_resume_language(structured.get("language"))
            if existing:
                return existing

    return _normalize_resume_language(profile.get("preferred_language")) or "zh-CN"


def _grounded_coverage_ids(
    structured: dict[str, object],
    matching_plan: dict[str, object],
    evidence_pack: dict[str, object],
) -> list[str]:
    raw_matches = evidence_pack.get("matches")
    matches = raw_matches if isinstance(raw_matches, list) else []
    evidence_ids = {
        str(match.get("requirement_id"))
        for match in matches
        if isinstance(match, dict)
        and match.get("requirement_id")
        and isinstance(match.get("matched_claims"), list)
        and match.get("matched_claims")
    }
    raw_coverage_plan = matching_plan.get("coverage_plan")
    coverage_plan = raw_coverage_plan if isinstance(raw_coverage_plan, list) else []
    planned_ids = {
        str(item.get("requirement_id"))
        for item in coverage_plan
        if isinstance(item, dict)
        and item.get("requirement_id")
        and item.get("planned_source_experience_ids")
    }
    supported = evidence_ids | planned_ids
    covered: set[str] = set()
    raw_sections = structured.get("sections")
    sections = raw_sections if isinstance(raw_sections, list) else []
    for section in sections:
        if not isinstance(section, dict):
            continue
        for item in section.get("items", []):
            if not isinstance(item, dict) or not item.get("source_experience_id"):
                continue
            for bullet in item.get("bullets", []):
                if not isinstance(bullet, dict):
                    continue
                covered.update(
                    str(requirement_id)
                    for requirement_id in bullet.get("matched_jd_requirement_ids", [])
                    if str(requirement_id) in supported
                )
    return sorted(covered)


async def draft_generation_node(state: ResumeGenerationState) -> dict[str, object]:
    """Generate an internal structured candidate without exposing an intermediate draft."""
    provider = get_provider()

    intent = state.get("intent_description", "Generate a tailored resume")
    jd_text = state.get("jd_text") or ""
    jd_requirements = state.get("jd_requirements") or []
    experiences = (
        state.get("selected_experiences")
        or state.get("relevant_experiences")
        or state.get("assembled_experiences")
        or []
    )
    guidelines = state.get("guideline_instructions") or []
    prefs = state.get("user_preferences") or []
    plan = state.get("matching_plan") or {}
    content_budget = state.get("content_budget") or {}
    profile = state.get("user_profile") or {}
    evidence_pack = state.get("evidence_pack") or {}
    revision_instruction = state.get("revision_instruction")
    fact_mismatches = state.get("fact_mismatches") or []
    constraint = LayoutConstraint.model_validate(
        state.get("layout_constraint") or _layout_constraint_from_state(state).model_dump()
    )

    # Build generation prompt
    prompt_parts = [f"Task: {intent}"]
    if jd_text:
        prompt_parts.append(f"Job Description:\n{jd_text}")
    if jd_requirements:
        req_lines = [
            f"- id={r.get('id') or f'req-{i + 1}'}: {r.get('text', '')}"
            for i, r in enumerate(jd_requirements)
            if isinstance(r, dict)
        ]
        prompt_parts.append(
            "JD requirements — every bullet's `matched_jd_requirement_ids` MUST reference these ids verbatim (or be empty for bullets that don't map to any requirement):\n"
            + "\n".join(req_lines)
        )
    if plan:
        plan_lines = [
            f"Strategy: {plan.get('strategy', '')}",
            f"Key experiences to highlight: {', '.join(plan.get('key_experiences_to_highlight', []))}",
            f"Skills to emphasize: {', '.join(plan.get('skills_to_emphasize', []))}",
        ]
        coverage_plan = plan.get("coverage_plan") or []
        if coverage_plan:
            coverage_lines = [
                f"  - {c.get('requirement_id')}: use experience ids {c.get('planned_source_experience_ids') or 'NONE'}"
                for c in coverage_plan
                if isinstance(c, dict)
            ]
            plan_lines.append(
                "Coverage plan (guideline; final bullet mapping is yours to decide):\n"
                + "\n".join(coverage_lines)
            )
        prompt_parts.append("\n".join(plan_lines))
    if content_budget:
        budget_lines: list[str] = []
        for value in content_budget.get("experiences") or []:
            if not isinstance(value, dict) or value.get("category") == "education":
                continue
            budget_lines.append(
                "- {experience_id}: jd_match={score:.0%}, candidate_bullets={target}".format(
                    experience_id=value.get("experience_id"),
                    score=float(value.get("jd_match_score") or 0.0),
                    target=int(value.get("target_candidate_bullets") or 0),
                )
            )
        if budget_lines:
            prompt_parts.append(
                "Candidate pool budget (HARD): produce at least the requested number of "
                "distinct grounded bullet candidates for every listed experience. The pool is "
                f"intentionally sized for about {settings.resume_candidate_pool_target_ratio:.0%} "
                "of a page; the backend will select the final 80%-95% combination.\n"
                + "\n".join(budget_lines)
            )
    if experiences:
        sorted_experiences = _sort_experiences_by_recency(experiences)
        prompt_parts.append(
            "Source experiences — sorted by recency (most recent first). "
            "THE ONLY GROUND TRUTH: every date, organization, role, metric, and technology in "
            "your output must come from this block; do not invent or substitute:\n"
            + _format_experiences_for_prompt(sorted_experiences)
        )
        match_tiers = _rank_experiences_by_jd_match(sorted_experiences, plan)
        if match_tiers:
            prompt_parts.append(
                "Content-depth plan (higher tier = stronger JD match; target_bullets is an "
                "exploration goal when the source supports distinct facts, not a maximum):\n"
                + "\n".join(
                    f"- {exp_id}: tier={tier} (target_bullets={target})"
                    for exp_id, tier, target in match_tiers
                )
            )
    if guidelines:
        prompt_parts.append(
            "Retrieved resume-writing guidelines:\n"
            + "\n".join(f"- {instruction}" for instruction in guidelines[:10])
        )
    if prefs:
        pref_rules = "\n".join(f"- {p.get('rule')}" for p in prefs[:8])
        prompt_parts.append(f"Writing preferences:\n{pref_rules}")
    evidence_matches = evidence_pack.get("matches", [])
    if isinstance(evidence_matches, list) and evidence_matches:
        evidence_lines: list[str] = []
        for match in evidence_matches[:12]:
            if not isinstance(match, dict):
                continue
            claims = match.get("matched_claims", [])
            claim_texts = (
                [
                    str(claim.get("text"))
                    for claim in claims
                    if isinstance(claim, dict) and claim.get("text")
                ]
                if isinstance(claims, list)
                else []
            )
            evidence_lines.append(
                f"- {match.get('requirement_text', '')}: {'; '.join(claim_texts)}"
            )
        if evidence_lines:
            prompt_parts.append(
                "Verified evidence mapping (use only these claims for matching assertions):\n"
                + "\n".join(evidence_lines)
            )
    if fact_mismatches:
        prompt_parts.append(
            "Previous draft had the following factual errors — you MUST correct every one of them in this revision:\n"
            + "\n".join(
                "- " + _format_mismatch_issue(m) for m in fact_mismatches if isinstance(m, dict)
            )
        )
    if revision_instruction:
        prompt_parts.append(f"Additional revision instruction: {revision_instruction}")
    prompt_parts.append(
        "Content expansion policy (HARD): write a comprehensive first draft, not a minimalist "
        "summary. Inspect every source experience for distinct responsibilities, deliverables, "
        "workflow stages, decisions, collaboration, tools, domain context, scale, constraints, "
        "and results. Preserve all useful source-supported details, including facts that do not "
        "map directly to the JD. A broad source statement may become multiple bullets only when "
        "each bullet expresses a different grounded angle. If the source cannot support more "
        "distinct bullets, write fewer but fuller bullets that combine grounded context, action, "
        "method, and result; never invent or repeat facts as padding."
    )
    prompt_parts.append(_layout_budget_instruction(constraint))

    preferred_lang = _requested_resume_language(state, profile)
    lang_instruction = (
        "Respond in Chinese (Simplified)."
        if preferred_lang.startswith("zh")
        else "Respond in English."
    )
    profile_contact = _extract_contact_from_profile(profile)

    existing_events = list(state.get("pending_sse_events", []))
    buffered_events: list[dict[str, object]] = []
    writer = get_optional_stream_writer() or buffered_events.append
    emit_thinking(writer, "正在生成并组织简历内容…")

    _draft_start = time.time()
    llm_structure: _LlmResumeStructure | None = None
    draft_strategy = "whole_resume"
    if settings.resume_parallel_generation_enabled:
        try:
            llm_structure = await _generate_resume_by_experience(
                provider,
                experiences=experiences,
                content_budget=content_budget,
                jd_requirements=jd_requirements,
                evidence_pack=evidence_pack,
                language=preferred_lang,
                fallback_contact=profile_contact,
                revision_instruction=(str(revision_instruction) if revision_instruction else None),
            )
        except Exception:
            logger.exception("Parallel experience generation failed; falling back to whole resume")
        if llm_structure is not None:
            draft_strategy = "parallel_experience_drafts"
    if llm_structure is None:
        llm_structure = await provider.chat_structured(
            [
                {"role": "system", "content": _DRAFT_SYSTEM_PROMPT.format(lang=lang_instruction)},
                {"role": "user", "content": "\n\n".join(prompt_parts)},
            ],
            _LlmResumeStructure,
            temperature=0.2,
        )
    logger.info(
        "draft_generation_node LLM phase: %.1fs (strategy=%s)",
        time.time() - _draft_start,
        draft_strategy,
    )
    llm_structure = llm_structure.model_copy(update={"language": preferred_lang})
    previous_structured = state.get("previous_structured")
    structured = _assign_structure_ids(
        llm_structure,
        fallback_contact=profile_contact,
        previous_structured=previous_structured or state.get("resume_structure"),
    )
    _copy_source_metadata(structured, experiences)
    _remove_unsourced_numeric_bullets(structured, experiences)
    content_str = _render_structured_to_markdown(structured)

    variant_id = f"resume-draft-{uuid.uuid4()}"
    emit_thinking(writer, "简历结构已完成，正在检查 A4 版面…")
    evidence_summary = _evidence_summary(evidence_pack)
    coverage = evidence_pack.get("coverage_ratio")
    coverage_score = float(coverage) if isinstance(coverage, (int, float)) else 0.0
    risk_summary = (
        [
            {
                "type": "missing_evidence",
                "text": "Some JD requirements do not have supporting experience evidence.",
                "severity": "medium",
            }
        ]
        if evidence_pack and coverage_score < 0.5
        else []
    )
    variant = {
        "id": variant_id,
        "title": _derive_resume_title(state, structured),
        "content": content_str,
        "structured": structured,
        "score": {
            "overall": 0.0,
            "relevance": 0.0,
            "clarity": 0.0,
            "evidence_strength": coverage_score,
            "quantified_impact": 0.0,
        },
        "evidence_summary": evidence_summary,
        "risk_summary": risk_summary,
        "missing_info": [],
    }
    coverage_before = state.get("coverage_before_layout") or _grounded_coverage_ids(
        structured,
        plan,
        evidence_pack,
    )
    return {
        "variants": [variant],
        "resume_structure": structured,
        "resume_candidate_pool": structured,
        "pending_sse_events": [*existing_events, *buffered_events],
        "coverage_before_layout": coverage_before,
        "generation_call_count": state.get("generation_call_count", 0) + 1,
        "layout_profile_version": DEFAULT_RESUME_LAYOUT_PROFILE.version,
        "layout_profile_hash": DEFAULT_RESUME_LAYOUT_PROFILE.profile_hash,
        "layout_template_id": STANDARD_RESUME_TEMPLATE.template_id,
        "quality_status": None,
        "quality_issues": [],
        "generation_strategy": draft_strategy,
    }


_DRAFT_SYSTEM_PROMPT = """You are an expert resume writer. {lang}

You MUST return a single JSON object matching the response schema — no prose outside the JSON. The JSON has the shape:

{{
  "language": "zh-CN" | "en-US" | ...,
  "contact": {{"name": ..., "email": ..., "phone": ..., "location": ...}} | null,
  "sections": [
    {{
      "type": "education" | "experience" | "project" | "skills" | "other",
      "heading": "...",           // display heading in the output language
      "items": [
        {{
          "title": "...",                 // job title / project name / degree — null for skills
          "organization": "..." | null,
          "role": "..." | null,
          "start_date": "YYYY-MM" | null,
          "end_date": "YYYY-MM" | "present" | null,
          "source_experience_id": "..." | null,   // MUST match the source_experience_id label from Source experiences
          "bullets": [
            {{
              "text": "...",
              "matched_jd_requirement_ids": ["req-1", ...],  // ids from the JD requirements block; [] if the bullet doesn't directly support a listed requirement
              "source_fact_ids": ["exp-id-fact-1", ...]      // facts from the same source experience used by this bullet
            }}
          ],
          "raw_text": "..." | null        // use for skills/education lines; null when bullets are used
        }}
      ]
    }}
  ]
}}

## Absolute rules (grounding)

1. Every DATE you write MUST appear verbatim in the Source experiences block. Do NOT re-format historic dates. Do NOT convert "2026-04" to "2023-04" or extend an end_date. If a source date is missing, use null — do NOT guess.
2. Every ORGANIZATION name, ROLE, TECHNOLOGY name, and QUANTITATIVE claim (numbers, percentages, counts) MUST come verbatim from the source. Preserve original casing/punctuation for names (e.g. "WEEX国际交易所有限公司", "Apache Spark").
3. If a source experience has organization=null, do NOT invent one — set the JSON field to null.
4. Do not upgrade descriptions ("熟悉" → "精通", "参与" → "主导") beyond what the source states.
5. Do not merge or split source experiences: one item per source experience within its section.
6. For each experience/project item, set `source_experience_id` to the exact id shown in the Source experiences block. Never invent an id.
7. For each bullet, set `matched_jd_requirement_ids` to the list of JD requirement ids that bullet directly supports. Only use ids shown in the JD requirements block. Empty array is allowed and expected for bullets that describe context, ownership, or achievements not tied to any listed requirement. Do NOT tag every bullet with every requirement — be specific.
8. For each bullet, set `source_fact_ids` to the distinct labeled source facts used to write it. Every id must belong to the same `source_experience_id`. Do not reuse the exact same fact combination merely to pad the page.
9. Order bullet candidates within each item from highest to lowest value: direct JD evidence first, then quantified results, ownership/action/method, and finally supporting context. The backend may trim candidates from the tail.
10. Narrative prose MUST NOT end with a Chinese or English full stop (`。`, `．`, `.`). Internal dots in decimals, versions, URLs, and email addresses are allowed.
11. Draft every bullet for the fixed A4 text width: a single-line bullet must occupy at least 69.67% of its line; if a bullet wraps, its FINAL line must also occupy at least 69.67%. Prefer one information-dense line. As a rough drafting heuristic, Chinese bullets are usually about 36–52 full-width character equivalents and English bullets about 80–115 characters. If a grounded fact is shorter, combine it with a related fact from the same source item instead of emitting a fragment. If a bullet would leave a short second line, either shorten it back to one line or add source-supported detail so the second line reaches two thirds. These ranges are heuristics, never permission to invent facts or add filler. Do not emit `layout_exception` in the initial draft.

## Section order and content

Emit sections in this order, skipping any with zero relevant data:

1. `education` — one item per source `category="education"`. Include the degree in `title`, school in `organization`, dates, and put courses / GPA / honours in `raw_text` (a compact block); leave `bullets` empty.
2. `experience` — one item per source `category="work"`. Populate `title`/`organization`/`role`/dates from source. Leave `raw_text` null.
3. `project` — one item per source `category="project"`. Same bullet rules as experience.
4. `skills` — one item with `raw_text` grouping skills by area (e.g. "编程语言：..."). Only include technologies actually appearing in the source experiences. A JD requirement alone is never evidence that the candidate has that skill. Leave `bullets` empty.

Never emit a summary/profile/about section.

## Experience & project selection rules (HARD)

R1. **Education is exhaustive**: the `education` section MUST contain ONE item for EVERY source experience with `category=education`. Never omit an education entry — even if it looks less relevant to the JD. This is non-negotiable.
R2. **Comprehensive inclusion for work / project**: include every source work/project item that contains substantive, distinct grounded material. Prioritize the strongest JD-matched items, but do not omit useful sourced items merely to make the draft concise. If an explicit hard one-page request later measures as overflow, the layout revision step may remove only the lowest-value redundant material.
    - Coverage floor: if the source has ≥1 work experience, `experience` section MUST have ≥1 item. Same for project.
R3. **Recency-first, per section**: within EACH of the `experience` and `project` sections, order items strictly by end_date DESCENDING (most recent first). If end_date is missing use start_date. Never interleave categories; each item stays in its section. The `education` section follows the same rule.
R4. **Bullet depth by source portfolio**: follow each item's `target_bullets` from the content-depth plan. It is an exploration target, not a maximum and never permission to invent. When only one or two substantive work/project sources exist, go deeper: normally aim for 6–8 distinct bullets on the strongest item and 4–6 on the supporting item when the source supports them. Without a content-depth plan, aim for 4–6 bullets per substantive item. Emit fewer only when the source genuinely cannot support more distinct angles.
R5. **Depth instead of filler**: limited experience means deeper use of the available evidence, not a shorter resume. Mine separate grounded angles such as context/scope, ownership, action, method or workflow, collaboration, tools, constraints, deliverable, and result. Preserve useful qualifiers from the source. Never repeat the same fact with synonyms, infer a candidate skill from the JD, or add generic responsibilities.

## Language

Match the source language for names and quantities; write connectives in the requested output language.
"""


# ── 3.25. Deterministic layout loop ──────────────────────────────────────────


async def layout_measure_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    variants = state.get("variants") or []
    structured = state.get("resume_candidate_pool")
    if not isinstance(structured, dict):
        structured = variants[0].get("structured") if variants else state.get("resume_structure")
    if not isinstance(structured, dict):
        return {
            "layout_status": "profile_mismatch",
            "quality_status": "failed",
            "quality_issues": [
                {"code": "missing_structure", "message": "No structured resume to measure."}
            ],
        }
    services = services_from_config(config)
    layout_service = services.resume_layout if services is not None else None
    if layout_service is None:
        return {
            "layout_status": "profile_mismatch",
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "layout_service_unavailable",
                    "message": "Resume layout measurement service is unavailable.",
                }
            ],
        }
    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在检查 A4 版面与每条要点的换行…")
    base_constraint = LayoutConstraint.model_validate(
        state.get("layout_constraint") or LayoutConstraint().model_dump()
    )
    experience_scores = {
        str(value.get("experience_id")): float(value.get("jd_match_score") or 0.0)
        for value in (state.get("content_budget") or {}).get("experiences", [])
        if isinstance(value, dict) and value.get("experience_id")
    }
    normalized_structure = normalize_resume_narrative_punctuation(structured)
    template = get_resume_template(normalized_structure.get("layout_template_id"))
    active_constraint = _constraint_for_template(base_constraint, template)
    normalized_structure["layout_template_id"] = template.template_id
    normalized_structure["layout_profile_version"] = template.profile.version
    normalized_structure["layout_profile_hash"] = template.profile.profile_hash
    active_layout = layout_service.with_profile(template.profile)
    optimized = ResumeLayoutOptimizer(active_layout).optimize(
        normalized_structure,
        active_constraint,
        experience_scores,
    )
    if (
        settings.resume_sparse_template_enabled
        and template.template_id == STANDARD_RESUME_TEMPLATE.template_id
    ):
        selected = select_resume_template(optimized.maximum_usage_ratio)
        if selected.template_id != template.template_id:
            template = selected
            active_constraint = _constraint_for_template(base_constraint, template)
            sparse_structure = dict(normalized_structure)
            sparse_structure["layout_template_id"] = template.template_id
            sparse_structure["layout_profile_version"] = template.profile.version
            sparse_structure["layout_profile_hash"] = template.profile.profile_hash
            active_layout = layout_service.with_profile(template.profile)
            optimized = ResumeLayoutOptimizer(active_layout).optimize(
                sparse_structure,
                active_constraint,
                experience_scores,
            )
    fitted_structure = optimized.structure
    report = optimized.report
    usage = report.pages[0].usage_ratio if report.pages else 0.0
    fitted_structure["layout_usage_ratio"] = usage
    fitted_structure["layout_target_band"] = {
        "minimum": active_constraint.minimum_page_usage_ratio,
        "target": active_constraint.target_page_usage_ratio,
        "maximum": active_constraint.maximum_page_usage_ratio,
    }
    content = _render_structured_to_markdown(fitted_structure)
    recorder = current_recorder()
    if recorder is not None:
        recorder.bind_result(
            structured=fitted_structure,
            payload_snapshot=(
                fitted_structure if settings.resume_observability_capture_payloads else None
            ),
            layout_report=report.model_dump(mode="json"),
        )
    updated_variants: list[dict[str, object]] = []
    for index, value in enumerate(variants):
        variant = dict(value)
        if index == 0:
            variant["structured"] = fitted_structure
            variant["content"] = content
        updated_variants.append(variant)
    fit_status = "fit"
    if not optimized.fits_target_band:
        fit_status = (
            "underfilled" if usage < active_constraint.minimum_page_usage_ratio else "overfilled"
        )
    return {
        "variants": updated_variants,
        "resume_structure": fitted_structure,
        "layout_report": report.model_dump(),
        "layout_status": report.status,
        "layout_fit_status": fit_status,
        "maximum_candidate_usage_ratio": optimized.maximum_usage_ratio,
        "layout_profile_version": report.profile_version,
        "layout_profile_hash": report.profile_hash,
        "layout_template_id": template.template_id,
        "layout_constraint": active_constraint.model_dump(),
    }


def _constraint_for_template(
    base: LayoutConstraint,
    template: ResumeTemplateDefinition,
) -> LayoutConstraint:
    if template.template_id == STANDARD_RESUME_TEMPLATE.template_id:
        return base
    return base.model_copy(
        update={
            "minimum_page_usage_ratio": template.minimum_page_usage_ratio,
            "target_page_usage_ratio": template.target_page_usage_ratio,
            "maximum_page_usage_ratio": template.maximum_page_usage_ratio,
        }
    )


def layout_route(state: ResumeGenerationState) -> str:
    report = state.get("layout_report") or {}
    status = report.get("status") or state.get("layout_status")
    violations = report.get("violations") or []
    hard_codes = {
        str(violation.get("code"))
        for violation in violations
        if isinstance(violation, dict) and violation.get("severity", "hard") == "hard"
    }
    if status == "pass" and not hard_codes:
        return "fact_check"
    if status == "profile_mismatch":
        return "failed"
    if status == "needs_revision" and "page_underfilled" in hard_codes:
        return "content_gap"
    repairable_codes = {"bullet_too_short", "bullet_awkward_wrap"}
    can_revise = (
        bool(hard_codes & repairable_codes)
        and hard_codes.issubset(repairable_codes)
        and state.get("layout_revision_iteration", 0) < settings.max_layout_revision_iterations
        and state.get("generation_call_count", 0) < settings.max_resume_generation_calls
        and state.get("local_repair_call_count", 0) < settings.max_resume_local_repair_calls
    )
    if status == "needs_revision" and can_revise:
        return "revision"
    if hard_codes and hard_codes.issubset(repairable_codes):
        return "fact_check"
    return "failed"


async def layout_revision_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    variants = state.get("variants") or []
    current = variants[0].get("structured") if variants else state.get("resume_structure")
    if not isinstance(current, dict):
        return {}
    report = LayoutReport.model_validate(state.get("layout_report") or {})
    experiences = state.get("relevant_experiences") or []
    targets = _local_repair_targets(
        current,
        report,
        experiences,
        state.get("content_budget") or {},
    )
    services = services_from_config(config)
    layout_service = services.resume_layout if services is not None else None
    if not targets or layout_service is None:
        return {
            "layout_revision_iteration": state.get("layout_revision_iteration", 0) + 1,
            "local_repair_status": "unavailable",
        }
    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在批量修复未通过尾行门槛的要点…")
    provider = get_provider()
    repaired = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "Repair only the supplied failing resume bullets in one batch. Return one "
                    "repair entry for every bullet_id and no other IDs. Provide at most three "
                    "grounded alternatives per bullet. Use only its source experience and "
                    "allowed fact IDs. Preserve matched JD requirement IDs exactly. Never add "
                    "numbers, facts, employers, dates, technologies, or claims absent from the "
                    "target. Do not return a resume, section, item, or any passing bullet. Do not "
                    "end narrative text with an English or Chinese full stop."
                ),
            },
            {
                "role": "user",
                "content": "LOCAL BULLET REPAIR TARGETS:\n"
                + json.dumps(targets, ensure_ascii=False, indent=2),
            },
        ],
        BulletRepairBatch,
        temperature=0.1,
    )
    evaluation = ResumeBulletRepairService(layout_service).evaluate_batch(
        current,
        report,
        repaired,
        experiences=experiences,
        content_budget=state.get("content_budget") or {},
    )
    structured = evaluation.structure
    diagnostics = [value.model_dump(mode="json") for value in evaluation.candidates]
    rejection_codes = evaluation.rejection_codes
    with observation_span(
        "layout_calls",
        "layout.repair_validation",
        attributes={
            "candidate_count": len(evaluation.candidates),
            "accepted_candidate_count": sum(
                not value.rejection_codes for value in evaluation.candidates
            ),
            "rejected_candidate_count": sum(
                bool(value.rejection_codes) for value in evaluation.candidates
            ),
            "repair_rejection_codes": rejection_codes,
        },
    ):
        pass
    common = {
        "layout_revision_iteration": state.get("layout_revision_iteration", 0) + 1,
        "local_repair_call_count": state.get("local_repair_call_count", 0) + 1,
        "generation_call_count": state.get("generation_call_count", 0) + 1,
        "layout_report": None,
        "layout_status": None,
        "local_repair_diagnostics": diagnostics,
        "local_repair_rejection_codes": rejection_codes,
    }
    if structured is None:
        return {**common, "local_repair_status": "rejected"}
    content = _render_structured_to_markdown(structured)
    updated_variants: list[dict[str, object]] = []
    for index, value in enumerate(variants):
        variant = dict(value)
        if index == 0:
            variant["structured"] = structured
            variant["content"] = content
        updated_variants.append(variant)
    return {
        "variants": updated_variants,
        "resume_structure": structured,
        "resume_candidate_pool": structured,
        **common,
        "local_repair_status": "applied",
    }


def _local_repair_targets(
    structured: dict[str, object],
    report: LayoutReport,
    experiences: list[dict[str, object]],
    content_budget: dict[str, object],
) -> list[dict[str, object]]:
    failing = {
        fit.bullet_id: fit
        for fit in report.bullet_fits
        if fit.status in {"too_short", "awkward_wrap"}
    }
    sources = {
        str(experience.get("id")): experience for experience in experiences if experience.get("id")
    }
    raw_budget_experiences = content_budget.get("experiences")
    budget_experiences = raw_budget_experiences if isinstance(raw_budget_experiences, list) else []
    budget_facts = {
        str(experience.get("experience_id")): experience.get("facts") or []
        for experience in budget_experiences
        if isinstance(experience, dict) and experience.get("experience_id")
    }
    targets: list[dict[str, object]] = []
    raw_sections = structured.get("sections")
    sections = raw_sections if isinstance(raw_sections, list) else []
    for section in sections:
        if not isinstance(section, dict):
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            source_id = str(item.get("source_experience_id") or "")
            source = sources.get(source_id)
            if source is None:
                continue
            for bullet in item.get("bullets") or []:
                if not isinstance(bullet, dict):
                    continue
                bullet_id = str(bullet.get("id") or "")
                fit = failing.get(bullet_id)
                if fit is None:
                    continue
                targets.append(
                    {
                        "bullet_id": bullet_id,
                        "current_text": str(bullet.get("text") or ""),
                        "status": fit.status,
                        "line_count": fit.line_count,
                        "last_line_ratio": fit.last_line_ratio,
                        "required_ratio": fit.gate_ratio,
                        "language": str(structured.get("language") or "zh-CN"),
                        "source_fact_ids": bullet.get("source_fact_ids") or [],
                        "matched_jd_requirement_ids": (
                            bullet.get("matched_jd_requirement_ids") or []
                        ),
                        "source_experience": {
                            "id": source_id,
                            "content": source.get("content"),
                            "claims": source.get("claims") or [],
                            "tags": source.get("tags") or [],
                        },
                        "allowed_facts": budget_facts.get(source_id, []),
                    }
                )
    return targets


def _check_experience_composition(
    structured: object,
    experiences: list[dict[str, object]],
) -> str | None:
    """Deterministic gate for the produced resume's section composition:

    - Every source `category="education"` must appear as an item in the education section
      (exhaustive — no education entry may be dropped).
    - If source has ≥1 work experience, the `experience` section must have ≥1 item.
    - If source has ≥1 project experience, the `project` section must have ≥1 item.

    Returns a revision instruction string if any gap is found, otherwise None.
    """
    if not isinstance(structured, dict) or not experiences:
        return None

    edu_sources = [
        e for e in experiences if isinstance(e, dict) and e.get("category") == "education"
    ]
    has_work_source = any(isinstance(e, dict) and e.get("category") == "work" for e in experiences)
    has_project_source = any(
        isinstance(e, dict) and e.get("category") == "project" for e in experiences
    )
    if not (edu_sources or has_work_source or has_project_source):
        return None

    def _section_items(section_type: str) -> list[dict[str, object]]:
        out: list[dict[str, object]] = []
        for section in structured.get("sections") or []:
            if not isinstance(section, dict) or section.get("type") != section_type:
                continue
            for item in section.get("items") or []:
                if isinstance(item, dict) and (
                    item.get("title") or item.get("bullets") or item.get("raw_text")
                ):
                    out.append(item)
        return out

    gaps: list[str] = []

    edu_items = _section_items("education")
    if edu_sources and len(edu_items) < len(edu_sources):
        emitted_ids = {
            str(it.get("source_experience_id"))
            for it in edu_items
            if it.get("source_experience_id")
        }
        missing = [
            str(e.get("title") or e.get("id"))
            for e in edu_sources
            if str(e.get("id")) not in emitted_ids
        ]
        gaps.append(
            f"the source contains {len(edu_sources)} education entries but the draft "
            f"has only {len(edu_items)} in the education section — every education entry "
            f"MUST be included. Missing: {', '.join(missing[:5])}"
        )

    if has_work_source and not _section_items("experience"):
        gaps.append(
            "the source contains work/internship experience(s) but the draft has no "
            "`experience` section item — include at least the most recent one with 2+ bullets"
        )
    if has_project_source and not _section_items("project"):
        gaps.append(
            "the source contains project experience(s) but the draft has no `project` "
            "section item — include at least the most recent one with 2+ bullets"
        )
    if not gaps:
        return None
    return "Fix experience composition: " + "; ".join(gaps) + "."


def _item_recency_key(item: dict[str, object]) -> tuple[int, str]:
    """Sort key for resume section items: end_date DESC with start_date fallback.

    Returns (has_date_flag, date_str) so items without any date fall to the bottom
    when sorted `reverse=True` (0 sorts above 1 → we return 1 for known-dated so
    reverse=True bubbles them up; unknown → 0 sorts below).
    """
    end = item.get("end_date")
    if isinstance(end, str) and end.strip() and end.strip().lower() != "present":
        return (1, end.strip())
    if isinstance(end, str) and end.strip().lower() == "present":
        # "present" is the most recent possible — use a lexically-large sentinel
        return (1, "9999-12")
    start = item.get("start_date")
    if isinstance(start, str) and start.strip():
        return (1, start.strip())
    return (0, "")


def _sort_experiences_by_recency(
    experiences: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Sort experiences most-recent-first (by end_date, fallback start_date).

    "present" end dates rank as the most recent. Undated experiences fall to the bottom.
    Category is not used as a secondary key — the LLM groups by section itself.
    """
    return sorted(experiences, key=_item_recency_key, reverse=True)


def _rank_experiences_by_jd_match(
    experiences: list[dict[str, object]],
    plan: dict[str, object],
) -> list[tuple[str, int, str]]:
    """Assign narrative experiences a depth tier and content-rich bullet target.

    Uses `matching_plan.coverage_plan` — how many JD requirements planned to lean on the
    experience — as the proxy for match strength. Ties broken by recency (input order is
    already most-recent-first). Without a JD plan, recency supplies deterministic tiers so
    sparse portfolios do not fall through to the old 1–2 bullet default.

    Returns list of (source_experience_id, tier, target_bullets_hint).
    """
    narrative_experiences = [
        experience
        for experience in experiences
        if str(experience.get("category") or "other") != "education"
    ]
    if not narrative_experiences:
        return []

    coverage_plan = plan.get("coverage_plan") if isinstance(plan, dict) else None
    hit_counts: dict[str, int] = {}
    if isinstance(coverage_plan, list):
        for entry in coverage_plan:
            if not isinstance(entry, dict):
                continue
            ids = entry.get("planned_source_experience_ids") or []
            if not isinstance(ids, list):
                continue
            for raw_id in ids:
                key = str(raw_id)
                hit_counts[key] = hit_counts.get(key, 0) + 1

    portfolio_size = len(narrative_experiences)
    if portfolio_size <= 2:
        targets = {1: "6-8", 2: "4-6", 3: "3-5"}
    elif portfolio_size <= 4:
        targets = {1: "5-7", 2: "4-6", 3: "3-4"}
    else:
        targets = {1: "4-6", 2: "3-5", 3: "2-4"}

    max_hits = max(hit_counts.values()) if hit_counts else 0
    ranked: list[tuple[str, int, str]] = []
    for index, exp in enumerate(narrative_experiences):
        exp_id = exp.get("id")
        if not isinstance(exp_id, str):
            continue
        if not hit_counts:
            tier = 1 if index == 0 else 2 if index == 1 else 3
        else:
            hits = hit_counts.get(exp_id, 0)
            if hits == 0:
                tier = 3
            elif hits >= max_hits:
                tier = 1
            elif hits >= max(1, max_hits - 1):
                tier = 2
            else:
                tier = 3
        ranked.append((exp_id, tier, targets[tier]))
    return ranked


def _format_experiences_for_prompt(experiences: list[dict[str, object]]) -> str:
    """Emit each experience as a labeled block so the LLM cannot conflate fields."""
    blocks: list[str] = []
    for idx, exp in enumerate(experiences, start=1):
        exp_id = exp.get("id") or "(no id)"
        title = exp.get("title") or "(no title)"
        organization = exp.get("organization")
        role = exp.get("role")
        category = exp.get("category") or "other"
        start_date = exp.get("start_date")
        end_date = exp.get("end_date")
        content = exp.get("content") or ""
        tags = exp.get("tags") or []
        claims = exp.get("claims") or []

        header = f"[Experience #{idx} — category={category} — source_experience_id={exp_id}]"
        lines = [
            header,
            f"  title: {title}",
            f"  organization: {organization if organization else '(none — do NOT invent one)'}",
            f"  role: {role if role else '(none)'}",
            f"  start_date: {start_date if start_date else '(unknown — omit if writing a date range)'}",
            f"  end_date: {end_date if end_date else '(unknown — omit if writing a date range)'}",
        ]
        if isinstance(tags, list) and tags:
            lines.append(f"  tags: {', '.join(str(t) for t in tags)}")
        lines.append(f"  content:\n{_indent(str(content), 4)}")
        if isinstance(claims, list) and claims:
            claim_lines = [
                (
                    f"    - id={exp_id}-fact-{claim_index} "
                    f"[{claim.get('category', 'fact')}] {claim.get('text')}"
                    if isinstance(claim, dict)
                    else f"    - id={exp_id}-fact-{claim_index} {claim}"
                )
                for claim_index, claim in enumerate(claims, start=1)
                if (isinstance(claim, dict) and claim.get("text")) or isinstance(claim, str)
            ]
            if claim_lines:
                lines.append(
                    "  extracted_fact_inventory (navigation aid only; original content above "
                    "remains authoritative):\n" + "\n".join(claim_lines)
                )
        else:
            raw_fact_lines = [
                line.strip(" -•\t") for line in str(content).splitlines() if line.strip()
            ]
            if raw_fact_lines:
                lines.append(
                    "  source_fact_inventory:\n"
                    + "\n".join(
                        f"    - id={exp_id}-fact-{fact_index} {fact}"
                        for fact_index, fact in enumerate(raw_fact_lines, start=1)
                    )
                )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _copy_source_metadata(
    structured: dict[str, object], experiences: list[dict[str, object]]
) -> None:
    """Make source-owned identity/date fields deterministic instead of LLM-authored."""
    sources = {
        str(value.get("id")): value
        for value in experiences
        if isinstance(value, dict) and value.get("id")
    }
    raw_sections = structured.get("sections")
    sections = raw_sections if isinstance(raw_sections, list) else []
    for section in sections:
        if not isinstance(section, dict):
            continue
        raw_items = section.get("items")
        items = raw_items if isinstance(raw_items, list) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            source = sources.get(str(item.get("source_experience_id") or ""))
            if source is None:
                continue
            for field in ("title", "organization", "role", "start_date", "end_date"):
                item[field] = source.get(field)


def _remove_unsourced_numeric_bullets(
    structured: dict[str, object], experiences: list[dict[str, object]]
) -> None:
    sources = {
        str(value.get("id")): value
        for value in experiences
        if isinstance(value, dict) and value.get("id")
    }
    raw_sections = structured.get("sections")
    sections = raw_sections if isinstance(raw_sections, list) else []
    for section in sections:
        if not isinstance(section, dict):
            continue
        raw_items = section.get("items")
        items = raw_items if isinstance(raw_items, list) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            source = sources.get(str(item.get("source_experience_id") or ""))
            bullets = item.get("bullets")
            if source is None or not isinstance(bullets, list):
                continue
            raw_tags = source.get("tags")
            tags = raw_tags if isinstance(raw_tags, list) else []
            raw_claims = source.get("claims")
            claims = raw_claims if isinstance(raw_claims, list) else []
            source_blob = "\n".join(
                [
                    str(source.get("content") or ""),
                    str(source.get("title") or ""),
                    str(source.get("organization") or ""),
                    str(source.get("role") or ""),
                    " ".join(str(value) for value in tags),
                    " ".join(
                        str(value.get("text") or "") for value in claims if isinstance(value, dict)
                    ),
                ]
            )
            allowed = set(re.findall(r"(?<!\w)\d+(?:[.,]\d+)?%?", source_blob))
            item["bullets"] = [
                bullet
                for bullet in bullets
                if isinstance(bullet, dict)
                and set(
                    re.findall(r"(?<!\w)\d+(?:[.,]\d+)?%?", str(bullet.get("text") or ""))
                ).issubset(allowed)
            ]


def _indent(text: str, spaces: int) -> str:
    pad = " " * spaces
    return "\n".join(pad + line for line in text.splitlines())


def _format_mismatch_issue(m: dict[str, object]) -> str:
    src = m.get("source_value")
    src_part = "source has no such fact" if src is None else f'source says "{src}"'
    exp = m.get("experience_title") or ""
    return f'{m.get("field")}: drafted "{m.get("drafted_value")}" but {src_part} ({exp})'


def _evidence_summary(evidence_pack: dict[str, object]) -> list[dict[str, object]]:
    raw_matches = evidence_pack.get("matches", [])
    if not isinstance(raw_matches, list):
        return []
    summary: list[dict[str, object]] = []
    for raw_match in raw_matches:
        if not isinstance(raw_match, dict):
            continue
        raw_claims = raw_match.get("matched_claims", [])
        claims = (
            [
                str(claim.get("text"))
                for claim in raw_claims
                if isinstance(claim, dict) and claim.get("text")
            ]
            if isinstance(raw_claims, list)
            else []
        )
        summary.append(
            {
                "requirement_id": str(raw_match.get("requirement_id", "")),
                "requirement_text": str(raw_match.get("requirement_text", "")),
                "supporting_claims": claims,
                "match_score": float(raw_match.get("match_score", 0.0)),
            }
        )
    return summary


# ── 3.5. Fact Check ───────────────────────────────────────────────────────────


async def fact_check_node(state: ResumeGenerationState) -> dict[str, object]:
    """Verify every date / organization / role / metric / technology in the draft
    can be sourced verbatim from `relevant_experiences`. Uses the structured draft
    (if available) for precise per-field comparison, falling back to markdown."""
    variants = state.get("variants", [])
    if not variants:
        return {"fact_mismatches": []}

    structured = variants[0].get("structured") or state.get("resume_structure")
    experiences = state.get("relevant_experiences") or []
    if not experiences:
        return {"fact_mismatches": []}

    if not isinstance(structured, dict) or not structured.get("sections"):
        return {"fact_mismatches": []}
    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在核对简历中的事实与数据…")
    sources = {
        str(value.get("id")): value
        for value in experiences
        if isinstance(value, dict) and value.get("id")
    }
    mismatches: list[dict[str, object]] = []
    field_map = {
        "organization": "organization",
        "role": "role",
        "title": "title",
        "start_date": "date",
        "end_date": "date",
    }
    for section in structured.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            source_id = str(item.get("source_experience_id") or "")
            source = sources.get(source_id)
            if source is None:
                if source_id:
                    mismatches.append(
                        {
                            "field": "other",
                            "drafted_value": source_id,
                            "source_value": None,
                            "experience_title": str(item.get("title") or ""),
                            "detail": "Unknown source_experience_id",
                        }
                    )
                continue
            for field, mismatch_field in field_map.items():
                drafted = str(item.get(field) or "").strip()
                sourced = str(source.get(field) or "").strip()
                if drafted and drafted != sourced:
                    mismatches.append(
                        {
                            "field": mismatch_field,
                            "drafted_value": drafted,
                            "source_value": sourced or None,
                            "experience_title": str(source.get("title") or source_id),
                            "detail": f"{field} must be copied from the source experience",
                        }
                    )
            source_blob = "\n".join(
                [
                    str(source.get("content") or ""),
                    str(source.get("title") or ""),
                    str(source.get("organization") or ""),
                    str(source.get("role") or ""),
                    " ".join(str(value) for value in source.get("tags") or []),
                    " ".join(
                        str(value.get("text") or "")
                        for value in source.get("claims") or []
                        if isinstance(value, dict)
                    ),
                ]
            )
            source_numbers = set(re.findall(r"(?<!\w)\d+(?:[.,]\d+)?%?", source_blob))
            for bullet in item.get("bullets") or []:
                if not isinstance(bullet, dict):
                    continue
                text = str(bullet.get("text") or "")
                for number in re.findall(r"(?<!\w)\d+(?:[.,]\d+)?%?", text):
                    if number not in source_numbers:
                        mismatches.append(
                            {
                                "field": "metric",
                                "drafted_value": number,
                                "source_value": None,
                                "experience_title": str(source.get("title") or source_id),
                                "detail": "Numeric claim is absent from the source experience",
                            }
                        )
    return {"fact_mismatches": mismatches}


# ── 3.6. Coverage Check ───────────────────────────────────────────────────────


async def coverage_check_node(state: ResumeGenerationState) -> dict[str, object]:
    """Deterministically verify every JD requirement is cited by ≥1 bullet.

    Reads `matched_jd_requirement_ids` off each bullet in the structured draft,
    counts coverage per requirement, and:
      - populates `coverage_report` (per-requirement bullet count + supporting item titles)
      - lists `uncovered_jd_requirement_ids` for downstream review / FE surfacing
      - annotates the variant's `risk_summary` with a `coverage_gap` entry when
        one or more requirements has zero supporting bullets.
    """
    jd_requirements = state.get("jd_requirements") or []
    if not jd_requirements:
        return {"coverage_report": None, "uncovered_jd_requirement_ids": []}

    variants = state.get("variants") or []
    if not variants:
        return {"coverage_report": None, "uncovered_jd_requirement_ids": []}

    structured = variants[0].get("structured") or state.get("resume_structure")
    if not isinstance(structured, dict):
        return {"coverage_report": None, "uncovered_jd_requirement_ids": []}

    valid_req_ids: dict[str, str] = {}
    for idx, req in enumerate(jd_requirements):
        if not isinstance(req, dict):
            continue
        req_id = req.get("id") or f"req-{idx + 1}"
        valid_req_ids[str(req_id)] = str(req.get("text") or "")

    # Aggregate coverage from bullets
    per_req: dict[str, dict[str, object]] = {
        rid: {
            "requirement_id": rid,
            "requirement_text": text,
            "bullet_count": 0,
            "supporting_items": [],
        }
        for rid, text in valid_req_ids.items()
    }

    sections = structured.get("sections") or []
    for section in sections:
        if not isinstance(section, dict):
            continue
        for item in section.get("items") or []:
            if not isinstance(item, dict):
                continue
            item_title = item.get("title") or ""
            for bullet in item.get("bullets") or []:
                if not isinstance(bullet, dict):
                    continue
                matched = bullet.get("matched_jd_requirement_ids") or []
                if not isinstance(matched, list):
                    continue
                for raw_rid in matched:
                    rid = str(raw_rid)
                    entry = per_req.get(rid)
                    if entry is None:
                        continue
                    current_count = entry.get("bullet_count")
                    entry["bullet_count"] = (
                        current_count if isinstance(current_count, int) else 0
                    ) + 1
                    supporting = cast("list[str]", entry["supporting_items"])
                    if item_title and item_title not in supporting:
                        supporting.append(item_title)

    covered_count = 0
    for entry in per_req.values():
        count = entry.get("bullet_count")
        if isinstance(count, int) and count > 0:
            covered_count += 1
    coverage_report = {
        "requirements": list(per_req.values()),
        "covered_count": covered_count,
        "total_count": len(per_req),
    }
    uncovered_ids = [
        rid
        for rid, entry in per_req.items()
        if not isinstance(entry.get("bullet_count"), int) or entry.get("bullet_count") == 0
    ]

    updated_variants: list[dict[str, object]] = []
    for i, v in enumerate(variants):
        variant = dict(v)
        if i == 0:
            variant["coverage_report"] = coverage_report
            if uncovered_ids:
                existing_risks = list(variant.get("risk_summary") or [])
                existing_risks.append(
                    {
                        "type": "coverage_gap",
                        "text": (
                            f"{len(uncovered_ids)}/{len(per_req)} JD requirement(s) "
                            f"lack a supporting bullet: "
                            + ", ".join(
                                f"{rid} ({per_req[rid]['requirement_text']})"
                                for rid in uncovered_ids[:5]
                            )
                            + (" …" if len(uncovered_ids) > 5 else "")
                        ),
                        "severity": "medium",
                    }
                )
                variant["risk_summary"] = existing_risks
        updated_variants.append(variant)

    return {
        "coverage_report": coverage_report,
        "uncovered_jd_requirement_ids": uncovered_ids,
        "variants": updated_variants,
    }


# ── 4. Self Review ────────────────────────────────────────────────────────────


async def self_review_node(state: ResumeGenerationState) -> dict[str, object]:
    """Review generated variants for quality. Max 3 iterations.

    Fact mismatches from `fact_check_node` are always a hard-fail — they force a
    revision regardless of the qualitative review verdict.
    """
    iteration = state.get("review_iteration", 0)
    # `review_iteration` counts completed revisions. At the configured limit the
    # latest revised draft still deserves one final evaluation; only values beyond
    # the limit indicate an invalid loop state.
    if iteration > settings.max_self_review_iterations:
        return {
            "review_result": {
                "verdict": "needs_revision",
                "revision_instruction": state.get("revision_instruction"),
                "issues": ["Self-review revision limit reached before all issues were resolved."],
                "score_estimate": 0.4,
            }
        }

    variants = state.get("variants", [])
    if not variants:
        return {"review_result": {"verdict": "pass", "issues": []}}

    mismatches = state.get("fact_mismatches") or []
    if mismatches:
        issues = [_format_mismatch_issue(m) for m in mismatches if isinstance(m, dict)]
        instruction = (
            "Fix every factual mismatch listed. Use only facts (dates, organizations, "
            "roles, metrics, technologies) that appear verbatim in the source experiences. "
            "Do not invent alternatives."
        )
        return {
            "review_result": {
                "verdict": "needs_revision",
                "revision_instruction": instruction,
                "issues": issues,
                "score_estimate": 0.3,
            },
            "revision_instruction": instruction,
        }

    composition_gap = _check_experience_composition(
        variants[0].get("structured") or state.get("resume_structure"),
        state.get("selected_experiences") or state.get("relevant_experiences") or [],
    )
    if composition_gap:
        return {
            "review_result": {
                "verdict": "needs_revision",
                "revision_instruction": composition_gap,
                "issues": [composition_gap],
                "score_estimate": 0.3,
            },
            "revision_instruction": composition_gap,
        }

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在执行确定性内容完整性检查…")
    deterministic_issues: list[str] = []
    seen_bullets: set[str] = set()
    structured = variants[0].get("structured") or state.get("resume_structure")
    if isinstance(structured, dict):
        for section in structured.get("sections") or []:
            if not isinstance(section, dict):
                continue
            for item in section.get("items") or []:
                if not isinstance(item, dict):
                    continue
                for bullet in item.get("bullets") or []:
                    if not isinstance(bullet, dict):
                        continue
                    text = str(bullet.get("text") or "").strip()
                    normalized = "".join(text.lower().split())
                    if normalized in seen_bullets:
                        deterministic_issues.append(f"Duplicate bullet: {text[:80]}")
                    elif normalized:
                        seen_bullets.add(normalized)
                    if text and len(text) < 8:
                        deterministic_issues.append(f"Very short bullet: {text}")
    return {
        "review_result": {
            "verdict": "pass",
            "issues": deterministic_issues,
            "score_estimate": 0.8 if not deterministic_issues else 0.7,
        },
        "revision_instruction": None,
    }


# ── 4.5. Final quality gate ───────────────────────────────────────────────────


async def quality_gate_node(state: ResumeGenerationState) -> dict[str, object]:
    issues: list[dict[str, object]] = []
    fact_mismatches = state.get("fact_mismatches") or []
    if fact_mismatches:
        issues.extend(
            {"code": "fact_mismatch", "message": _format_mismatch_issue(value)}
            for value in fact_mismatches
            if isinstance(value, dict)
        )
        return {"quality_status": "failed", "quality_issues": issues}

    report_raw = state.get("layout_report")
    if not isinstance(report_raw, dict):
        return {
            "quality_status": "failed",
            "quality_issues": [
                {"code": "missing_layout_report", "message": "Final layout was not measured."}
            ],
        }
    try:
        report = LayoutReport.model_validate(report_raw)
    except ValidationError as exc:
        logger.exception("Invalid layout report at quality gate")
        return {
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "invalid_layout_report",
                    "message": "Final layout report is invalid and cannot be trusted.",
                    "detail": str(exc),
                }
            ],
        }
    constraint = LayoutConstraint.model_validate(
        state.get("layout_constraint") or LayoutConstraint().model_dump()
    )
    usage = report.pages[0].usage_ratio if report.pages else 0.0
    is_underfilled = constraint.targets_one_page and usage < constraint.minimum_page_usage_ratio
    page_count_invalid = report.page_count < 1 or (
        constraint.max_pages is not None and report.page_count > constraint.max_pages
    )
    has_overflow = report.overflow_mm > 0 or any(page.overflow_mm > 0 for page in report.pages)
    usage_over_max = constraint.targets_one_page and usage > constraint.maximum_page_usage_ratio
    if page_count_invalid or has_overflow or usage_over_max:
        return {
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "layout_usage_out_of_band",
                    "message": (
                        f"Resume uses {usage:.1%} of the first page; required band is "
                        f"{constraint.minimum_page_usage_ratio:.0%}-"
                        f"{constraint.maximum_page_usage_ratio:.0%}."
                    ),
                }
            ],
        }
    if is_underfilled:
        issues.append(
            {
                "code": "layout_usage_underfilled",
                "message": (
                    f"Resume uses {usage:.1%} of the first page; the preferred minimum is "
                    f"{constraint.minimum_page_usage_ratio:.0%}."
                ),
            }
        )
    hard_layout = [violation for violation in report.violations if violation.severity == "hard"]
    issues.extend(
        {"code": violation.code, "message": violation.message} for violation in hard_layout
    )

    coverage_regressions = sorted(
        set(state.get("coverage_before_layout") or [])
        & set(state.get("uncovered_jd_requirement_ids") or [])
    )
    if coverage_regressions:
        issues.append(
            {
                "code": "coverage_regression",
                "message": (
                    "Layout revision removed grounded JD coverage for: "
                    + ", ".join(coverage_regressions)
                ),
            }
        )

    review = state.get("review_result") or {}
    review_failed = review.get("verdict") == "needs_revision"
    if review_failed:
        for issue in review.get("issues") or ["Self-review still requires revision."]:
            issues.append({"code": "self_review_unresolved", "message": str(issue)})

    if (
        report.status == "profile_mismatch"
        or review_failed
        or is_underfilled
        or hard_layout
        or coverage_regressions
    ):
        quality_status = "failed"
    elif not settings.resume_layout_hard_gate_enabled:
        issues.append(
            {
                "code": "browser_verification_required",
                "message": (
                    "Browser layout verification is required before this candidate can be "
                    "persisted or reviewed."
                ),
            }
        )
        quality_status = "failed"
    else:
        quality_status = "passed"
    return {"quality_status": quality_status, "quality_issues": issues}


def quality_gate_route(state: ResumeGenerationState) -> str:
    status = state.get("quality_status")
    if status == "passed":
        return "passed"
    return "failed"


# ── 5. Revision ───────────────────────────────────────────────────────────────


async def revision_node(state: ResumeGenerationState) -> dict[str, object]:
    """Apply revision instruction to improve the draft."""
    review = state.get("review_result") or {}
    instruction = review.get("revision_instruction") or state.get("revision_instruction")

    if not instruction:
        return {}

    # Bump iteration count and re-run generation with revision instruction
    current_iter = state.get("review_iteration", 0)
    return {
        "review_iteration": current_iter + 1,
        "revision_instruction": instruction,
    }


# ── 6. Output / Interrupt ─────────────────────────────────────────────────────


async def persist_resume_draft_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Persist the resume and variants before entering the review interrupt."""
    from app.graphs.runtime import thread_repo_from_config

    services = services_from_config(config)
    if services is None:
        return {}
    if state.get("quality_status") != "passed":
        raise RuntimeError("Refusing to persist a resume that did not pass quality")

    workspace = dict(state.get("workspace", {}))
    resume_id_value = workspace.get("resume_id")
    resume_id = resume_id_value if isinstance(resume_id_value, str) else None
    jd_id_value = workspace.get("jd_id")
    jd_id = jd_id_value if isinstance(jd_id_value, str) else None

    # Promote raw_jd_text → jd_records when jd_id is missing so the JD survives future turns.
    if jd_id is None:
        extracted = state.get("extracted_params", {})
        raw_jd = extracted.get("raw_jd_text") or extracted.get("jd_text")
        if isinstance(raw_jd, str) and raw_jd.strip():
            try:
                thread_id_val = state.get("thread_id", "")
                with observation_span(
                    "persistence_calls",
                    "resume.jd_promote",
                    attributes={"read_write": "write"},
                ):
                    jd_record = await services.jd.create_or_update_from_raw_text(
                        state.get("user_id", ""),
                        raw_jd,
                        source_thread_id=(
                            thread_id_val if isinstance(thread_id_val, str) else None
                        ),
                    )
                jd_id = jd_record.id
                workspace["jd_id"] = jd_id
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to promote raw_jd_text to jd_records: %s", exc)

    if not resume_id:
        with observation_span(
            "persistence_calls",
            "resume.create",
            attributes={"read_write": "write"},
        ):
            resume = await services.resume.create_resume(
                state.get("user_id", ""),
                "AI Generated Resume",
                jd_id=jd_id,
            )
        resume_id = resume.id
        workspace["resume_id"] = resume.id
    else:
        # Workspace IDs originate at the client boundary. Re-check ownership at
        # the write boundary so no variant can be attached to another user.
        with observation_span(
            "persistence_calls",
            "resume.ownership_check",
            attributes={"read_write": "read"},
        ):
            await services.resume.get_resume(state.get("user_id", ""), resume_id)

    variants = state.get("variants") or []
    if len(variants) != 1:
        raise RuntimeError("Refusing to persist anything other than one resume variant")
    variant = variants[0]
    title = variant.get("title")
    content = variant.get("content")
    structured = variant.get("structured")
    staged_variant_id = state.get("browser_staged_variant_id")
    with observation_span(
        "persistence_calls",
        "resume.variant_insert",
        attributes={"read_write": "write"},
    ):
        if isinstance(staged_variant_id, str) and isinstance(structured, dict):
            saved = await services.resume.save_variant_structure(
                state.get("user_id", ""),
                staged_variant_id,
                structured,
                title=title if isinstance(title, str) else None,
            )
        else:
            browser_gate_pending = settings.resume_layout_hard_gate_enabled
            saved = await services.resume.save_variant(
                resume_id,
                ResumeVariantCreate.model_validate(
                    {
                        "jd_id": jd_id,
                        "title": (
                            title if isinstance(title, str) and title else "AI Generated Variant"
                        ),
                        "content": content if isinstance(content, str) else "",
                        "structured": structured if isinstance(structured, dict) else None,
                        "score": variant.get("score", {}),
                        "evidence_summary": variant.get("evidence_summary", []),
                        "risk_summary": variant.get("risk_summary", []),
                        "missing_info": variant.get("missing_info", []),
                        "gate_status": "unverified" if browser_gate_pending else "passed",
                        "quality_issues": (
                            [
                                {
                                    "code": "browser_verification_pending",
                                    "message": "Waiting for a matching browser DOM observation.",
                                }
                            ]
                            if browser_gate_pending
                            else state.get("quality_issues", [])
                        ),
                        "quality_gate_version": (
                            "browser-layout-gate-v1"
                            if browser_gate_pending
                            else "resume-quality-gate-v1"
                        ),
                    }
                ),
            )
    saved_variants = [saved.model_dump(mode="json")]

    # Persist workspace ids so future turns don't lose them even if client omits them.
    snapshot_delta: dict[str, object] = {}
    if resume_id:
        snapshot_delta["resume_id"] = resume_id
    if jd_id:
        snapshot_delta["jd_id"] = jd_id
    if snapshot_delta:
        from app.domain.thread.repository import ThreadRepository

        thread_repo = cast("ThreadRepository | None", thread_repo_from_config(config))
        thread_id_val = state.get("thread_id", "")
        if thread_repo is not None and isinstance(thread_id_val, str) and thread_id_val:
            try:
                with observation_span(
                    "persistence_calls",
                    "resume.workspace_snapshot_update",
                    attributes={"read_write": "write"},
                ):
                    await thread_repo.update_workspace_snapshot(thread_id_val, snapshot_delta)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to persist workspace snapshot: %s", exc)

    recorder = current_recorder()
    if recorder is not None:
        first_variant = saved_variants[0] if saved_variants else {}
        variant_id = first_variant.get("id")
        structured = first_variant.get("structured")
        recorder.bind_result(
            resume_id=resume_id,
            variant_id=variant_id if isinstance(variant_id, str) else None,
            structured=structured if isinstance(structured, dict) else None,
            payload_snapshot=(
                structured
                if settings.resume_observability_capture_payloads and isinstance(structured, dict)
                else None
            ),
            layout_report=state.get("layout_report"),
            quality_result={
                "quality_status": state.get("quality_status"),
                "fact_error_count": len(state.get("fact_mismatches") or []),
                "coverage_regression_count": len(
                    (state.get("coverage_report") or {}).get("regressions", [])
                ),
            },
        )
    return {
        "workspace": workspace,
        "variants": saved_variants,
        "browser_staged_variant_id": saved.id,
    }


async def browser_layout_gate_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Suspend for a real browser measurement before exposing review/accept."""
    if not settings.resume_layout_hard_gate_enabled:
        return {"browser_verification_status": "passed"}

    from langgraph.types import interrupt

    services = services_from_config(config)
    variants = state.get("variants") or []
    variant = variants[0] if len(variants) == 1 else None
    workspace = dict(state.get("workspace", {}))
    resume_id = workspace.get("resume_id")
    variant_id = variant.get("id") if isinstance(variant, dict) else None
    structured = variant.get("structured") if isinstance(variant, dict) else None
    if (
        services is None
        or services.resume_observability is None
        or not isinstance(resume_id, str)
        or not isinstance(variant_id, str)
        or not isinstance(structured, dict)
    ):
        return {
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "browser_verification_unavailable",
                    "message": "Browser layout verification could not be started.",
                }
            ],
            "browser_verification_status": "failed",
        }

    interrupt_id = str(uuid.uuid4())
    surface = (
        "application_package" if state.get("target_subgraph") == "application_package" else "review"
    )
    payload = {
        "interrupt_id": interrupt_id,
        "type": "resume_layout_verification",
        "message": "正在使用真实浏览器 DOM 校验页数、字体和 bullet 尾行。",
        "resume": variant,
        "variants": [],
        "workspace": workspace,
        "measurement_surface": surface,
        "verification_iteration": state.get("browser_verification_iteration", 0),
        "action_options": [
            {
                "id": "discard",
                "label": "取消",
                "description": "停止本次简历生成",
            }
        ],
    }
    resume_value = interrupt(payload)
    if not isinstance(resume_value, dict) or resume_value.get("action") != "verify_layout":
        issues = [
            {
                "code": "browser_verification_cancelled",
                "message": "Browser layout verification was cancelled.",
            }
        ]
        await services.resume.set_variant_quality(
            state.get("user_id", ""), variant_id, "failed", issues
        )
        return {
            "quality_status": "failed",
            "quality_issues": issues,
            "browser_verification_status": "failed",
        }

    raw_observation = resume_value.get("observation")
    try:
        observation = BrowserLayoutObservationInput.model_validate(raw_observation)
    except ValidationError as exc:
        issues = [
            {
                "code": "invalid_browser_observation",
                "message": str(exc),
            }
        ]
        await services.resume.set_variant_quality(
            state.get("user_id", ""), variant_id, "failed", issues
        )
        return {
            "quality_status": "failed",
            "quality_issues": issues,
            "browser_verification_status": "failed",
        }
    if observation.run_id is None and state.get("observability_run_id"):
        observation = observation.model_copy(update={"run_id": state.get("observability_run_id")})

    verification = await services.resume_observability.verify_layout_observation(
        user_id=state.get("user_id", ""),
        resume_id=resume_id,
        variant_id=variant_id,
        structured=structured,
        observation=observation,
    )
    issues = [violation.model_dump(mode="json") for violation in verification.violations]
    iteration = state.get("browser_verification_iteration", 0) + 1
    common: dict[str, object] = {
        "browser_verification_iteration": iteration,
        "browser_layout_observation": observation.model_dump(mode="json"),
        "browser_layout_violations": issues,
    }
    if verification.status == "passed":
        saved = await services.resume.set_variant_quality(
            state.get("user_id", ""), variant_id, "passed", []
        )
        return {
            **common,
            "variants": [saved.model_dump(mode="json")],
            "browser_verification_status": "passed",
            "quality_status": "passed",
            "quality_issues": [],
        }

    if verification.status == "needs_revision":
        repaired_report = _browser_repair_report(
            state.get("layout_report"),
            observation,
            set(verification.repairable_bullet_ids),
        )
        can_repair = (
            repaired_report is not None
            and state.get("layout_revision_iteration", 0) < settings.max_layout_revision_iterations
            and state.get("local_repair_call_count", 0) < settings.max_resume_local_repair_calls
        )
        if can_repair:
            await services.resume.set_variant_quality(
                state.get("user_id", ""), variant_id, "needs_revision", issues
            )
            return {
                **common,
                "layout_report": repaired_report,
                "browser_verification_status": "repair",
                "quality_status": "failed",
                "quality_issues": issues,
            }

    await services.resume.set_variant_quality(
        state.get("user_id", ""), variant_id, "failed", issues
    )
    return {
        **common,
        "browser_verification_status": "failed",
        "quality_status": "failed",
        "quality_issues": issues,
    }


def _browser_repair_report(
    raw_report: object,
    observation: BrowserLayoutObservationInput,
    failed_bullet_ids: set[str],
) -> dict[str, object] | None:
    try:
        report = LayoutReport.model_validate(raw_report)
    except ValidationError:
        return None
    observed = {bullet.bullet_id: bullet for bullet in observation.bullets}
    bullet_fits = []
    found: set[str] = set()
    for fit in report.bullet_fits:
        if fit.bullet_id not in failed_bullet_ids:
            bullet_fits.append(fit)
            continue
        metric = observed.get(fit.bullet_id)
        if metric is None:
            return None
        found.add(fit.bullet_id)
        bullet_fits.append(
            fit.model_copy(
                update={
                    "line_count": metric.line_count,
                    "last_line_ratio": (metric.last_line_width_px / metric.available_line_width_px),
                    "status": "too_short",
                    "recommendation": "rephrase",
                }
            )
        )
    if found != failed_bullet_ids:
        return None
    retained = [
        violation for violation in report.violations if violation.bullet_id not in failed_bullet_ids
    ]
    retained.extend(
        LayoutViolation(
            code="bullet_too_short",
            message="Browser DOM measured a bullet tail below the required ratio.",
            bullet_id=bullet_id,
        )
        for bullet_id in sorted(failed_bullet_ids)
    )
    return report.model_copy(
        update={
            "bullet_fits": bullet_fits,
            "violations": retained,
            "status": "needs_revision",
        }
    ).model_dump(mode="json")


def browser_layout_gate_route(state: ResumeGenerationState) -> str:
    status = state.get("browser_verification_status")
    if status == "passed":
        return "passed"
    if status == "repair":
        return "repair"
    return "failed"


async def output_failure_node(state: ResumeGenerationState) -> dict[str, object]:
    issues = state.get("quality_issues") or []
    details = "; ".join(
        str(issue.get("message") or issue.get("code"))
        for issue in issues
        if isinstance(issue, dict)
    )
    return {
        "quality_status": state.get("quality_status") or "failed",
        "assistant_message": (
            "简历生成未通过事实与质量检查，未保存为可接受候选。"
            + (f" 未解决问题：{details}" if details else "")
        ),
        "resume_user_action": "complete",
        "interrupt_payload": None,
    }


async def content_gap_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Ask once for grounded detail only after the complete FactBank is proven insufficient."""
    from langgraph.types import interrupt

    sufficiency_raw = state.get("material_sufficiency_report")
    sufficiency = (
        MaterialSufficiencyReport.model_validate(sufficiency_raw)
        if isinstance(sufficiency_raw, dict)
        else None
    )
    if (
        settings.resume_material_sufficiency_enabled
        and state.get("material_sufficiency_status") == "unavailable"
    ):
        return {
            "assistant_message": "无法核验完整经历库的素材充足度，已阻止未经证明的补充请求。",
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "material_sufficiency_unavailable",
                    "message": "The complete FactBank sufficiency gate could not be evaluated.",
                }
            ],
            "resume_user_action": "failed",
            "interrupt_payload": None,
        }
    if sufficiency is not None and sufficiency.status == "sufficient":
        logger.error(
            "Blocked resume_content_gap because the complete FactBank is sufficient",
            extra={
                "global_supported_height_mm": sufficiency.global_supported_height_mm,
                "minimum_required_height_mm": sufficiency.minimum_required_height_mm,
            },
        )
        return {
            "assistant_message": (
                "完整经历库素材充足，但当前生成结果仍然欠填；已阻止错误的经历补充请求。"
            ),
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "sufficiency_invariant_violation",
                    "message": (
                        "Layout is underfilled while unused qualified FactBank material remains."
                    ),
                }
            ],
            "resume_user_action": "failed",
            "interrupt_payload": None,
        }

    constraint = LayoutConstraint.model_validate(
        state.get("layout_constraint") or LayoutConstraint().model_dump()
    )
    if sufficiency is not None:
        usage = sufficiency.supported_usage_ratio
        missing_mm = sufficiency.missing_height_mm
        missing_lines = sufficiency.approximate_missing_lines
    else:
        report_raw = state.get("layout_report") or {}
        report = LayoutReport.model_validate(report_raw)
        usage = report.pages[0].usage_ratio if report.pages else 0.0
        if (
            report.page_count == 1
            and constraint.minimum_page_usage_ratio <= usage <= constraint.maximum_page_usage_ratio
        ):
            logger.warning(
                "Bypassing stale resume content-gap route for in-band layout usage %.1f%%",
                usage * 100,
            )
            return {
                "resume_user_action": "continue",
                "interrupt_payload": None,
            }
        missing_mm = max(
            0.0,
            report.page_available_height_mm * constraint.minimum_page_usage_ratio
            - (report.pages[0].used_height_mm if report.pages else 0.0),
        )
        template = get_resume_template(state.get("layout_template_id"))
        missing_lines = max(
            0,
            math.ceil(missing_mm / template.profile.body.line_height_mm),
        )

    if state.get("content_gap_interaction_count", 0) >= 1:
        return {
            "assistant_message": "补充内容重新评估后仍不足，本次生成不再重复请求补充。",
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "material_still_insufficient_after_supplement",
                    "message": "The single directed supplement did not close the material gap.",
                }
            ],
            "resume_user_action": "failed",
            "interrupt_payload": None,
        }

    budgets = [
        value
        for value in (state.get("content_budget") or {}).get("experiences", [])
        if isinstance(value, dict) and value.get("category") != "education"
    ]
    budgets.sort(key=lambda value: float(value.get("jd_match_score") or 0.0), reverse=True)
    experience_by_id = {
        str(value.get("id")): value
        for value in state.get("relevant_experiences") or []
        if isinstance(value, dict) and value.get("id")
    }
    retrieval_experiences = (state.get("fact_retrieval_result") or {}).get("experiences") or []
    for value in retrieval_experiences:
        if not isinstance(value, dict) or not value.get("experience_id"):
            continue
        experience_id = str(value["experience_id"])
        experience_by_id.setdefault(
            experience_id,
            {
                "id": experience_id,
                "title": value.get("title"),
                "organization": value.get("organization"),
                "role": value.get("role"),
                "category": value.get("category"),
                "content": value.get("content"),
            },
        )

    requirement_by_id = {
        str(value.get("id")): str(value.get("text") or value.get("id"))
        for value in state.get("jd_requirements") or []
        if isinstance(value, dict) and value.get("id")
    }
    missing_requirement_ids = list(
        sufficiency.uncovered_must_have_requirement_ids if sufficiency is not None else ()
    )
    targeted_questions = [
        f"请补充能直接证明“{requirement_by_id.get(value, value)}”的具体经历事实。"
        for value in missing_requirement_ids[:3]
    ]
    suggestions: list[dict[str, object]] = []
    suggestion_sources: list[tuple[str, float]] = [
        (str(value.get("experience_id") or ""), float(value.get("jd_match_score") or 0.0))
        for value in budgets
    ]
    if not suggestion_sources:
        suggestion_sources = [
            (experience_id, 0.0)
            for experience_id, value in experience_by_id.items()
            if value.get("category") != "education"
        ]
    for experience_id, match_score in suggestion_sources[:3]:
        experience = experience_by_id.get(experience_id, {})
        suggestions.append(
            {
                "experience_id": experience_id,
                "title": str(experience.get("title") or experience_id),
                "jd_match_score": match_score,
                "questions": targeted_questions
                or [
                    "你具体负责了哪些模块、流程或交付物？",
                    "使用了哪些技术、方法或工具？",
                    "遇到了什么约束或难点，你如何解决？",
                    "最终产生了什么可验证的结果或影响？",
                ],
            }
        )

    interrupt_id = str(uuid.uuid4())
    payload = {
        "interrupt_id": interrupt_id,
        "type": "resume_content_gap",
        "message": (
            f"当前可验证内容约占一页的 {usage:.0%}，距离最低 "
            f"{constraint.minimum_page_usage_ratio:.0%} 还差约 "
            f"{missing_lines} 行。请补充最匹配经历的项目、职责、方法或结果细节。"
        ),
        "current_usage_ratio": usage,
        "target_usage_ratio": constraint.minimum_page_usage_ratio,
        "missing_height_mm": round(missing_mm, 2),
        "approximate_missing_lines": missing_lines,
        "missing_requirement_ids": missing_requirement_ids,
        "suggestions": suggestions,
        "action_options": [
            {
                "id": "supplement",
                "label": "补充经历",
                "description": "提交某段经历的新增事实并重新生成",
            },
            {"id": "cancel", "label": "暂不补充", "description": "结束本次生成"},
        ],
    }
    resume_value = interrupt(payload)
    if not isinstance(resume_value, dict) or resume_value.get("action") != "supplement":
        return {
            "assistant_message": "简历内容不足，已暂停生成。补充经历后可以重新生成。",
            "resume_user_action": "complete",
            "interrupt_payload": None,
        }

    while True:
        experience_id = str(resume_value.get("experience_id") or "")
        supplemental = str(
            resume_value.get("content")
            or resume_value.get("additional_content")
            or resume_value.get("message")
            or ""
        ).strip()
        if experience_id and supplemental and experience_id in experience_by_id:
            break
        resume_value = interrupt(
            {
                **payload,
                "interrupt_id": str(uuid.uuid4()),
                "message": "请选择一段有效经历，并填写要补充的具体事实。",
                "validation_error": "缺少有效的经历 ID 或具体事实。",
            }
        )
        if not isinstance(resume_value, dict) or resume_value.get("action") != "supplement":
            return {
                "assistant_message": "简历内容不足，已暂停生成。补充经历后可以重新生成。",
                "resume_user_action": "complete",
                "interrupt_payload": None,
            }

    source_experiences = [
        dict(value) for value in state.get("relevant_experiences") or [] if isinstance(value, dict)
    ]
    if not any(str(value.get("id")) == experience_id for value in source_experiences):
        source_experiences.append(dict(experience_by_id[experience_id]))
    updated_experiences: list[dict[str, object]] = []
    combined_content = ""
    for value in source_experiences:
        experience = dict(value)
        if str(experience.get("id")) == experience_id:
            combined_content = (
                str(experience.get("content") or "").rstrip()
                + "\n\n用户补充事实：\n"
                + supplemental
            )
            experience["content"] = combined_content
            experience["claims"] = []
        updated_experiences.append(experience)

    services = services_from_config(config)
    if services is None:
        return {
            "assistant_message": "补充内容暂时无法保存，请稍后重试。",
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "experience_revision_service_unavailable",
                    "message": "Experience revision service is unavailable.",
                }
            ],
            "resume_user_action": "failed",
            "interrupt_payload": None,
        }
    try:
        await services.experience.add_revision(
            state.get("user_id", ""),
            experience_id,
            combined_content,
            source="copilot",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to persist resume content supplement: %s", exc)
        return {
            "assistant_message": "补充内容保存失败，未消耗本次补充机会，请稍后重试。",
            "quality_status": "failed",
            "quality_issues": [
                {
                    "code": "experience_revision_persist_failed",
                    "message": "The supplemental experience revision was not persisted.",
                }
            ],
            "resume_user_action": "failed",
            "interrupt_payload": None,
        }

    return {
        "relevant_experiences": updated_experiences,
        # These values are derived from relevant_experiences. Invalidate them so
        # the resumed graph cannot regenerate from the pre-supplement snapshots.
        "selected_experiences": [],
        "experience_selection_result": None,
        "matching_plan": None,
        "content_budget": None,
        "fact_retrieval_result": None,
        "material_sufficiency_report": None,
        "material_sufficiency_status": None,
        "resume_plan": None,
        "resume_plan_status": None,
        "resume_plan_diagnostics": None,
        "evidence_pack": None,
        "resume_context_ready": False,
        "content_gap_interaction_count": state.get("content_gap_interaction_count", 0) + 1,
        "resume_user_action": "reload",
        "revision_instruction": "Use the newly supplied grounded experience facts.",
        "layout_revision_iteration": 0,
        "generation_call_count": 0,
        "resume_candidate_pool": None,
        "layout_report": None,
        "interrupt_payload": None,
    }


async def output_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Prepare interrupt payload and halt graph for user review."""
    if state.get("quality_status") != "passed":
        return {
            "assistant_message": "简历未通过质量门禁，未保存或进入审阅。",
            "interrupt_payload": None,
            "resume_user_action": "complete",
        }
    from langgraph.types import interrupt

    variants = state.get("variants", [])
    services = services_from_config(config)
    workspace = dict(state.get("workspace", {}))
    interrupt_id = str(uuid.uuid4())

    package_deliverables = state.get("application_deliverables", [])
    unsupported_requirements = state.get("unsupported_requirements", [])
    is_application_package = state.get("target_subgraph") == "application_package"
    interrupt_type: Literal["application_package_review", "resume_review"] = (
        "application_package_review" if is_application_package else "resume_review"
    )
    resume_object = variants[0] if variants else None
    message = (
        f"已生成 {len(package_deliverables)} 项附加投递材料和一份针对性简历，请检查后确认。"
        if is_application_package
        else "简历已生成，请审阅后确认或提出修改意见。"
    )

    buffered_events: list[dict[str, object]] = []
    writer = get_optional_stream_writer() or buffered_events.append
    if resume_object is not None:
        content = resume_object.get("content")
        structured = resume_object.get("structured")
        variant_id = resume_object.get("id")
        resume_id = workspace.get("resume_id") or "new"
        if isinstance(content, str) and isinstance(variant_id, str):
            await emit_content_diff_progress(
                writer,
                content,
                resume_id=str(resume_id),
                variant_id=variant_id,
                structured=structured if isinstance(structured, dict) else None,
            )

    interrupt_event: AgentInterruptEvent = {
        "event": "agent.interrupt",
        "interrupt_id": interrupt_id,
        "type": interrupt_type,
        "message": message,
        "variants": [],  # deprecated; kept as empty array for backwards-compat
        "resume": resume_object,
        "candidates": [],
        "action_options": [
            {
                "id": "accept",
                "label": "Accept",
                "description": "Accept the resume and save",
            },
            {"id": "revise", "label": "Revise", "description": "Request changes"},
            {"id": "discard", "label": "Discard", "description": "Discard and start over"},
        ],
    }

    existing_events = state.get("pending_sse_events", [])

    payload: dict[str, object] = {
        "interrupt_id": interrupt_id,
        "type": interrupt_type,
        "message": interrupt_event["message"],
        "resume": resume_object,
        "variants": [],  # deprecated
        "action_options": interrupt_event["action_options"],
        "workspace": workspace,
    }
    if is_application_package:
        payload["deliverables"] = package_deliverables
        payload["unsupported_requirements"] = unsupported_requirements

    # LangGraph interrupt — suspends execution here
    resume_value = interrupt(payload)

    # User discarded or a new chat message preempted this interrupt.
    if isinstance(resume_value, dict) and resume_value.get("action") in ("preempted", "discard"):
        return {
            "interrupt_payload": None,
            "assistant_message": "Resume variant discarded.",
            "workspace": workspace,
            "resume_user_action": "complete",
            "revision_instruction": None,
        }

    action = None
    if isinstance(resume_value, dict):
        action = resume_value.get("action") or resume_value.get("decision")
    if action in {"accept", "confirm"}:
        variant_id = variants[0].get("id") if variants else None
        if not isinstance(variant_id, str):
            raise ValueError("No resume draft available to accept")
        if services is None:
            raise RuntimeError("Resume service unavailable while accepting variant")
        accepted = await action_capabilities.accept_variant(
            services,
            state.get("user_id", ""),
            VariantInput(variantId=variant_id),
            base_workspace=cast("Mapping[str, JsonValue]", workspace),
        )
        workspace.update(accepted.workspace)

    user_revision_instruction = None
    if action == "revise" and isinstance(resume_value, dict):
        raw_instruction = (
            resume_value.get("revision_instruction")
            or resume_value.get("instruction")
            or resume_value.get("feedback")
            or resume_value.get("message")
        )
        if isinstance(raw_instruction, str) and raw_instruction.strip():
            user_revision_instruction = raw_instruction.strip()

    return {
        "assistant_message": _resume_confirmation_message(resume_value),
        "interrupt_payload": None,
        "workspace": workspace,
        "resume_user_action": (
            "revise" if action == "revise" and user_revision_instruction else "complete"
        ),
        "revision_instruction": user_revision_instruction,
        "review_iteration": 0 if user_revision_instruction else state.get("review_iteration", 0),
        "layout_revision_iteration": 0
        if user_revision_instruction
        else state.get("layout_revision_iteration", 0),
        "generation_call_count": 0
        if user_revision_instruction
        else state.get("generation_call_count", 0),
        "coverage_before_layout": []
        if user_revision_instruction
        else state.get("coverage_before_layout", []),
        "pending_sse_events": [*existing_events, *buffered_events, interrupt_event],
    }


# ── Routing ───────────────────────────────────────────────────────────────────


def _resume_confirmation_message(resume_value: object) -> str:
    if isinstance(resume_value, dict):
        action = resume_value.get("action") or resume_value.get("decision")
        if action in {"accept", "confirm"}:
            return "Resume variant accepted and saved."
        if action == "revise":
            return "Resume review feedback received. I can revise the variant next."
        if action == "discard":
            return "Resume variant discarded."
    return "Resume review confirmed."


def review_route(state: ResumeGenerationState) -> str:
    """After self-review, revise only while both loop and total-call budgets remain."""
    review = state.get("review_result") or {}
    iteration = state.get("review_iteration", 0)

    if (
        review.get("verdict") == "needs_revision"
        and iteration < settings.max_self_review_iterations
        and state.get("generation_call_count", 0) < settings.max_resume_generation_calls
    ):
        return "revision"
    return "quality_gate"


def output_route(state: ResumeGenerationState) -> str:
    return "revision" if state.get("resume_user_action") == "revise" else "end"


def content_gap_route(state: ResumeGenerationState) -> str:
    action = state.get("resume_user_action")
    if action == "reload":
        return "reload"
    if action == "continue":
        return "fact_check"
    if action == "failed":
        return "failed"
    return "end"


# ── Structured schema and rendering ───────────────────────────────────────────


_SectionType = Literal["education", "experience", "project", "skills", "other"]


class _LlmBullet(BaseModel):
    text: str
    matched_jd_requirement_ids: list[str] = Field(default_factory=list)
    source_fact_ids: list[str] = Field(default_factory=list)


class _LlmSectionItem(BaseModel):
    title: str | None = None
    organization: str | None = None
    role: str | None = None
    location: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    source_experience_id: str | None = None
    bullets: list[_LlmBullet] = Field(default_factory=list)
    raw_text: str | None = None


class _LlmSection(BaseModel):
    type: _SectionType
    heading: str | None = None
    items: list[_LlmSectionItem] = Field(default_factory=list)


class _LlmContact(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    location: str | None = None


class _LlmResumeStructure(BaseModel):
    language: str = "zh-CN"
    contact: _LlmContact | None = None
    sections: list[_LlmSection] = Field(default_factory=list)


class _LlmExperienceDraft(BaseModel):
    source_experience_id: str
    bullets: list[_LlmBullet] = Field(default_factory=list)


_EXPERIENCE_DRAFT_SYSTEM_PROMPT = """\
You are an expert resume bullet-point writer.

Write a candidate bullet pool for exactly ONE resume experience.
Return a JSON object: {"source_experience_id": "<id>", "bullets": [{"text": "...", "source_fact_ids": [...], "matched_jd_requirement_ids": [...]}]}

## Rules

1. Use ONLY supplied source facts (allowed_facts). Every source_fact_id must come from the allowed list.
2. Preserve numbers, percentages, metrics, and named technologies VERBATIM.
3. Do NOT upgrade descriptions ("熟悉"→"精通", "参与"→"主导") beyond what the source states.
4. Do NOT end bullets with a full stop (。．.).
5. source_experience_id must equal the supplied id exactly.
6. matched_jd_requirement_ids: only ids from relevant_jd_requirements. Use [] if no match.
7. Each bullet: ONE information-dense line, 36–52 full-width chars (Chinese) or 80–115 chars (English). Combine short facts.
8. Order: JD evidence first → quantified results → ownership → context. No synonym repetition.
"""


async def _generate_resume_by_experience(
    provider: LLMProvider,
    *,
    experiences: list[dict[str, object]],
    content_budget: dict[str, object],
    jd_requirements: list[dict[str, object]],
    evidence_pack: dict[str, object],
    language: str,
    fallback_contact: dict[str, object] | None,
    revision_instruction: str | None,
) -> _LlmResumeStructure | None:
    """Fan out narrative writing by experience and assemble one grounded draft.

    Each parallel call receives only its own source facts and the JD requirements
    it can actually address, keeping prompts small and focused.
    """
    raw_budgets = content_budget.get("experiences")
    budgets = raw_budgets if isinstance(raw_budgets, list) else []
    budget_by_id = {
        str(value.get("experience_id")): value
        for value in budgets
        if isinstance(value, dict) and value.get("experience_id")
    }

    budgeted_ids = set(budget_by_id.keys())
    narrative_candidates = [
        value
        for value in _sort_experiences_by_recency(experiences)
        if str(value.get("category") or "other") != "education"
        and (value.get("content") or value.get("claims"))
    ]
    if len(narrative_candidates) < settings.resume_parallel_min_experiences:
        return None

    if budgeted_ids:
        narrative = [
            value for value in narrative_candidates if str(value.get("id") or "") in budgeted_ids
        ][: settings.resume_parallel_max_experiences]
    else:
        narrative = narrative_candidates[: settings.resume_parallel_max_experiences]

    req_by_id = {
        str(r.get("id") or f"req-{i + 1}"): r
        for i, r in enumerate(jd_requirements)
        if isinstance(r, dict)
    }
    exp_req_map = _build_experience_requirement_map(evidence_pack, req_by_id)

    semaphore = asyncio.Semaphore(settings.resume_generation_max_concurrency)

    async def generate_one(experience: dict[str, object]) -> _LlmExperienceDraft:
        _gen_start = time.time()
        source_id = str(experience.get("id") or "")
        budget = budget_by_id.get(source_id, {})
        raw_allowed_facts = budget.get("facts") or _fallback_source_facts(experience)
        allowed_facts = raw_allowed_facts if isinstance(raw_allowed_facts, list) else []
        allowed_fact_ids = {
            str(value.get("id"))
            for value in allowed_facts
            if isinstance(value, dict) and value.get("id")
        }

        relevant_reqs = exp_req_map.get(source_id, list(jd_requirements))

        def grounded_fallback() -> _LlmExperienceDraft:
            target_count = max(
                2,
                min(int(budget.get("target_candidate_bullets") or 4), 6),
            )
            cleaned: list[tuple[str, str]] = []
            for value in allowed_facts:
                if not isinstance(value, dict) or not value.get("id") or not value.get("text"):
                    continue
                text = str(value["text"]).strip().rstrip("。．. ")
                text = text.lstrip("- •·")
                if text:
                    cleaned.append((str(value["id"]), text))

            fallback_bullets: list[_LlmBullet] = []
            i = 0
            while i < len(cleaned) and len(fallback_bullets) < target_count:
                fact_id, text = cleaned[i]
                fact_ids = [fact_id]
                i += 1
                while len(text) < 35 and i < len(cleaned):
                    next_id, next_text = cleaned[i]
                    text = f"{text}；{next_text}"
                    fact_ids.append(next_id)
                    i += 1
                fallback_bullets.append(
                    _LlmBullet(
                        text=text,
                        source_fact_ids=fact_ids,
                        matched_jd_requirement_ids=[],
                    )
                )
            return _LlmExperienceDraft(
                source_experience_id=source_id,
                bullets=fallback_bullets,
            )

        payload = {
            "source_experience": {
                "id": source_id,
                "category": experience.get("category"),
                "title": experience.get("title"),
                "organization": experience.get("organization"),
                "role": experience.get("role"),
                "content": experience.get("content"),
                "claims": experience.get("claims") or [],
            },
            "allowed_facts": allowed_facts,
            "target_candidate_bullets": budget.get("target_candidate_bullets") or 4,
            "relevant_jd_requirements": relevant_reqs,
            "language": language,
        }
        if revision_instruction:
            payload["revision_instruction"] = revision_instruction

        valid_req_ids = {
            str(r.get("id") or "") for r in relevant_reqs if isinstance(r, dict) and r.get("id")
        }

        messages = [
            {"role": "system", "content": _EXPERIENCE_DRAFT_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
        _use_fast_path = hasattr(provider, "chat_json")

        max_attempts = 3
        result: _LlmExperienceDraft | None = None
        for attempt in range(max_attempts):
            try:
                async with semaphore:
                    if _use_fast_path:
                        result = await provider.chat_json(
                            messages,
                            _LlmExperienceDraft,
                            temperature=0.2,
                        )
                    else:
                        result = await provider.chat_structured(
                            messages,
                            _LlmExperienceDraft,
                            temperature=0.2,
                        )
                break
            except Exception as exc:
                if attempt < max_attempts - 1:
                    wait = 5.0 * (2**attempt)
                    logger.warning(
                        "Experience draft attempt %d/%d failed for %s (%s); retrying in %.0fs",
                        attempt + 1,
                        max_attempts,
                        source_id,
                        type(exc).__name__,
                        wait,
                    )
                    await asyncio.sleep(wait)
                else:
                    logger.warning(
                        "Experience draft generation failed for %s; using grounded fallback (%s)",
                        source_id,
                        type(exc).__name__,
                    )
                    return grounded_fallback()

        if result is None:
            return grounded_fallback()
        sanitized_bullets: list[_LlmBullet] = []
        for bullet in result.bullets:
            fact_ids = [value for value in bullet.source_fact_ids if value in allowed_fact_ids]
            if not fact_ids:
                continue
            requirement_ids = [
                value for value in bullet.matched_jd_requirement_ids if value in valid_req_ids
            ]
            sanitized_bullets.append(
                bullet.model_copy(
                    update={
                        "source_fact_ids": fact_ids,
                        "matched_jd_requirement_ids": requirement_ids,
                    }
                )
            )
        if not sanitized_bullets:
            logger.info(
                "generate_one %s: %.1fs (fallback - no valid bullets)",
                source_id,
                time.time() - _gen_start,
            )
            return grounded_fallback()
        logger.info(
            "generate_one %s: %.1fs (%d bullets)",
            source_id,
            time.time() - _gen_start,
            len(sanitized_bullets),
        )
        return _LlmExperienceDraft(
            source_experience_id=source_id,
            bullets=sanitized_bullets,
        )

    _gather_start = time.time()
    raw_drafts = await asyncio.gather(*(generate_one(value) for value in narrative))
    logger.info(
        "All %d experience drafts completed in %.1fs", len(narrative), time.time() - _gather_start
    )
    drafts = [_deduplicate_bullets(d) for d in raw_drafts]
    sections: dict[str, list[_LlmSectionItem]] = {
        "education": [],
        "experience": [],
        "project": [],
        "other": [],
    }
    draft_by_id = {value.source_experience_id: value for value in drafts}
    for experience in _sort_experiences_by_recency(experiences):
        source_id = str(experience.get("id") or "")
        category = str(experience.get("category") or "other")
        section_type = {
            "work": "experience",
            "project": "project",
            "education": "education",
        }.get(category, "other")
        draft = draft_by_id.get(source_id)
        if category != "education" and draft is None:
            continue
        raw_text = str(experience.get("content") or "").strip() if category == "education" else None
        sections[section_type].append(
            _LlmSectionItem(
                title=_optional_string(experience.get("title")),
                organization=_optional_string(experience.get("organization")),
                role=_optional_string(experience.get("role")),
                location=_optional_string(experience.get("location")),
                start_date=_optional_string(experience.get("start_date")),
                end_date=_optional_string(experience.get("end_date")),
                source_experience_id=source_id,
                bullets=list(draft.bullets) if draft is not None else [],
                raw_text=raw_text or None,
            )
        )

    llm_sections = [
        _LlmSection(type=cast("_SectionType", section_type), items=items)
        for section_type, items in sections.items()
        if items
    ]
    skill_values: set[str] = set()
    for experience in experiences:
        raw_tags = experience.get("tags")
        tags = raw_tags if isinstance(raw_tags, list) else []
        skill_values.update(str(tag).strip() for tag in tags if str(tag).strip())
    skills = sorted(skill_values)
    if skills:
        llm_sections.append(
            _LlmSection(
                type="skills",
                items=[_LlmSectionItem(raw_text=" · ".join(skills))],
            )
        )
    contact = _LlmContact.model_validate(fallback_contact) if fallback_contact else None
    return _LlmResumeStructure(language=language, contact=contact, sections=llm_sections)


def _deduplicate_bullets(draft: _LlmExperienceDraft) -> _LlmExperienceDraft:
    """Remove duplicate bullets using character trigram Jaccard similarity.

    Two bullets are duplicates if their trigram Jaccard similarity exceeds 0.45.
    Keeps the longer one.
    """
    if len(draft.bullets) <= 1:
        return draft

    def _trigrams(text: str) -> set[str]:
        norm = "".join(text.lower().split())
        return {norm[i : i + 3] for i in range(max(0, len(norm) - 2))}

    def _jaccard(a: set[str], b: set[str]) -> float:
        if not a or not b:
            return 0.0
        return len(a & b) / len(a | b)

    bullet_grams = [_trigrams(b.text) for b in draft.bullets]
    kept_indices: list[int] = []

    for i, bullet in enumerate(draft.bullets):
        is_dup = False
        for j_pos, j in enumerate(kept_indices):
            if _jaccard(bullet_grams[i], bullet_grams[j]) > 0.45:
                if len(bullet.text) > len(draft.bullets[j].text):
                    kept_indices[j_pos] = i
                is_dup = True
                break
        if not is_dup:
            kept_indices.append(i)

    return _LlmExperienceDraft(
        source_experience_id=draft.source_experience_id,
        bullets=[draft.bullets[i] for i in kept_indices],
    )


def _build_experience_requirement_map(
    evidence_pack: dict[str, object],
    req_by_id: dict[str, dict[str, object]],
) -> dict[str, list[dict[str, object]]]:
    """Map experience_id -> list of JD requirements it can address via evidence claims.

    Returns an empty dict when ownership cannot be determined, which causes the
    caller to fall back to giving each experience all JD requirements.
    """
    matches = evidence_pack.get("matches")
    if not isinstance(matches, list) or not matches:
        return {}
    # Evidence pack currently stores matched claim text without the source
    # experience id. Until that's added, return empty so each experience
    # receives all evidence-backed requirements as candidates.
    return {}


def _fallback_source_facts(experience: dict[str, object]) -> list[dict[str, str]]:
    """Build deterministic fact ids when an older state lacks content-budget facts."""
    source_id = str(experience.get("id") or "")
    texts: list[str] = []
    raw_claims = experience.get("claims")
    claims = raw_claims if isinstance(raw_claims, list) else []
    for claim in claims:
        if isinstance(claim, dict) and claim.get("text"):
            texts.append(str(claim["text"]).strip())
    if not texts:
        texts.extend(
            line.strip()
            for line in str(experience.get("content") or "").splitlines()
            if line.strip()
        )
    return [
        {"id": f"{source_id}-fact-{index}", "text": text}
        for index, text in enumerate(texts, start=1)
    ]


def _optional_string(value: object) -> str | None:
    return str(value) if value is not None and str(value).strip() else None


_DEFAULT_HEADINGS_ZH: dict[str, str] = {
    "education": "教育背景",
    "experience": "实习/工作经历",
    "project": "项目经历",
    "skills": "专业技能",
    "other": "其他",
}

_DEFAULT_HEADINGS_EN: dict[str, str] = {
    "education": "Education",
    "experience": "Experience",
    "project": "Projects",
    "skills": "Skills",
    "other": "Other",
}


def _extract_contact_from_profile(profile: dict[str, object]) -> dict[str, object] | None:
    """Best-effort pull of name/email/phone/location from user profile."""
    if not profile:
        return None
    contact = {
        "name": profile.get("full_name") or profile.get("name"),
        "email": profile.get("email"),
        "phone": profile.get("phone"),
        "location": profile.get("location") or profile.get("city") or profile.get("country"),
    }
    if any(v for v in contact.values()):
        return {k: (str(v) if v is not None else None) for k, v in contact.items()}
    return None


def _assign_structure_ids(
    llm: _LlmResumeStructure,
    fallback_contact: dict[str, object] | None = None,
    previous_structured: dict[str, object] | None = None,
) -> dict[str, object]:
    """Attach stable UUIDs to sections / items / bullets and produce the final JSON.

    When `previous_structured` is provided (Tier 3 edit), items with matching
    `source_experience_id` reuse their previous ids; bullets are matched by
    text similarity (>0.6) to preserve ids across revisions.
    """
    default_headings = (
        _DEFAULT_HEADINGS_ZH if llm.language.lower().startswith("zh") else _DEFAULT_HEADINGS_EN
    )

    # Build id reuse table from previous_structured
    prev_item_by_src: dict[str, dict[str, object]] = {}
    if previous_structured:
        raw_previous_sections = previous_structured.get("sections")
        previous_sections = raw_previous_sections if isinstance(raw_previous_sections, list) else []
        for prev_sec in previous_sections:
            if not isinstance(prev_sec, dict):
                continue
            for prev_item in prev_sec.get("items") or []:
                if not isinstance(prev_item, dict):
                    continue
                src_id = prev_item.get("source_experience_id")
                if src_id and isinstance(src_id, str):
                    prev_item_by_src[src_id] = prev_item

    sections: list[dict[str, object]] = []
    for section in llm.sections:
        section_dict: dict[str, object] = {
            "id": f"sec-{uuid.uuid4()}",
            "type": section.type,
            "heading": section.heading or default_headings.get(section.type, ""),
            "items": [],
        }
        for item in section.items:
            prev_item = (
                prev_item_by_src.get(item.source_experience_id)
                if item.source_experience_id
                else None
            )
            item_id = prev_item["id"] if prev_item else f"item-{uuid.uuid4()}"

            raw_prev_bullets = prev_item.get("bullets") if prev_item else None
            prev_bullets = (
                [value for value in raw_prev_bullets if isinstance(value, dict)]
                if isinstance(raw_prev_bullets, list)
                else []
            )
            bullets_out: list[dict[str, object]] = []
            for bi, b in enumerate(item.bullets):
                if (
                    bi < len(prev_bullets)
                    and _text_similarity(b.text, str(prev_bullets[bi].get("text", ""))) > 0.6
                ):
                    bul_id = prev_bullets[bi]["id"]
                else:
                    bul_id = f"bul-{uuid.uuid4()}"
                bullets_out.append(
                    {
                        "id": bul_id,
                        "text": b.text,
                        "matched_jd_requirement_ids": list(b.matched_jd_requirement_ids),
                        "source_fact_ids": list(b.source_fact_ids),
                    }
                )

            item_dict: dict[str, object] = {
                "id": item_id,
                "title": item.title,
                "organization": item.organization,
                "role": item.role,
                "location": item.location,
                "start_date": item.start_date,
                "end_date": item.end_date,
                "source_experience_id": item.source_experience_id,
                "bullets": bullets_out,
                "raw_text": item.raw_text,
            }
            cast("list[dict[str, object]]", section_dict["items"]).append(item_dict)
        if section.type in ("experience", "project", "education"):
            items_list = cast("list[dict[str, object]]", section_dict["items"])
            items_list.sort(key=_item_recency_key, reverse=True)
        sections.append(section_dict)

    contact: dict[str, object] | None = None
    if llm.contact is not None:
        contact = llm.contact.model_dump()
    elif fallback_contact is not None:
        contact = fallback_contact

    return normalize_resume_narrative_punctuation(
        {
            "language": llm.language,
            "contact": contact,
            "sections": sections,
            "layout_profile_version": DEFAULT_RESUME_LAYOUT_PROFILE.version,
            "layout_profile_hash": DEFAULT_RESUME_LAYOUT_PROFILE.profile_hash,
            "layout_template_id": STANDARD_RESUME_TEMPLATE.template_id,
        }
    )


def _text_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    set_a, set_b = set(a), set(b)
    return len(set_a & set_b) / max(len(set_a), len(set_b))


def _render_structured_to_markdown(structured: dict[str, object]) -> str:
    return render_structured_to_markdown(structured)


def _derive_resume_title(state: ResumeGenerationState, structured: dict[str, object]) -> str:
    """Best-effort human title for the resume draft."""
    intent = state.get("intent_description") or ""
    if intent:
        trimmed = intent.strip()
        if trimmed:
            return trimmed[:80]
    contact = structured.get("contact")
    if isinstance(contact, dict) and contact.get("name"):
        return f"{contact['name']} 的简历"
    return "AI Generated Resume"
