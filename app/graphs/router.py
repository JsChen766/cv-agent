"""
Router Node.

A lightweight one-shot structured LLM call that analyses the user's
latest message + thread context and decides which subgraph to invoke.
"""

from __future__ import annotations

from typing import Literal, cast

from pydantic import BaseModel, Field, JsonValue

from app.core.events import AgentRouteCompletedEvent
from app.graphs.state import MainState
from app.providers.factory import get_provider


class RouterOutput(BaseModel):
    target_subgraph: Literal[
        "experience_import", "jd", "resume_generation", "artifact", "open_ended"
    ]
    intent_description: str
    artifact_type: str | None = None
    context_hints: list[str] = Field(default_factory=list)
    extracted_params: dict[str, JsonValue] = Field(default_factory=dict)
    confidence: float = 0.8


_ROUTER_SYSTEM = """You are a routing agent for a resume assistant application.

Analyse the user's message and determine which subgraph should handle it:

- "experience_import": User wants to add/import work experiences, paste resume content, or upload a file with experiences.
- "jd": User wants to save, manage, or discuss a job description.
- "resume_generation": User wants to generate, improve, or modify their resume.
- "artifact": User wants to create a cover letter, self-introduction, LinkedIn summary, match report, interview prep, or any other document artifact.
- "open_ended": General questions, career advice, follow-up questions, or anything that doesn't fit the above.

Also extract:
- intent_description: a clear 1-sentence description of what the user wants (used as generation prompt)
- artifact_type: if target is "artifact", one of: cover_letter, self_intro, match_report, interview_prep, linkedin_summary, other
- context_hints: list of context elements needed (e.g. ["active_jd", "experiences", "profile"])
- extracted_params: any structured params extracted (e.g. {"jd_id": "...", "target_role": "..."})
- confidence: your confidence in this routing decision (0.0-1.0)

If confidence < 0.6, use "open_ended".
"""


async def router_node(state: MainState) -> dict[str, object]:
    """Determine target subgraph from latest user message."""
    preset_target = state.get("target_subgraph")
    preset_intent = state.get("intent_description")
    if preset_target and preset_intent:
        preset_route_event: AgentRouteCompletedEvent = {
            "event": "agent.route.completed",
            "target": preset_target,
            "intent_description": preset_intent,
            "confidence": 1.0,
        }
        existing_events = state.get("pending_sse_events", [])
        return {
            "target_subgraph": preset_target,
            "intent_description": preset_intent,
            "artifact_type": state.get("artifact_type"),
            "context_hints": state.get("context_hints", []),
            "extracted_params": state.get("extracted_params", {}),
            "router_confidence": 1.0,
            "pending_sse_events": [*existing_events, preset_route_event],
        }

    messages = state.get("messages", [])
    if not messages:
        return {"target_subgraph": "open_ended", "intent_description": "", "router_confidence": 0.5}

    # Build context summary for router
    workspace = state.get("workspace", {})
    context_parts = []
    if workspace.get("jd_id"):
        context_parts.append(f"Active JD: {workspace['jd_id']}")
    if workspace.get("resume_id"):
        context_parts.append(f"Active Resume: {workspace['resume_id']}")
    rolling_summary = state.get("rolling_summary")
    if rolling_summary:
        context_parts.append(f"Conversation summary: {rolling_summary}")

    # Last few messages for context
    recent = messages[-4:] if len(messages) > 4 else messages
    history = "\n".join(f"{m['role'].upper()}: {m['content'][:200]}" for m in recent)

    context_str = "\n".join(context_parts) if context_parts else "No active context."
    user_msg = messages[-1]["content"] if messages[-1]["role"] == "user" else ""
    existing_extracted = cast("dict[str, JsonValue]", state.get("extracted_params", {}))
    heuristic = _heuristic_route(user_msg, existing_extracted)
    if heuristic is not None:
        route_event: AgentRouteCompletedEvent = {
            "event": "agent.route.completed",
            "target": heuristic.target_subgraph,
            "intent_description": heuristic.intent_description,
            "confidence": heuristic.confidence,
        }
        existing_events = state.get("pending_sse_events", [])
        return {
            "target_subgraph": heuristic.target_subgraph,
            "intent_description": heuristic.intent_description,
            "artifact_type": heuristic.artifact_type,
            "context_hints": heuristic.context_hints,
            "extracted_params": heuristic.extracted_params,
            "router_confidence": heuristic.confidence,
            "pending_sse_events": [*existing_events, route_event],
        }

    provider = get_provider()
    routing: RouterOutput = await provider.chat_structured(
        [
            {"role": "system", "content": _ROUTER_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"Current context:\n{context_str}\n\n"
                    f"Recent conversation:\n{history}\n\n"
                    f"Latest user message: {user_msg}"
                ),
            },
        ],
        RouterOutput,
        temperature=0.1,
    )

    # Emit routing event
    llm_route_event: AgentRouteCompletedEvent = {
        "event": "agent.route.completed",
        "target": routing.target_subgraph,
        "intent_description": routing.intent_description,
        "confidence": routing.confidence,
    }
    existing_events = state.get("pending_sse_events", [])

    return {
        "target_subgraph": routing.target_subgraph,
        "intent_description": routing.intent_description,
        "artifact_type": routing.artifact_type,
        "context_hints": routing.context_hints,
        "extracted_params": _merge_existing_raw_text(
            routing.target_subgraph,
            routing.extracted_params,
            existing_extracted,
        ),
        "router_confidence": routing.confidence,
        "pending_sse_events": [*existing_events, llm_route_event],
    }


def route_decision(state: MainState) -> str:
    """Conditional edge: returns the target subgraph name."""
    return state.get("target_subgraph") or "open_ended"


def _heuristic_route(
    user_msg: str,
    existing_extracted: dict[str, JsonValue] | None = None,
) -> RouterOutput | None:
    text = user_msg.strip()
    if not text:
        return None
    lower = text.lower()

    save_terms = (
        "保存",
        "存一下",
        "存下来",
        "存下",
        "记录",
        "新增",
        "添加",
        "导入",
        "帮我存",
        "save",
        "add",
        "import",
    )
    has_save_intent = any(term in lower for term in save_terms)

    experience_terms = (
        "项目经历",
        "工作经历",
        "实习经历",
        "教育经历",
        "经历",
        "负责",
        "担任",
        "任职",
        "做过",
        "参与",
        "experience",
    )
    jd_terms = (
        "jd",
        "职位描述",
        "岗位描述",
        "岗位",
        "招聘要求",
        "职位要求",
        "职位",
        "岗位要求",
        "job description",
    )
    not_jd_terms = ("不是jd", "不是 jd", "不是岗位", "不是职位描述", "但不是jd")
    not_experience_terms = ("不是我的经历", "别把这个当我的经历", "不是经历")
    resume_terms = ("简历", "resume", "cv")

    if (
        has_save_intent
        and any(term in lower for term in jd_terms)
        and not any(term in lower for term in not_jd_terms)
    ):
        return RouterOutput(
            target_subgraph="jd",
            intent_description="Save the pasted job description and extract requirements.",
            context_hints=["active_jd"],
            extracted_params=_merge_existing_raw_text(
                "jd",
                {"raw_text": text},
                existing_extracted,
            ),
            confidence=0.95,
        )

    if (
        has_save_intent
        and any(term in lower for term in experience_terms)
        and not any(term in lower for term in not_experience_terms)
    ):
        return RouterOutput(
            target_subgraph="experience_import",
            intent_description="Save the user's pasted experience content into the experience library.",
            context_hints=["profile"],
            extracted_params=_merge_existing_raw_text(
                "experience_import",
                {"raw_text": text},
                existing_extracted,
            ),
            confidence=0.95,
        )

    artifact_map = {
        "自我介绍": "self_intro",
        "self intro": "self_intro",
        "self-intro": "self_intro",
        "cover letter": "cover_letter",
        "求职信": "cover_letter",
        "匹配报告": "match_report",
        "match report": "match_report",
        "面试准备": "interview_prep",
        "interview prep": "interview_prep",
        "linkedin": "linkedin_summary",
    }
    for term, artifact_type in artifact_map.items():
        if term in lower:
            return RouterOutput(
                target_subgraph="artifact",
                intent_description=f"Generate a {artifact_type} artifact.",
                artifact_type=artifact_type,
                context_hints=["active_jd", "experiences"],
                extracted_params={},
                confidence=0.9,
            )

    generation_terms = ("生成", "写", "优化", "修改", "改", "润色", "generate", "rewrite", "improve")
    if any(term in lower for term in resume_terms) and any(term in lower for term in generation_terms):
        return RouterOutput(
            target_subgraph="resume_generation",
            intent_description="Generate or improve resume content.",
            context_hints=["active_jd", "active_resume", "experiences"],
            extracted_params={},
            confidence=0.9,
        )

    return None


def _merge_existing_raw_text(
    target_subgraph: str,
    route_params: dict[str, JsonValue],
    existing_extracted: dict[str, JsonValue] | None,
) -> dict[str, JsonValue]:
    if target_subgraph not in {"experience_import", "jd"}:
        return route_params
    if not existing_extracted:
        return route_params
    raw_text = existing_extracted.get("raw_text")
    if not isinstance(raw_text, str) or not raw_text.strip():
        return route_params
    merged = {**route_params, **existing_extracted}
    merged["raw_text"] = raw_text
    return merged
