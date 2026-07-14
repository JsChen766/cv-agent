"""Artifact Generation subgraph nodes.

Flow (Layer A/B/C):
    context_assembly
        → draft_generation           (structured LLM output per artifact type)
        → fact_check                 (LLM verifies drafted facts vs source experiences)
        → coverage_check             (per-type; interview_prep checks JD coverage)
        → self_review                (hard-fails on any fact mismatch)
            → revision → draft_generation   (max N iterations)
        → persist
"""

from __future__ import annotations

import json as _json
import logging
import uuid
from typing import Any, Literal, cast

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.events import ArtifactCompletedEvent, ArtifactDeltaEvent, ArtifactStartedEvent
from app.graphs.artifact.registry import get_config
from app.graphs.runtime import pool_from_config, services_from_config, thread_id_from_config
from app.graphs.state import MainState
from app.providers.factory import get_provider

logger = logging.getLogger(__name__)

# Artifact types that render in the canvas panel.
# Empty by default — all current types go straight into thread messages.
# Add a type string here to restore canvas behaviour for that type.
_CANVAS_ARTIFACT_TYPES: set[str] = set()


# ── 1. Context Assembly ───────────────────────────────────────────────────────


async def artifact_context_assembly_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Fetch context for artifact generation."""
    from app.memory.context_assembly import assemble_context

    try:
        pool = pool_from_config(config)
        if pool is None:
            return {}
        ctx = await assemble_context(
            state,
            pool,
            services=services_from_config(config),
        )
        return {
            "assembled_jd_text": ctx.jd_text,
            "assembled_experiences": ctx.experiences,
            "assembled_preferences": ctx.preferences,
            "assembled_user_profile": ctx.user_profile,
            "assembled_guideline_instructions": ctx.guideline_instructions,
        }
    except RuntimeError:
        return {}


# ── 2. Structured schemas (per artifact type) ────────────────────────────────


class _CoverLetterParagraph(BaseModel):
    text: str
    source_experience_ids: list[str] = Field(default_factory=list)
    matched_jd_requirement_ids: list[str] = Field(default_factory=list)


class _CoverLetterStructure(BaseModel):
    recipient: str | None = None
    opening: str
    body_paragraphs: list[_CoverLetterParagraph] = Field(default_factory=list)
    closing: str
    signature: str | None = None


class _SelfIntroSentence(BaseModel):
    text: str
    source_experience_ids: list[str] = Field(default_factory=list)


class _SelfIntroStructure(BaseModel):
    sentences: list[_SelfIntroSentence] = Field(default_factory=list)


class _MatchRequirement(BaseModel):
    requirement_id: str
    requirement_text: str
    match_level: Literal["strong", "partial", "missing"]
    evidence_experience_ids: list[str] = Field(default_factory=list)
    evidence_snippets: list[str] = Field(default_factory=list)
    recommendation: str = ""


class _MatchReportStructure(BaseModel):
    requirements: list[_MatchRequirement] = Field(default_factory=list)
    overall_score: int = 0
    actionable_suggestions: list[str] = Field(default_factory=list)


class _InterviewStarAnswer(BaseModel):
    situation: str
    task: str
    action: str
    result: str


class _InterviewQuestion(BaseModel):
    question: str
    star_answer: _InterviewStarAnswer
    source_experience_ids: list[str] = Field(default_factory=list)
    matched_jd_requirement_ids: list[str] = Field(default_factory=list)


class _InterviewPrepStructure(BaseModel):
    questions: list[_InterviewQuestion] = Field(default_factory=list)
    ask_back_questions: list[str] = Field(default_factory=list)


class _LinkedinParagraph(BaseModel):
    text: str
    source_experience_ids: list[str] = Field(default_factory=list)


class _LinkedinSummaryStructure(BaseModel):
    hook: str
    body_paragraphs: list[_LinkedinParagraph] = Field(default_factory=list)
    call_to_action: str


_STRUCTURED_SCHEMAS: dict[str, type[BaseModel]] = {
    "cover_letter": _CoverLetterStructure,
    "self_intro": _SelfIntroStructure,
    "match_report": _MatchReportStructure,
    "interview_prep": _InterviewPrepStructure,
    "linkedin_summary": _LinkedinSummaryStructure,
}


# ── 3. Prompts ────────────────────────────────────────────────────────────────


_ARTIFACT_TYPE_INSTRUCTIONS: dict[str, str] = {
    "cover_letter": (
        "You are writing a cover letter. Return `_CoverLetterStructure` JSON with:\n"
        "- `recipient`: greeting line (e.g. \"尊敬的招聘经理\") or null if the JD names one — do NOT invent a hiring manager name.\n"
        "- `opening`: 1–2 sentence hook that connects the candidate's background to the role.\n"
        "- `body_paragraphs`: 2–4 paragraphs, each grounded in ONE or TWO source experiences. Set `source_experience_ids` to the ids of those experiences.\n"
        "- `closing`: 1–2 sentence call to action.\n"
        "- `signature`: the candidate's name from the profile if provided, else null. NEVER write \"[您的姓名]\" or any placeholder.\n"
        "Target 300–450 characters total in the body_paragraphs combined."
    ),
    "self_intro": (
        "You are writing a concise professional self-introduction (elevator pitch). Return `_SelfIntroStructure` JSON with:\n"
        "- `sentences`: 4–6 short sentences. Each sentence covers one of: identity → recent role/experience → key achievement → skill fit → aspiration.\n"
        "For every sentence citing an experience or metric, list the `source_experience_ids` it draws from.\n"
        "Total length ≤ 250 characters."
    ),
    "match_report": (
        "You are auditing candidate–JD fit. Return `_MatchReportStructure` JSON with:\n"
        "- `requirements`: ONE entry per JD requirement provided. For each, set `requirement_id` and `requirement_text` VERBATIM from the input list. Set `match_level` to \"strong\", \"partial\", or \"missing\" based on evidence in source experiences.\n"
        "- For `match_level=\"strong\"` or `\"partial\"`, populate `evidence_experience_ids` (ids that support the match) and `evidence_snippets` (short verbatim substrings from those experiences' content that back the claim).\n"
        "- `recommendation`: one actionable sentence per requirement (e.g. \"补充 Spark 项目细节\").\n"
        "- `overall_score`: 0–100 integer reflecting the weighted average match.\n"
        "- `actionable_suggestions`: 3 top-priority items the candidate should act on next."
    ),
    "interview_prep": (
        "You are preparing interview material. Return `_InterviewPrepStructure` JSON with:\n"
        "- `questions`: 5 likely interview questions grounded in the JD requirements and the candidate's actual experiences.\n"
        "- For each question, provide a `star_answer` (situation/task/action/result) using ONLY facts from source experiences the candidate actually has. If you cannot form STAR from source, replace the missing field with the literal string \"⟨源材料未覆盖，需候选人补充⟩\" — do NOT invent numbers, systems, results, or team activities.\n"
        "- Set `source_experience_ids` on each question to the ids the STAR is grounded in.\n"
        "- `ask_back_questions`: 3 thoughtful questions the candidate should ask the interviewer, tied to the JD."
    ),
    "linkedin_summary": (
        "You are writing a LinkedIn 'About' section (first person). Return `_LinkedinSummaryStructure` JSON with:\n"
        "- `hook`: 1 sentence opening (NO fabricated origin stories; do NOT open with \"从第一次...\" unless the source experiences describe such a moment).\n"
        "- `body_paragraphs`: 2–3 paragraphs summarising expertise, using ONLY skills/domains that appear in source experiences. Set `source_experience_ids` on each paragraph.\n"
        "- `call_to_action`: 1 sentence stating what the person is open to.\n"
        "Total length ≤ 500 characters."
    ),
}


_DRAFT_GROUNDING = """You produce professional job-application artifacts.

## Absolute rules (grounding)

1. Every DATE, ORGANIZATION name, ROLE, TECHNOLOGY name (e.g. Python, Spark, Hive, Hadoop), and QUANTITATIVE claim (numbers, percentages, counts, sizes) MUST appear verbatim in the "Source experiences" block. If a fact is not there, either omit it or explicitly mark unknown (see per-type rules).
2. Do NOT re-format dates. Do NOT invent tools the candidate has not used. If Spark appears in exactly ONE experience, do NOT write "熟悉 Spark" or "精通 Spark" as a general skill claim — describe it in that experience's context.
3. Do NOT invent metrics or achievements not present in source. Do NOT write vivid origin stories or scenes that aren't in source content.
4. Preserve organization/product names EXACTLY (e.g. "WEEX国际交易所有限公司").
5. Do not upgrade descriptors ("参与" → "主导", "熟悉" → "精通") beyond what the source states.
6. When the profile has a `name`, use it in the signature. NEVER emit placeholders like "[您的姓名]" or "[Your Name]".

## Language

{lang}
"""


_FACT_CHECK_SYSTEM_PROMPT = """You are a strict fact-checker for a job-application artifact.

Compare the DRAFT (structured JSON) against SOURCE experiences and the candidate PROFILE. Flag every case where the DRAFT contains a specific date, organization name, role, quantitative claim (number/percentage/count/size), or technology name that does NOT appear verbatim in the SOURCE for the same experience or in the PROFILE.

Normalise date formats (2024.04 == 2024-04 == 2024年4月).

DO flag:
- Any date year/month/day change.
- Any org name substitution.
- Any role substitution or upgrade beyond source ("参与" → "主导").
- Any number/percentage/size that is not in source.
- Any technology named in general skill claims but only touching source in one specific experience (or absent entirely). Example: writing "熟悉 Hive" or "精通 Spark" when Hive does not appear in any source and Spark appears only within one project's tech stack.
- Any fabricated origin story or scene ("从第一次用 SQL 清洗 50 万行..." when no such moment exists in source).
- Placeholder tokens like "[您的姓名]", "[Your Name]".

Do NOT flag: rewording, restructuring, translation of connectives, or well-known synonyms.

Return an empty list if the draft is clean."""


# ── 4. Draft Generation (structured) ──────────────────────────────────────────


async def artifact_draft_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Generate structured artifact content and derive markdown."""
    provider = get_provider()

    raw_artifact_type = state.get("artifact_type") or state.get("extracted_params", {}).get(
        "artifact_type", "other"
    )
    artifact_type = str(raw_artifact_type or "other")
    intent = str(state.get("intent_description") or "")
    artifact_config = get_config(artifact_type)

    jd_text = state.get("assembled_jd_text") or ""
    jd_requirements = state.get("jd_requirements") or []
    experiences = state.get("assembled_experiences") or []
    profile = state.get("assembled_user_profile") or {}
    prefs = state.get("assembled_preferences") or []
    guidelines = state.get("assembled_guideline_instructions") or []
    fact_mismatches = state.get("artifact_fact_mismatches") or []
    revision_instruction = state.get("artifact_revision_instruction")

    lang = profile.get("preferred_language", "zh-CN") if profile else "zh-CN"
    lang_instruction = (
        "Write in Chinese (Simplified) unless a specific field must remain in its original language (e.g. English tech terms)."
        if "zh" in lang
        else "Write in English."
    )

    # Build the user prompt
    prompt_parts: list[str] = [f"Task: {intent or ('生成 ' + artifact_type)}"]
    prompt_parts.append(_ARTIFACT_TYPE_INSTRUCTIONS.get(artifact_type, "Generate the requested document as JSON."))
    if profile:
        prompt_parts.append(_format_profile_for_prompt(profile))
    if jd_text:
        prompt_parts.append(f"Job Description:\n{jd_text}")
    if jd_requirements:
        req_lines = [
            f"- id={r.get('id') or f'req-{i+1}'}: {r.get('text', '')}"
            for i, r in enumerate(jd_requirements)
            if isinstance(r, dict)
        ]
        prompt_parts.append(
            "JD requirements (use these ids verbatim in `requirement_id`/`matched_jd_requirement_ids`):\n"
            + "\n".join(req_lines)
        )
    if experiences:
        prompt_parts.append(
            "Source experiences (THE ONLY GROUND TRUTH — every date, organization, role, "
            "metric, and technology in your output must come from this block):\n"
            + _format_experiences_for_prompt(experiences)
        )
    if prefs:
        pref_rules = "\n".join(f"- {p.get('rule')}" for p in prefs[:8])
        prompt_parts.append(f"Writing preferences:\n{pref_rules}")
    if guidelines:
        prompt_parts.append("Writing guidelines:\n" + "\n".join(f"- {g}" for g in guidelines[:5]))
    if fact_mismatches:
        prompt_parts.append(
            "Previous draft had the following factual errors — you MUST correct every one of them:\n"
            + "\n".join("- " + _format_mismatch_issue(m) for m in fact_mismatches if isinstance(m, dict))
        )
    if revision_instruction:
        prompt_parts.append(f"Additional revision instruction: {revision_instruction}")

    schema_cls = _STRUCTURED_SCHEMAS.get(artifact_type)

    title = _artifact_title(artifact_type, intent)
    structured: dict[str, object] | None = None
    content_str: str

    if schema_cls is not None:
        llm_output = await provider.chat_structured(
            [
                {"role": "system", "content": _DRAFT_GROUNDING.format(lang=lang_instruction)},
                {"role": "user", "content": "\n\n".join(prompt_parts)},
            ],
            schema_cls,
            temperature=0.2,
        )
        structured = _assign_artifact_ids(artifact_type, llm_output)
        content_str = _render_artifact_to_markdown(artifact_type, structured, title=title)
    else:
        # Fallback for "other" type: keep the free-form chat interface.
        content = await provider.chat(
            [
                {"role": "system", "content": _DRAFT_GROUNDING.format(lang=lang_instruction)},
                {"role": "user", "content": "\n\n".join(prompt_parts)},
            ],
            temperature=0.2,
            max_tokens=artifact_config.max_tokens,
        )
        content_str = str(content)

    return {
        "artifact_type": artifact_type,
        "artifact_content": content_str,
        "artifact_structured": structured,
        "artifact_title": title,
    }


async def artifact_persist_node(
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Persist the final, verified artifact to DB and emit SSE events.

    Runs after the fact_check / self_review / revision loop settles. Called
    exactly once per generation (regardless of how many revision iterations
    ran), so there is exactly one artifact row per user request.
    """
    artifact_type = str(state.get("artifact_type") or "other")
    content_str = str(state.get("artifact_content") or "")
    structured = state.get("artifact_structured")
    title = str(state.get("artifact_title") or _artifact_title(artifact_type, ""))
    experiences = state.get("assembled_experiences") or []
    word_count = len(content_str.split())

    source_experience_ids = _collect_source_experience_ids(structured) or [
        e.get("id") for e in experiences if e.get("id")
    ]

    services = services_from_config(config)
    real_artifact_id = f"artifact-temp-{artifact_type}"
    try:
        if services is None:
            raise RuntimeError("Tool services unavailable")
        user_id = state.get("user_id", "")
        artifact = await services.artifact.create_artifact(
            user_id,
            {
                "type": artifact_type,
                "title": title,
                "content": content_str,
                "structured": structured,
                "thread_id": thread_id_from_config(config),
                "source_jd_id": state.get("workspace", {}).get("jd_id"),
                "source_experience_ids": source_experience_ids,
            },
        )
        real_artifact_id = artifact.id
    except Exception as exc:
        logger.warning("Artifact archive persistence failed: %s", exc)

    workspace = dict(state.get("workspace", {}))
    if not real_artifact_id.startswith("artifact-temp-"):
        workspace["artifact_id"] = real_artifact_id

    existing_events = state.get("pending_sse_events", [])

    if artifact_type in _CANVAS_ARTIFACT_TYPES:
        started_event: ArtifactStartedEvent = {
            "event": "artifact.started",
            "artifact_type": artifact_type,
            "title": title,
        }
        delta_event: ArtifactDeltaEvent = {"event": "artifact.delta", "content": content_str}
        completed_event: ArtifactCompletedEvent = {
            "event": "artifact.completed",
            "artifact_id": real_artifact_id,
            "title": title,
            "word_count": word_count,
        }
        return {
            "assistant_message": (
                f"I've created your {artifact_type.replace('_', ' ')}. "
                "You can view and edit it in the artifact panel."
            ),
            "workspace": workspace,
            "pending_sse_events": [*existing_events, started_event, delta_event, completed_event],
        }

    return {
        "assistant_message": content_str,
        "workspace": workspace,
        "pending_sse_events": existing_events,
    }


async def generate_verified_artifact(
    state: MainState,
    config: RunnableConfig | None = None,
    *,
    max_iterations: int | None = None,
) -> dict[str, object]:
    """Run one complete verified artifact generation inline.

    Sequence per call: draft → fact_check → coverage_check → self_review;
    loops back to draft if the review flags mismatches, up to `max_iterations`
    (defaults to `settings.max_self_review_iterations`, typically 3). Finally
    persists exactly once. Returns the merged state delta that callers can
    fold into their own state.

    This is the same execution the standalone artifact subgraph performs,
    packaged for reuse by `generate_application_artifacts_node` so the
    application_package flow gets identical quality guards.
    """
    limit = max_iterations if max_iterations is not None else getattr(
        settings, "max_self_review_iterations", 3
    )
    working: dict = dict(state)
    working.setdefault("artifact_review_iteration", 0)
    working.setdefault("artifact_fact_mismatches", [])
    working.setdefault("artifact_revision_instruction", None)

    while True:
        working.update(await artifact_draft_node(cast(MainState, working), config))
        working.update(await artifact_fact_check_node(cast(MainState, working)))
        cc_delta = await artifact_coverage_check_node(cast(MainState, working))
        if cc_delta:
            working.update(cc_delta)
        working.update(await artifact_self_review_node(cast(MainState, working)))

        review = working.get("artifact_review_result") or {}
        iteration = int(working.get("artifact_review_iteration") or 0)
        if review.get("verdict") != "needs_revision" or iteration >= limit:
            break
        working["artifact_review_iteration"] = iteration + 1

    working.update(await artifact_persist_node(cast(MainState, working), config))
    return working


# ── 5. Fact Check ─────────────────────────────────────────────────────────────


class _FactMismatch(BaseModel):
    field: Literal[
        "date", "organization", "role", "metric", "technology", "title",
        "achievement", "placeholder", "other",
    ]
    drafted_value: str
    source_value: str | None = None
    experience_title: str = ""
    detail: str | None = None


class _FactCheckResult(BaseModel):
    mismatches: list[_FactMismatch] = Field(default_factory=list)


async def artifact_fact_check_node(state: MainState) -> dict[str, object]:
    """Verify the drafted artifact only uses facts present in source experiences / profile."""
    structured = state.get("artifact_structured")
    content = state.get("artifact_content") or ""
    experiences = state.get("assembled_experiences") or []
    profile = state.get("assembled_user_profile") or {}
    if not experiences:
        return {"artifact_fact_mismatches": []}

    if isinstance(structured, dict) and structured:
        draft_block = (
            "DRAFT (structured JSON):\n"
            + _json.dumps(structured, ensure_ascii=False, indent=2)
        )
    elif isinstance(content, str) and content.strip():
        draft_block = "DRAFT (markdown):\n" + content
    else:
        return {"artifact_fact_mismatches": []}

    provider = get_provider()
    result: _FactCheckResult = await provider.chat_structured(
        [
            {"role": "system", "content": _FACT_CHECK_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "PROFILE:\n"
                    + _json.dumps(profile, ensure_ascii=False)
                    + "\n\nSOURCE experiences:\n"
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
    return {"artifact_fact_mismatches": mismatches}


# ── 6. Coverage Check (interview_prep only) ───────────────────────────────────


async def artifact_coverage_check_node(state: MainState) -> dict[str, object]:
    """For interview_prep, verify each JD requirement is tagged by ≥1 question.

    Other types skip this node's real work. Coverage gaps are exposed via a
    `coverage_gap` marker on the returned artifact_structured (advisory only —
    not a hard-fail).
    """
    artifact_type = state.get("artifact_type") or ""
    if artifact_type != "interview_prep":
        return {}

    structured = state.get("artifact_structured")
    jd_requirements = state.get("jd_requirements") or []
    if not isinstance(structured, dict) or not jd_requirements:
        return {}

    questions = structured.get("questions") or []
    valid_ids: dict[str, str] = {
        (str(r.get("id")) if isinstance(r, dict) and r.get("id") else f"req-{i+1}"): str(
            r.get("text", "") if isinstance(r, dict) else ""
        )
        for i, r in enumerate(jd_requirements)
    }
    coverage: dict[str, int] = {rid: 0 for rid in valid_ids}
    for q in questions:
        if not isinstance(q, dict):
            continue
        for rid in q.get("matched_jd_requirement_ids") or []:
            rid_str = str(rid)
            if rid_str in coverage:
                coverage[rid_str] += 1

    uncovered = [rid for rid, count in coverage.items() if count == 0]
    updated_structured = dict(structured)
    updated_structured["coverage_report"] = {
        "requirements": [
            {"requirement_id": rid, "requirement_text": valid_ids[rid], "question_count": count}
            for rid, count in coverage.items()
        ],
        "covered_count": sum(1 for c in coverage.values() if c > 0),
        "total_count": len(valid_ids),
    }
    updated_structured["uncovered_jd_requirement_ids"] = uncovered
    return {"artifact_structured": updated_structured}


# ── 7. Self Review ────────────────────────────────────────────────────────────


async def artifact_self_review_node(state: MainState) -> dict[str, object]:
    """Hard-fail on any fact mismatch; force revision. Bounded by review_iteration."""
    iteration = state.get("artifact_review_iteration", 0)
    max_iters = getattr(settings, "max_self_review_iterations", 3)
    if iteration >= max_iters:
        return {
            "artifact_review_result": {
                "verdict": "pass",
                "issues": [],
                "note": "max iterations reached; accepting current draft",
            }
        }

    mismatches = state.get("artifact_fact_mismatches") or []
    if not mismatches:
        return {"artifact_review_result": {"verdict": "pass", "issues": []}}

    issues = [_format_mismatch_issue(m) for m in mismatches if isinstance(m, dict)]
    instruction = (
        "Fix every factual mismatch listed. Use only facts (dates, organizations, roles, "
        "metrics, technologies, achievements) that appear verbatim in the source experiences "
        "or the candidate profile. Do not invent alternatives. Do not upgrade descriptors."
    )
    return {
        "artifact_review_result": {
            "verdict": "needs_revision",
            "issues": issues,
            "revision_instruction": instruction,
        },
        "artifact_revision_instruction": instruction,
    }


# ── 8. Revision ───────────────────────────────────────────────────────────────


async def artifact_revision_node(state: MainState) -> dict[str, object]:
    review = state.get("artifact_review_result") or {}
    instruction = review.get("revision_instruction") or state.get("artifact_revision_instruction")
    if not instruction:
        return {}
    current_iter = state.get("artifact_review_iteration", 0)
    return {
        "artifact_review_iteration": current_iter + 1,
        "artifact_revision_instruction": instruction,
    }


def artifact_review_route(state: MainState) -> str:
    review = state.get("artifact_review_result") or {}
    iteration = state.get("artifact_review_iteration", 0)
    max_iters = getattr(settings, "max_self_review_iterations", 3)
    if review.get("verdict") == "needs_revision" and iteration < max_iters:
        return "revision"
    return "end"


# ── Helpers: prompt formatting ────────────────────────────────────────────────


def _format_profile_for_prompt(profile: dict[str, object]) -> str:
    fields = ("full_name", "name", "email", "phone", "location", "current_title", "career_stage")
    lines = ["Candidate profile:"]
    for key in fields:
        value = profile.get(key)
        if value:
            lines.append(f"  {key}: {value}")
    if len(lines) == 1:
        return "Candidate profile: (not provided; do not fabricate name/contact fields)"
    return "\n".join(lines)


def _format_experiences_for_prompt(experiences: list[dict[str, object]]) -> str:
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
            f"  start_date: {start_date if start_date else '(unknown)'}",
            f"  end_date: {end_date if end_date else '(unknown)'}",
        ]
        if tags:
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
    detail = m.get("detail")
    core = f'{m.get("field")}: drafted "{m.get("drafted_value")}" but {src_part}'
    if exp:
        core = f"{core} ({exp})"
    if detail:
        core = f"{core} — {detail}"
    return core


# ── Helpers: structured → markdown ────────────────────────────────────────────


def _assign_artifact_ids(artifact_type: str, llm: BaseModel) -> dict[str, object]:
    """Attach stable UUIDs to structured artifact parts and return a plain dict."""
    data = llm.model_dump()
    if artifact_type == "cover_letter":
        for p in data.get("body_paragraphs") or []:
            p["id"] = f"para-{uuid.uuid4()}"
    elif artifact_type == "self_intro":
        for s in data.get("sentences") or []:
            s["id"] = f"sent-{uuid.uuid4()}"
    elif artifact_type == "match_report":
        for r in data.get("requirements") or []:
            r["id"] = f"req-{uuid.uuid4()}"
    elif artifact_type == "interview_prep":
        for q in data.get("questions") or []:
            q["id"] = f"q-{uuid.uuid4()}"
    elif artifact_type == "linkedin_summary":
        for p in data.get("body_paragraphs") or []:
            p["id"] = f"para-{uuid.uuid4()}"
    return data


def _collect_source_experience_ids(structured: dict[str, object] | None) -> list[str]:
    if not isinstance(structured, dict):
        return []
    ids: list[str] = []
    seen: set[str] = set()

    def _absorb(container: object) -> None:
        if not isinstance(container, dict):
            return
        for k, v in container.items():
            if k == "source_experience_ids" and isinstance(v, list):
                for x in v:
                    if isinstance(x, str) and x and x not in seen:
                        seen.add(x)
                        ids.append(x)
            elif k == "evidence_experience_ids" and isinstance(v, list):
                for x in v:
                    if isinstance(x, str) and x and x not in seen:
                        seen.add(x)
                        ids.append(x)
            elif isinstance(v, dict):
                _absorb(v)
            elif isinstance(v, list):
                for item in v:
                    _absorb(item)

    _absorb(structured)
    return ids


def _render_artifact_to_markdown(
    artifact_type: str, structured: dict[str, object], title: str = ""
) -> str:
    if artifact_type == "cover_letter":
        return _render_cover_letter(structured, title)
    if artifact_type == "self_intro":
        return _render_self_intro(structured, title)
    if artifact_type == "match_report":
        return _render_match_report(structured, title)
    if artifact_type == "interview_prep":
        return _render_interview_prep(structured, title)
    if artifact_type == "linkedin_summary":
        return _render_linkedin_summary(structured, title)
    return _json.dumps(structured, ensure_ascii=False, indent=2)


def _render_cover_letter(s: dict[str, object], title: str) -> str:
    lines: list[str] = [f"# {title or 'Cover Letter'}", ""]
    recipient = s.get("recipient")
    if recipient:
        lines.append(str(recipient))
        lines.append("")
    opening = s.get("opening")
    if opening:
        lines.append(str(opening))
        lines.append("")
    for p in s.get("body_paragraphs") or []:
        if isinstance(p, dict) and p.get("text"):
            lines.append(str(p["text"]))
            lines.append("")
    closing = s.get("closing")
    if closing:
        lines.append(str(closing))
        lines.append("")
    signature = s.get("signature")
    if signature:
        lines.append(str(signature))
    return "\n".join(lines).rstrip() + "\n"


def _render_self_intro(s: dict[str, object], title: str) -> str:
    lines: list[str] = [f"# {title or 'Self Introduction'}", ""]
    texts = [
        str(sen["text"])
        for sen in (s.get("sentences") or [])
        if isinstance(sen, dict) and sen.get("text")
    ]
    lines.append("".join(texts) if texts else "")
    return "\n".join(lines).rstrip() + "\n"


def _render_match_report(s: dict[str, object], title: str) -> str:
    lines: list[str] = [f"# {title or 'JD Match Report'}", ""]
    lines.append(f"**Overall Match Score:** {s.get('overall_score', 0)} / 100")
    lines.append("")
    lines.append("| Requirement | Match | Evidence | Recommendation |")
    lines.append("|---|---|---|---|")
    for r in s.get("requirements") or []:
        if not isinstance(r, dict):
            continue
        req_text = str(r.get("requirement_text", "")).replace("|", "\\|")
        level_raw = r.get("match_level") or "missing"
        badge = {"strong": "✅ Strong", "partial": "⚠️ Partial", "missing": "❌ Missing"}.get(
            str(level_raw), str(level_raw)
        )
        snippets = "; ".join(
            str(x).replace("|", "\\|") for x in (r.get("evidence_snippets") or []) if x
        ) or "—"
        recommendation = str(r.get("recommendation", "")).replace("|", "\\|") or "—"
        lines.append(f"| {req_text} | {badge} | {snippets} | {recommendation} |")
    suggestions = s.get("actionable_suggestions") or []
    if suggestions:
        lines.append("")
        lines.append("## Top Actionable Suggestions")
        lines.append("")
        for sug in suggestions:
            lines.append(f"- {sug}")
    return "\n".join(lines).rstrip() + "\n"


def _render_interview_prep(s: dict[str, object], title: str) -> str:
    lines: list[str] = [f"# {title or 'Interview Preparation'}", ""]
    for i, q in enumerate(s.get("questions") or [], start=1):
        if not isinstance(q, dict):
            continue
        lines.append(f"## Q{i}. {q.get('question', '')}")
        lines.append("")
        star = q.get("star_answer") or {}
        if isinstance(star, dict):
            for label, key in (
                ("Situation", "situation"),
                ("Task", "task"),
                ("Action", "action"),
                ("Result", "result"),
            ):
                v = star.get(key)
                if v:
                    lines.append(f"- **{label}**: {v}")
        lines.append("")
    ask_back = s.get("ask_back_questions") or []
    if ask_back:
        lines.append("## Questions to ask the interviewer")
        lines.append("")
        for aq in ask_back:
            lines.append(f"- {aq}")
    uncovered = s.get("uncovered_jd_requirement_ids") or []
    if uncovered:
        lines.append("")
        lines.append(
            "> ⚠️ Coverage gap — the following JD requirement(s) have no matching question: "
            + ", ".join(str(x) for x in uncovered)
        )
    return "\n".join(lines).rstrip() + "\n"


def _render_linkedin_summary(s: dict[str, object], title: str) -> str:
    lines: list[str] = [f"# {title or 'LinkedIn Summary'}", ""]
    hook = s.get("hook")
    if hook:
        lines.append(str(hook))
        lines.append("")
    for p in s.get("body_paragraphs") or []:
        if isinstance(p, dict) and p.get("text"):
            lines.append(str(p["text"]))
            lines.append("")
    cta = s.get("call_to_action")
    if cta:
        lines.append(str(cta))
    return "\n".join(lines).rstrip() + "\n"


def _artifact_title(artifact_type: str, intent: str) -> str:
    titles = {
        "cover_letter": "Cover Letter",
        "self_intro": "Self Introduction",
        "match_report": "JD Match Report",
        "interview_prep": "Interview Preparation",
        "linkedin_summary": "LinkedIn Summary",
    }
    return titles.get(artifact_type, intent[:50] or "Document")
