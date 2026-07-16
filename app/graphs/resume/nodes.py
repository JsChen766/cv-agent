"""
Resume Generation subgraph nodes.

Flow:
  context_assembly → cot_planning → draft_generation →
  layout_measure → fact_check → coverage_check → self_review → quality_gate
"""

import json
import logging
import re
import uuid
from collections.abc import Mapping
from typing import Literal, cast

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field, JsonValue

from app.core.config import settings
from app.core.events import AgentInterruptEvent
from app.domain.resume.layout_models import LayoutConstraint, LayoutReport
from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.domain.resume.models import ResumeVariantCreate
from app.domain.resume.render import render_structured_to_markdown
from app.graphs.resume.state import ResumeGenerationState
from app.graphs.runtime import pool_from_config, services_from_config
from app.graphs.streaming import (
    emit_content_diff_progress,
    emit_thinking,
    get_optional_stream_writer,
)
from app.providers.factory import get_provider
from app.tools.actions import capabilities as action_capabilities
from app.tools.actions.models import VariantInput

logger = logging.getLogger(__name__)

# ── 1. Context Assembly ───────────────────────────────────────────────────────


async def context_assembly_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Gather all context needed for resume generation."""
    from app.memory.context_assembly import assemble_context

    extracted = state.get("extracted_params", {})
    raw_jd = extracted.get("raw_jd_text") or extracted.get("jd_text")
    fallback_jd_text = raw_jd if isinstance(raw_jd, str) and raw_jd.strip() else None

    try:
        pool = pool_from_config(config)
        if pool is None:
            return {"jd_text": fallback_jd_text} if fallback_jd_text else {}
        ctx = await assemble_context(
            state,
            pool,
            services=services_from_config(config),
        )
        return {
            "jd_text": ctx.jd_text or fallback_jd_text,
            "relevant_experiences": ctx.experiences,
            "guideline_instructions": ctx.guideline_instructions,
            "user_preferences": ctx.preferences,
            "user_profile": ctx.user_profile,
            "evidence_pack": ctx.evidence_pack.model_dump() if ctx.evidence_pack else None,
        }
    except RuntimeError:
        # Pool not available (test mode)
        return {"jd_text": fallback_jd_text} if fallback_jd_text else {}


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
    """Chain-of-thought planning before generation.

    Produces a per-requirement `coverage_plan` mapping each JD requirement to the
    source experiences that should support it. The plan is a hint to the LLM in
    draft_generation — the LLM still owns final bullet-to-requirement decisions,
    which coverage_check verifies afterwards.
    """
    provider = get_provider()

    jd_text = state.get("jd_text") or state.get("assembled_jd_text", "")
    jd_requirements = state.get("jd_requirements") or []
    experiences = state.get("relevant_experiences") or state.get("assembled_experiences", [])
    prefs = state.get("user_preferences") or state.get("assembled_preferences", [])
    profile = state.get("user_profile") or state.get("assembled_user_profile")
    intent = state.get("intent_description", "Generate a tailored resume")

    context_parts = [f"Intent: {intent}"]
    if jd_text:
        context_parts.append(f"JD Summary:\n{jd_text[:1500]}")
    if jd_requirements:
        req_lines = [
            f"- id={r.get('id') or f'req-{i + 1}'}: {r.get('text', '')}"
            for i, r in enumerate(jd_requirements)
            if isinstance(r, dict)
        ]
        context_parts.append(
            "JD requirements (map coverage_plan entries to these ids verbatim):\n"
            + "\n".join(req_lines)
        )
    if profile:
        context_parts.append(
            f"User: {profile.get('current_title', '')} | {profile.get('career_stage', '')}"
        )
    if experiences:
        exp_list = "\n".join(
            f"- id={e.get('id', 'N/A')}: {e.get('title')} at {e.get('organization', 'N/A')}"
            for e in experiences[:12]
        )
        context_parts.append(f"Available Experiences:\n{exp_list}")
    if prefs:
        pref_list = "\n".join(f"- {p.get('rule')}" for p in prefs[:5])
        context_parts.append(f"User Preferences:\n{pref_list}")

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在匹配岗位要求与经历证据…")

    plan: MatchingPlan = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "You are a senior resume strategist. Based on the JD requirements and "
                    "the candidate's source experiences, produce a strategic plan for resume generation.\n"
                    "Think step by step about:\n"
                    "1. Which experiences best support each JD requirement.\n"
                    "2. What skills to emphasize.\n"
                    "3. The overall tone and structure.\n\n"
                    "You MUST populate `coverage_plan`: one entry per JD requirement. For each "
                    "entry, set `requirement_id` and `requirement_text` VERBATIM from the input, "
                    "and list `planned_source_experience_ids` — the ids of source experiences "
                    "whose content should back that requirement in the final resume. If no "
                    "experience truly supports a requirement, return an empty list for that "
                    "requirement (do NOT invent). Do not include ids that were not shown to you."
                ),
            },
            {"role": "user", "content": "\n\n".join(context_parts)},
        ],
        MatchingPlan,
        temperature=0.3,
    )

    layout_constraint = _layout_constraint_from_state(state)
    return {
        "matching_plan": plan.model_dump() if plan else None,
        "generation_strategy": plan.strategy if plan else "standard",
        "layout_constraint": layout_constraint.model_dump(),
        "layout_profile_version": DEFAULT_RESUME_LAYOUT_PROFILE.version,
        "layout_profile_hash": DEFAULT_RESUME_LAYOUT_PROFILE.profile_hash,
    }


# ── 3. Draft Generation ───────────────────────────────────────────────────────


def _layout_constraint_from_state(state: ResumeGenerationState) -> LayoutConstraint:
    extracted = state.get("extracted_params", {})
    raw_pages = extracted.get("page_count") or extracted.get("pages")
    if isinstance(raw_pages, int) and raw_pages >= 2:
        return LayoutConstraint(max_pages=None, requested_pages=raw_pages)
    intent = str(state.get("intent_description") or "")
    if re.search(r"(?:two|2|两|二)\s*(?:pages?|页)", intent, re.IGNORECASE):
        return LayoutConstraint(max_pages=None, requested_pages=2)
    if re.search(r"(?:multi|multiple|多)\s*(?:pages?|页)", intent, re.IGNORECASE):
        return LayoutConstraint(max_pages=None)
    return LayoutConstraint(max_pages=1)


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
    experiences = state.get("relevant_experiences") or []
    prefs = state.get("user_preferences") or []
    plan = state.get("matching_plan") or {}
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
                "JD-match ranking (higher tier = stronger JD match; use to allocate bullet counts):\n"
                + "\n".join(
                    f"- {exp_id}: tier={tier} (target_bullets={target})"
                    for exp_id, tier, target in match_tiers
                )
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
        "Layout budget: "
        + (
            "the final resume must fit one A4 page. Prefer 3–4 bullets for the strongest "
            "items and 1–2 for supporting items; do not generate filler."
            if constraint.is_single_page
            else "multiple A4 pages are allowed, but page breaks must remain natural and content dense."
        )
    )

    preferred_lang = profile.get("preferred_language", "zh-CN")
    lang_instruction = (
        "Respond in Chinese (Simplified)." if "zh" in preferred_lang else "Respond in English."
    )
    profile_contact = _extract_contact_from_profile(profile)

    existing_events = list(state.get("pending_sse_events", []))
    buffered_events: list[dict[str, object]] = []
    writer = get_optional_stream_writer() or buffered_events.append
    emit_thinking(writer, "正在生成并组织简历内容…")

    llm_structure: _LlmResumeStructure = await provider.chat_structured(
        [
            {"role": "system", "content": _DRAFT_SYSTEM_PROMPT.format(lang=lang_instruction)},
            {"role": "user", "content": "\n\n".join(prompt_parts)},
        ],
        _LlmResumeStructure,
        temperature=0.2,
    )
    previous_structured = state.get("previous_structured")
    structured = _assign_structure_ids(
        llm_structure,
        fallback_contact=profile_contact,
        previous_structured=previous_structured or state.get("resume_structure"),
    )
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
        "pending_sse_events": [*existing_events, *buffered_events],
        "coverage_before_layout": coverage_before,
        "generation_call_count": state.get("generation_call_count", 0) + 1,
        "layout_profile_version": DEFAULT_RESUME_LAYOUT_PROFILE.version,
        "layout_profile_hash": DEFAULT_RESUME_LAYOUT_PROFILE.profile_hash,
        "quality_status": None,
        "quality_issues": [],
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
              "matched_jd_requirement_ids": ["req-1", ...]   // ids from the JD requirements block; [] if the bullet doesn't directly support a listed requirement
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

## Section order and content

Emit sections in this order, skipping any with zero relevant data:

1. `education` — one item per source `category="education"`. Include the degree in `title`, school in `organization`, dates, and put courses / GPA / honours in `raw_text` (a compact block); leave `bullets` empty.
2. `experience` — one item per source `category="work"`. Populate `title`/`organization`/`role`/dates from source. Leave `raw_text` null.
3. `project` — one item per source `category="project"`. Same bullet rules as experience.
4. `skills` — one item with `raw_text` grouping skills by area (e.g. "编程语言：..."). Only include technologies actually appearing in source content or the JD. Leave `bullets` empty.

Never emit a summary/profile/about section.

## Experience & project selection rules (HARD)

R1. **Education is exhaustive**: the `education` section MUST contain ONE item for EVERY source experience with `category=education`. Never omit an education entry — even if it looks less relevant to the JD. This is non-negotiable.
R2. **Page-aware inclusion for work / project**: include the strongest JD-matched work and project items first. Include additional items only when they add distinct grounded evidence and fit the stated page budget.
    - Coverage floor: if the source has ≥1 work experience, `experience` section MUST have ≥1 item. Same for project.
R3. **Recency-first, per section**: within EACH of the `experience` and `project` sections, order items strictly by end_date DESCENDING (most recent first). If end_date is missing use start_date. Never interleave categories; each item stays in its section. The `education` section follows the same rule.
R4. **Bullet count by JD match**: use the JD-match ranking block to decide how many bullets each item gets.
    - tier=1 (top JD match): 3–4 bullets in one-page mode, up to 5 in multi-page mode
    - tier=2: 2–3 bullets
    - tier=3 or unranked: 1–2 bullets
    Each bullet must remain specific and quantified where the source supports it. Do NOT pad with generic filler to reach a count — if the source cannot support N bullets faithfully, emit fewer and stay honest.

## Language

Match the source language for names and quantities; write connectives in the requested output language.
"""


# ── 3.25. Deterministic layout loop ──────────────────────────────────────────


async def layout_measure_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    variants = state.get("variants") or []
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
    constraint = LayoutConstraint.model_validate(
        state.get("layout_constraint") or LayoutConstraint().model_dump()
    )
    report = layout_service.measure_resume_layout(structured, constraint)
    return {
        "layout_report": report.model_dump(),
        "layout_status": report.status,
        "layout_profile_version": report.profile_version,
        "layout_profile_hash": report.profile_hash,
    }


def layout_route(state: ResumeGenerationState) -> str:
    report = state.get("layout_report") or {}
    status = report.get("status") or state.get("layout_status")
    can_revise = (
        state.get("layout_revision_iteration", 0) < settings.max_layout_revision_iterations
        and state.get("generation_call_count", 0) < settings.max_resume_generation_calls
    )
    if status == "needs_revision" and can_revise:
        return "revision"
    return "fact_check"


async def layout_revision_node(state: ResumeGenerationState) -> dict[str, object]:
    variants = state.get("variants") or []
    current = variants[0].get("structured") if variants else state.get("resume_structure")
    if not isinstance(current, dict):
        return {}
    report = LayoutReport.model_validate(state.get("layout_report") or {})
    experiences = state.get("relevant_experiences") or []
    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在压缩低信息密度内容并优化换行…")
    provider = get_provider()
    revised: _LlmResumeStructure = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "You revise a structured resume only to fix the supplied deterministic layout "
                    "violations. Preserve all grounded facts and existing JD coverage. Never invent "
                    "facts, truncate text, use ellipses, or add a summary. For long/awkward bullets: "
                    "remove repetition, merge synonymous phrasing, and preserve action, object, method, "
                    "and grounded result. For short bullets: expand only from the source experience; "
                    "otherwise remove a low-value duplicate. Only when a single-line bullet is a key "
                    "fact that cannot be expanded, set layout_exception=unfixable_grounded_short. "
                    "For one-page overflow, remove lowest-JD-value redundant bullets/items first, while "
                    "keeping all education entries and at least one work and project item when sourced."
                ),
            },
            {
                "role": "user",
                "content": (
                    "LAYOUT REPORT:\n"
                    + json.dumps(report.model_dump(), ensure_ascii=False, indent=2)
                    + "\n\nCURRENT STRUCTURE:\n"
                    + json.dumps(current, ensure_ascii=False, indent=2)
                    + "\n\nSOURCE EXPERIENCES (only ground truth):\n"
                    + _format_experiences_for_prompt(experiences)
                ),
            },
        ],
        _LlmResumeStructure,
        temperature=0.1,
    )
    structured = _assign_structure_ids(
        revised,
        fallback_contact=(
            current.get("contact") if isinstance(current.get("contact"), dict) else None
        ),
        previous_structured=current,
    )
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
        "layout_revision_iteration": state.get("layout_revision_iteration", 0) + 1,
        "generation_call_count": state.get("generation_call_count", 0) + 1,
        "layout_report": None,
        "layout_status": None,
    }


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
    """Assign each experience a JD-match tier (1=top / 2=mid / 3=other) and a target bullet count.

    Uses `matching_plan.coverage_plan` — how many JD requirements planned to lean on the
    experience — as the proxy for match strength. Ties broken by recency (input order is
    already most-recent-first).

    Returns list of (source_experience_id, tier, target_bullets_hint).
    """
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

    if not hit_counts:
        return []

    max_hits = max(hit_counts.values())
    ranked: list[tuple[str, int, str]] = []
    for exp in experiences:
        exp_id = exp.get("id")
        if not isinstance(exp_id, str):
            continue
        hits = hit_counts.get(exp_id, 0)
        if hits == 0:
            tier, target = 3, "2-3"
        elif hits >= max_hits:
            tier, target = 1, "5-6"
        elif hits >= max(1, max_hits - 1):
            tier, target = 2, "4-5"
        else:
            tier, target = 3, "2-3"
        ranked.append((exp_id, tier, target))
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
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


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


class _FactMismatch(BaseModel):
    field: Literal["date", "organization", "role", "metric", "technology", "title", "other"]
    drafted_value: str
    source_value: str | None = None  # None when the draft claim has no source at all
    experience_title: str = ""  # which source experience it should have come from
    detail: str | None = None  # short explanation


class _FactCheckResult(BaseModel):
    mismatches: list[_FactMismatch] = Field(default_factory=list)


async def fact_check_node(state: ResumeGenerationState) -> dict[str, object]:
    """Verify every date / organization / role / metric / technology in the draft
    can be sourced verbatim from `relevant_experiences`. Uses the structured draft
    (if available) for precise per-field comparison, falling back to markdown."""
    import json as _json

    variants = state.get("variants", [])
    if not variants:
        return {"fact_mismatches": []}

    structured = variants[0].get("structured") or state.get("resume_structure")
    draft_content = variants[0].get("content", "")

    experiences = state.get("relevant_experiences") or []
    if not experiences:
        return {"fact_mismatches": []}

    if isinstance(structured, dict) and structured.get("sections"):
        draft_block = "DRAFT (structured JSON):\n" + _json.dumps(
            structured, ensure_ascii=False, indent=2
        )
    elif isinstance(draft_content, str) and draft_content.strip():
        draft_block = "DRAFT (markdown):\n" + draft_content
    else:
        return {"fact_mismatches": []}

    provider = get_provider()
    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在核对简历中的事实与数据…")

    result: _FactCheckResult = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "You are a strict fact-checker. Compare a resume DRAFT against the "
                    "SOURCE experiences. Flag every case where the DRAFT contains a specific "
                    "date, organization name, role, quantitative claim (number/percentage/count), "
                    "or technology name that does NOT appear verbatim in the SOURCE for the "
                    "same experience. Normalise date formats (2024.04 == 2024-04 == 2024年4月). "
                    "When the DRAFT is structured JSON, use `source_experience_id` on each item "
                    "to look up the correct source experience for comparison — do not compare an "
                    "item against a different experience. "
                    "Do NOT flag: rewording, restructuring, translation of connectives, or "
                    "well-known synonyms. DO flag: any date year/month/day change, any org name "
                    "substitution, any role substitution, any number that isn't in source, any "
                    "tech name not in source. Return an empty list if the draft is clean."
                ),
            },
            {
                "role": "user",
                "content": (
                    "SOURCE experiences:\n"
                    + _format_experiences_for_prompt(experiences)
                    + "\n\n"
                    + draft_block
                ),
            },
        ],
        _FactCheckResult,
        temperature=0.0,
    )

    mismatches = [m.model_dump() for m in result.mismatches] if result else []
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


class ReviewResult(BaseModel):
    verdict: str  # "pass" | "needs_revision"
    revision_instruction: str | None = None
    issues: list[str] = Field(default_factory=list)
    score_estimate: float = 0.7


async def self_review_node(state: ResumeGenerationState) -> dict[str, object]:
    """Review generated variants for quality. Max 3 iterations.

    Fact mismatches from `fact_check_node` are always a hard-fail — they force a
    revision regardless of the qualitative review verdict.
    """
    iteration = state.get("review_iteration", 0)
    if iteration >= settings.max_self_review_iterations:
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
        state.get("relevant_experiences") or [],
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

    content = variants[0].get("content", "")
    jd_text = state.get("jd_text") or ""

    provider = get_provider()
    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在检查简历质量和岗位匹配度…")

    result: ReviewResult = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "Review this resume for quality. Check:\n"
                    "1. Are claims specific and verifiable (not vague)?\n"
                    "2. Does it address the JD requirements?\n"
                    "3. Are there unsubstantiated superlatives?\n"
                    "4. Is the language natural and professional?\n\n"
                    "If issues found, provide a specific revision_instruction. "
                    "Only fail if there are significant quality issues worth fixing."
                ),
            },
            {
                "role": "user",
                "content": f"JD:\n{jd_text[:1000]}\n\nResume:\n{content[:2000]}",
            },
        ],
        ReviewResult,
        temperature=0.2,
    )

    return {
        "review_result": result.model_dump() if result else {"verdict": "pass"},
        "revision_instruction": result.revision_instruction if result else None,
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
    report = LayoutReport.model_validate(report_raw)
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

    if report.status == "profile_mismatch" or review_failed:
        quality_status = "failed"
    elif hard_layout or coverage_regressions:
        quality_status = "needs_user_decision"
    elif not settings.resume_layout_hard_gate_enabled:
        issues.append(
            {
                "code": "layout_calibration_pending",
                "message": (
                    "Browser calibration is pending; the estimated layout cannot be "
                    "silently treated as a hard quality pass."
                ),
            }
        )
        quality_status = "needs_user_decision"
    else:
        quality_status = "passed"
    return {"quality_status": quality_status, "quality_issues": issues}


def quality_gate_route(state: ResumeGenerationState) -> str:
    status = state.get("quality_status")
    if status == "passed":
        return "passed"
    if status == "needs_user_decision":
        return "needs_user_decision"
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
                jd_record = await services.jd.create_or_update_from_raw_text(
                    state.get("user_id", ""),
                    raw_jd,
                    source_thread_id=thread_id_val if isinstance(thread_id_val, str) else None,
                )
                jd_id = jd_record.id
                workspace["jd_id"] = jd_id
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to promote raw_jd_text to jd_records: %s", exc)

    if not resume_id:
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
        await services.resume.get_resume(state.get("user_id", ""), resume_id)

    saved_variants: list[dict[str, object]] = []
    for variant in state.get("variants", []):
        title = variant.get("title")
        content = variant.get("content")
        structured = variant.get("structured")
        saved = await services.resume.save_variant(
            resume_id,
            ResumeVariantCreate.model_validate(
                {
                    "jd_id": jd_id,
                    "title": title if isinstance(title, str) and title else "AI Generated Variant",
                    "content": content if isinstance(content, str) else "",
                    "structured": structured if isinstance(structured, dict) else None,
                    "score": variant.get("score", {}),
                    "evidence_summary": variant.get("evidence_summary", []),
                    "risk_summary": variant.get("risk_summary", []),
                    "missing_info": variant.get("missing_info", []),
                }
            ),
        )
        saved_variants.append(saved.model_dump(mode="json"))

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
                await thread_repo.update_workspace_snapshot(thread_id_val, snapshot_delta)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to persist workspace snapshot: %s", exc)

    return {"workspace": workspace, "variants": saved_variants}


async def persist_decision_candidate_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    issues = state.get("quality_issues") or []
    variants: list[dict[str, object]] = []
    for value in state.get("variants", []):
        variant = dict(value)
        structured = variant.get("structured")
        if isinstance(structured, dict):
            structured = dict(structured)
            structured["quality_status"] = "needs_user_decision"
            structured["quality_issues"] = issues
            variant["structured"] = structured
        risks = list(variant.get("risk_summary") or [])
        risks.extend(
            {
                "type": "layout_quality_exception",
                "text": str(issue.get("message") or issue.get("code") or "Unresolved layout issue"),
                "severity": "medium",
            }
            for issue in issues
            if isinstance(issue, dict)
        )
        variant["risk_summary"] = risks
        variants.append(variant)
    working_state = dict(state)
    working_state["variants"] = variants
    result = await persist_resume_draft_node(cast("ResumeGenerationState", working_state), config)
    result["quality_status"] = "needs_user_decision"
    return result


async def output_failure_node(state: ResumeGenerationState) -> dict[str, object]:
    issues = state.get("quality_issues") or []
    details = "; ".join(
        str(issue.get("message") or issue.get("code"))
        for issue in issues
        if isinstance(issue, dict)
    )
    return {
        "assistant_message": (
            "简历生成未通过事实与质量检查，未保存为可接受候选。"
            + (f" 未解决问题：{details}" if details else "")
        ),
        "resume_user_action": "complete",
        "interrupt_payload": None,
    }


async def output_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Prepare interrupt payload and halt graph for user review."""
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
    unresolved = state.get("quality_issues") or []
    decision_suffix = ""
    if state.get("quality_status") == "needs_user_decision" and unresolved:
        decision_suffix = " 当前候选仍有需你明确决定的问题：" + "；".join(
            str(issue.get("message") or issue.get("code"))
            for issue in unresolved
            if isinstance(issue, dict)
        )
    message = (
        f"已生成 {len(package_deliverables)} 项附加投递材料和一份针对性简历，请检查后确认。"
        if is_application_package
        else "简历已生成，请审阅后确认或提出修改意见。"
    ) + decision_suffix

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


# ── Structured schema and rendering ───────────────────────────────────────────


_SectionType = Literal["education", "experience", "project", "skills", "other"]


class _LlmBullet(BaseModel):
    text: str
    matched_jd_requirement_ids: list[str] = Field(default_factory=list)
    layout_exception: Literal["unfixable_grounded_short"] | None = None


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
                        "layout_exception": b.layout_exception,
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

    return {
        "language": llm.language,
        "contact": contact,
        "sections": sections,
        "layout_profile_version": DEFAULT_RESUME_LAYOUT_PROFILE.version,
        "layout_profile_hash": DEFAULT_RESUME_LAYOUT_PROFILE.profile_hash,
    }


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
