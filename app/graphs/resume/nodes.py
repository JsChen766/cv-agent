"""
Resume Generation subgraph nodes.

Flow:
  context_assembly → cot_planning → draft_generation →
  self_review → [revision → self_review (max 3)] → interrupt_output
"""

import uuid
from collections.abc import Mapping
from typing import cast

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field, JsonValue

from app.core.config import settings
from app.core.events import (
    AgentInterruptEvent,
    ContentDiffCompletedEvent,
    ContentDiffDeltaEvent,
    ContentDiffStartedEvent,
)
from app.domain.resume.models import ResumeVariantCreate
from app.graphs.resume.state import ResumeGenerationState
from app.graphs.runtime import pool_from_config, services_from_config
from app.providers.factory import get_provider
from app.tools.actions import capabilities as action_capabilities
from app.tools.actions.models import VariantInput

# ── 1. Context Assembly ───────────────────────────────────────────────────────


async def context_assembly_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Gather all context needed for resume generation."""
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
            "jd_text": ctx.jd_text,
            "relevant_experiences": ctx.experiences,
            "guideline_instructions": ctx.guideline_instructions,
            "user_preferences": ctx.preferences,
            "user_profile": ctx.user_profile,
            "evidence_pack": ctx.evidence_pack.model_dump() if ctx.evidence_pack else None,
        }
    except RuntimeError:
        # Pool not available (test mode)
        return {}


# ── 2. CoT Planning ───────────────────────────────────────────────────────────


class MatchingPlan(BaseModel):
    strategy: str
    key_experiences_to_highlight: list[str]
    skills_to_emphasize: list[str]
    tone: str = "professional"
    structure_suggestions: list[str] = Field(default_factory=list)


async def cot_planning_node(state: ResumeGenerationState) -> dict[str, object]:
    """Chain-of-thought planning before generation."""
    provider = get_provider()

    jd_text = state.get("jd_text") or state.get("assembled_jd_text", "")
    experiences = state.get("relevant_experiences") or state.get("assembled_experiences", [])
    prefs = state.get("user_preferences") or state.get("assembled_preferences", [])
    profile = state.get("user_profile") or state.get("assembled_user_profile")
    intent = state.get("intent_description", "Generate a tailored resume")

    context_parts = [f"Intent: {intent}"]
    if jd_text:
        context_parts.append(f"JD Summary:\n{jd_text[:1500]}")
    if profile:
        context_parts.append(
            f"User: {profile.get('current_title', '')} | {profile.get('career_stage', '')}"
        )
    if experiences:
        exp_list = "\n".join(
            f"- {e.get('title')} at {e.get('organization', 'N/A')}" for e in experiences[:6]
        )
        context_parts.append(f"Available Experiences:\n{exp_list}")
    if prefs:
        pref_list = "\n".join(f"- {p.get('rule')}" for p in prefs[:5])
        context_parts.append(f"User Preferences:\n{pref_list}")

    plan: MatchingPlan = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "You are a senior resume strategist. Based on the job requirements and "
                    "available experiences, create a strategic plan for resume generation.\n"
                    "Think step by step about:\n"
                    "1. Which experiences best match the JD requirements\n"
                    "2. What skills to emphasize\n"
                    "3. The overall tone and structure"
                ),
            },
            {"role": "user", "content": "\n\n".join(context_parts)},
        ],
        MatchingPlan,
        temperature=0.3,
    )

    return {
        "matching_plan": plan.model_dump() if plan else None,
        "generation_strategy": plan.strategy if plan else "standard",
    }


# ── 3. Draft Generation ───────────────────────────────────────────────────────


async def draft_generation_node(state: ResumeGenerationState) -> dict[str, object]:
    """Generate resume variant(s) and emit diff events."""
    provider = get_provider()

    intent = state.get("intent_description", "Generate a tailored resume")
    jd_text = state.get("jd_text") or ""
    experiences = state.get("relevant_experiences") or []
    prefs = state.get("user_preferences") or []
    plan = state.get("matching_plan") or {}
    profile = state.get("user_profile") or {}
    evidence_pack = state.get("evidence_pack") or {}
    revision_instruction = state.get("revision_instruction")

    # Build generation prompt
    prompt_parts = [f"Task: {intent}"]
    if jd_text:
        prompt_parts.append(f"Job Description:\n{jd_text[:2000]}")
    if plan:
        prompt_parts.append(
            f"Strategy: {plan.get('strategy', '')}\n"
            f"Key experiences to highlight: {', '.join(plan.get('key_experiences_to_highlight', []))}\n"
            f"Skills to emphasize: {', '.join(plan.get('skills_to_emphasize', []))}"
        )
    if experiences:
        exp_texts = []
        for e in experiences[:5]:
            exp_texts.append(
                f"**{e.get('title')}** at {e.get('organization', '')}\n{e.get('content', '')[:600]}"
            )
        prompt_parts.append("Experiences to use:\n" + "\n\n".join(exp_texts))
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
            claim_texts = [
                str(claim.get("text"))
                for claim in claims
                if isinstance(claim, dict) and claim.get("text")
            ] if isinstance(claims, list) else []
            evidence_lines.append(
                f"- {match.get('requirement_text', '')}: {'; '.join(claim_texts)}"
            )
        if evidence_lines:
            prompt_parts.append(
                "Verified evidence mapping (use only these claims for matching assertions):\n"
                + "\n".join(evidence_lines)
            )
    if revision_instruction:
        prompt_parts.append(f"Revision instruction: {revision_instruction}")

    preferred_lang = profile.get("preferred_language", "zh-CN")
    lang_instruction = (
        "Respond in Chinese (Simplified)." if "zh" in preferred_lang else "Respond in English."
    )

    # Emit diff started event
    resume_id = state.get("workspace", {}).get("resume_id") or "new"
    diff_started: ContentDiffStartedEvent = {
        "event": "content.diff.started",
        "resume_id": resume_id,
        "section": "all",
    }

    # Generate content (non-streaming for now; streaming wired in Phase 12)
    content = await provider.chat(
        [
            {
                "role": "system",
                "content": (
                    f"You are an expert resume writer. {lang_instruction}\n"
                    "Generate a complete, tailored resume in Markdown format. "
                    "Include: Summary, Experience, Skills, Education sections. "
                    "Make every bullet point specific, quantified where possible, "
                    "and directly relevant to the job requirements. Never invent metrics, "
                    "employers, dates, technologies, or achievements that are absent from "
                    "the supplied experience evidence."
                ),
            },
            {"role": "user", "content": "\n\n".join(prompt_parts)},
        ],
        temperature=0.6,
        max_tokens=3000,
    )
    content_str = str(content)

    # Emit diff delta event (simplified: treat entire content as insertion)
    diff_delta: ContentDiffDeltaEvent = {
        "event": "content.diff.delta",
        "operations": [{"op": "insert", "text": content_str}],
    }
    diff_completed: ContentDiffCompletedEvent = {
        "event": "content.diff.completed",
        "resume_id": resume_id,
        "total_insertions": len(content_str.split()),
        "total_deletions": 0,
    }

    variant_id = f"variant-{uuid.uuid4()}"
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
        "title": "AI Generated Variant",
        "content": content_str,
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
    existing_events = state.get("pending_sse_events", [])
    return {
        "variants": [variant],
        "current_diff": [{"op": "insert", "text": content_str}],
        "pending_sse_events": [*existing_events, diff_started, diff_delta, diff_completed],
    }


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


# ── 4. Self Review ────────────────────────────────────────────────────────────


class ReviewResult(BaseModel):
    verdict: str  # "pass" | "needs_revision"
    revision_instruction: str | None = None
    issues: list[str] = Field(default_factory=list)
    score_estimate: float = 0.7


async def self_review_node(state: ResumeGenerationState) -> dict[str, object]:
    """Review generated variants for quality. Max 3 iterations."""
    iteration = state.get("review_iteration", 0)
    if iteration >= settings.max_self_review_iterations:
        return {"review_result": {"verdict": "pass", "issues": [], "score_estimate": 0.7}}

    variants = state.get("variants", [])
    if not variants:
        return {"review_result": {"verdict": "pass", "issues": []}}

    content = variants[0].get("content", "")
    jd_text = state.get("jd_text") or ""

    provider = get_provider()
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
    services = services_from_config(config)
    if services is None:
        return {}

    workspace = dict(state.get("workspace", {}))
    resume_id_value = workspace.get("resume_id")
    resume_id = resume_id_value if isinstance(resume_id_value, str) else None
    jd_id_value = workspace.get("jd_id")
    jd_id = jd_id_value if isinstance(jd_id_value, str) else None
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
        saved = await services.resume.save_variant(
            resume_id,
            ResumeVariantCreate.model_validate(
                {
                    "jd_id": jd_id,
                    "title": title if isinstance(title, str) and title else "AI Generated Variant",
                    "content": content if isinstance(content, str) else "",
                    "score": variant.get("score", {}),
                    "evidence_summary": variant.get("evidence_summary", []),
                    "risk_summary": variant.get("risk_summary", []),
                    "missing_info": variant.get("missing_info", []),
                }
            ),
        )
        saved_variants.append(saved.model_dump(mode="json"))

    return {"workspace": workspace, "variants": saved_variants}


async def output_node(
    state: ResumeGenerationState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Prepare interrupt payload and halt graph for user review."""
    from langgraph.types import interrupt

    variants = state.get("variants", [])
    services = services_from_config(config)
    workspace = dict(state.get("workspace", {}))
    interrupt_id = str(uuid.uuid4())

    interrupt_event: AgentInterruptEvent = {
        "event": "agent.interrupt",
        "interrupt_id": interrupt_id,
        "type": "resume_review",
        "message": f"I've generated {len(variants)} resume variant(s). Please review and choose one to accept, or provide feedback.",
        "variants": [
            {
                "id": v.get("id", ""),
                "title": v.get("title", ""),
                "score": v.get("score", {}),
            }
            for v in variants
        ],
        "candidates": [],
        "action_options": [
            {
                "id": "accept",
                "label": "Accept",
                "description": "Accept the variant and save to resume",
            },
            {"id": "revise", "label": "Revise", "description": "Request changes"},
            {"id": "discard", "label": "Discard", "description": "Discard and start over"},
        ],
    }

    existing_events = state.get("pending_sse_events", [])

    payload = {
        "interrupt_id": interrupt_id,
        "type": "resume_review",
        "message": interrupt_event["message"],
        "variants": variants,
        "action_options": interrupt_event["action_options"],
        "workspace": workspace,
    }

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
    selected_variant_id = None
    if isinstance(resume_value, dict):
        action = resume_value.get("action") or resume_value.get("decision")
        selected = resume_value.get("selected_variant_id") or resume_value.get("variant_id")
        selected_variant_id = selected if isinstance(selected, str) else None
    if action in {"accept", "confirm"}:
        valid_variant_ids = {
            variant.get("id") for variant in variants if isinstance(variant.get("id"), str)
        }
        if selected_variant_id not in valid_variant_ids:
            raise ValueError("Selected resume variant does not belong to this review")
        assert selected_variant_id is not None
        if services is None:
            raise RuntimeError("Resume service unavailable while accepting variant")
        accepted = await action_capabilities.accept_variant(
            services,
            state.get("user_id", ""),
            VariantInput(variantId=selected_variant_id),
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
        "pending_sse_events": [*existing_events, interrupt_event],
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
    """After self_review: go to revision or output."""
    review = state.get("review_result") or {}
    iteration = state.get("review_iteration", 0)

    if (
        review.get("verdict") == "needs_revision"
        and iteration < settings.max_self_review_iterations
    ):
        return "revision"
    return "output"


def output_route(state: ResumeGenerationState) -> str:
    return "revision" if state.get("resume_user_action") == "revise" else "end"
