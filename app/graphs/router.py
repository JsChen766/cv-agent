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

ArtifactRouteType = Literal[
    "cover_letter",
    "self_intro",
    "match_report",
    "interview_prep",
    "linkedin_summary",
    "other",
]


_RESUME_TERMS = ("简历", "resume", "cv")
_RESUME_GENERATION_TERMS = (
    "生成",
    "写",
    "优化",
    "修改",
    "改",
    "润色",
    "generate",
    "rewrite",
    "improve",
)


class RouterOutput(BaseModel):
    target_subgraph: Literal[
        "experience_import",
        "jd",
        "resume_generation",
        "application_package",
        "artifact",
        "open_ended",
        "clarify",
        "edit_resume",
    ]
    intent_description: str
    artifact_type: ArtifactRouteType | None = None
    context_hints: list[str] = Field(default_factory=list)
    extracted_params: dict[str, JsonValue] = Field(default_factory=dict)
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)


def _looks_like_resume_request(text: str) -> bool:
    """Return whether the latest message explicitly asks to create/edit a resume."""
    normalized = text.lower().strip()
    # Users commonly put the instruction either before or after a long pasted
    # JD. Inspect both boundaries so the JD body cannot push an explicit resume
    # request out of the routing window.
    instruction_scope = (
        normalized
        if len(normalized) <= 480
        else f"{normalized[:240]}\n{normalized[-240:]}"
    )
    return (
        any(term in instruction_scope for term in _RESUME_TERMS)
        and any(term in instruction_scope for term in _RESUME_GENERATION_TERMS)
    )


_ROUTER_SYSTEM = """You are a routing agent for a resume assistant application.

Analyse the user's LATEST message and determine which subgraph should handle it.
The latest message is authoritative because the user can switch topics at any time. Use prior turns
only to resolve references or elliptical follow-ups such as "make that English"; never let prior intent
override an explicit new request.

Routing options:
- "experience_import": User wants to add/import work experiences, paste resume content, or upload a file with experiences.
- "jd": User wants to add, save, or import a job description into their JD library.
- "resume_generation": User wants to generate, improve, or modify their resume.
- "application_package": User wants a resume from a JD plus every supported submission
  material required by that JD, all in the same turn.
- "artifact": User wants to create a cover letter, self-introduction, LinkedIn summary, match report, interview prep, or any other document artifact.
- "open_ended": General questions, career advice, follow-up questions, or anything that doesn't clearly fit the above.
- "clarify": The user's intent is ambiguous — you cannot confidently determine what they want. Use this to ask for clarification.
- "edit_resume": User wants to make a local or global edit to an EXISTING resume. Trigger conditions: workspace has resume_id AND the user message contains edit intent (改/换/删/加/侧重/缩短/精简/更正式/更详细, etc.). Only route to edit_resume when workspace has resume_id; otherwise route to resume_generation.

Rules:
- Always route based on the CURRENT message, not what previous turns did.
- workspace context (jd_id, resume_id) is just reference — it does NOT force a routing decision.
- Use "clarify" when confidence < 0.55 and the message doesn't fit any clear category.
- Use "open_ended" for confidence 0.55–0.70 fuzzy matches.
- Questions about existing records (for example "list my JDs" or "what experience do I have?")
  belong to "open_ended", whose agent can call read tools. The "jd" subgraph is an ingestion flow.
- Do not route a bare instruction such as "save a JD" to an ingestion subgraph unless the current
  message actually contains the JD content; use "clarify" to ask for it.

Also extract:
- intent_description: a clear 1-sentence description of what the user wants (used as generation prompt)
- artifact_type: if target is "artifact", one of: cover_letter, self_intro, match_report, interview_prep, linkedin_summary, other
- context_hints: list of context elements needed (e.g. ["active_jd", "experiences", "profile"])
- extracted_params: any structured params extracted (e.g. {"jd_id": "...", "target_role": "..."})
- confidence: your confidence in this routing decision (0.0-1.0)

Important routing guidance:
- "open_ended" has full tool access: it CAN list/read experiences, JDs, and resumes.
  Route there for Q&A, analysis, and exploration tasks even if they involve user data.
- Only route to "resume_generation" or "application_package" when the user explicitly
  wants to CREATE or OVERWRITE resume content, not just discuss it.
- "根据我的经历分析" → open_ended (tool-calling agent will handle)
- "帮我生成一份简历" → resume_generation or application_package
- workspace.resume_id 非空 + 编辑词汇 → "edit_resume" (higher priority than resume_generation)
- "把简历改得更精简" with resume_id → edit_resume
- "帮我生成一份简历" without resume_id → resume_generation (not edit_resume)
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
            "edit_instruction": (
                preset_intent if preset_target == "edit_resume" else None
            ),
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
    upload_route = _uploaded_file_import_route(existing_extracted)
    if upload_route is not None:
        upload_route_event: AgentRouteCompletedEvent = {
            "event": "agent.route.completed",
            "target": upload_route.target_subgraph,
            "intent_description": upload_route.intent_description,
            "confidence": upload_route.confidence,
        }
        existing_events = state.get("pending_sse_events", [])
        return {
            "target_subgraph": upload_route.target_subgraph,
            "intent_description": upload_route.intent_description,
            "artifact_type": upload_route.artifact_type,
            "context_hints": upload_route.context_hints,
            "extracted_params": upload_route.extracted_params,
            "router_confidence": upload_route.confidence,
            "pending_sse_events": [*existing_events, upload_route_event],
        }

    heuristic = _heuristic_route(
        user_msg,
        existing_extracted,
        has_active_jd=bool(workspace.get("jd_id")),
        has_active_resume=bool(workspace.get("resume_id")),
    )
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
            "edit_instruction": (
                heuristic.intent_description
                if heuristic.target_subgraph == "edit_resume"
                else None
            ),
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
    routing = _normalize_llm_routing(routing)

    # The latest user message is authoritative. If it explicitly asks for a
    # resume, an LLM that labels the JD source material as a JD-ingestion task
    # must not send the user into the save-JD confirmation flow.
    has_resume_hint = state.get("routing_hint") == "resume_generation"
    if (has_resume_hint or _looks_like_resume_request(user_msg)) and routing.target_subgraph in {
        "jd",
        "clarify",
        "open_ended",
    }:
        routing = routing.model_copy(
            update={
                "target_subgraph": "resume_generation",
                "intent_description": "Generate or improve resume content.",
                "context_hints": ["active_jd", "active_resume", "experiences"],
                "confidence": max(routing.confidence, 0.95),
            }
        )

    # Inject raw_jd_text into extracted_params for resume targets when the user
    # message appears to contain inline JD content but the LLM didn't extract it.
    # This mirrors the heuristic-path logic so jd_id always gets persisted to snapshot.
    llm_extracted = _merge_existing_raw_text(
        routing.target_subgraph,
        routing.extracted_params,
        existing_extracted,
    )
    if (
        routing.target_subgraph in {"application_package", "resume_generation"}
        and not workspace.get("jd_id")
        and "raw_jd_text" not in llm_extracted
        and len(user_msg) >= 80
    ):
        jd_terms_llm = (
            "jd", "职位描述", "岗位描述", "岗位", "招聘要求",
            "职位要求", "职位", "岗位要求", "job description",
        )
        if any(term in user_msg.lower() for term in jd_terms_llm):
            llm_extracted = {**llm_extracted, "raw_jd_text": user_msg}

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
        "extracted_params": llm_extracted,
        "router_confidence": routing.confidence,
        "edit_instruction": (
            routing.intent_description
            if routing.target_subgraph == "edit_resume"
            else None
        ),
        "pending_sse_events": [*existing_events, llm_route_event],
    }


def route_decision(state: MainState) -> str:
    """Conditional edge: returns the target subgraph name."""
    target = state.get("target_subgraph") or "open_ended"
    valid = {
        "experience_import",
        "jd",
        "resume_generation",
        "application_package",
        "artifact",
        "open_ended",
        "clarify",
        "edit_resume",
    }
    return target if target in valid else "open_ended"


def _normalize_llm_routing(routing: RouterOutput) -> RouterOutput:
    """Make confidence thresholds deterministic instead of prompt-only advice."""
    if routing.confidence < 0.55 and routing.target_subgraph != "clarify":
        return routing.model_copy(update={"target_subgraph": "clarify"})
    if (
        routing.confidence < 0.70
        and routing.target_subgraph not in {"clarify", "open_ended"}
    ):
        return routing.model_copy(update={"target_subgraph": "open_ended"})
    return routing


def _heuristic_route(
    user_msg: str,
    existing_extracted: dict[str, JsonValue] | None = None,
    *,
    has_active_jd: bool = False,
    has_active_resume: bool = False,
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
    # Detect an explicit resume request before ingestion routes. A JD/岗位 is
    # often mentioned as the source material for the resume, not as a record
    # the user wants to save. This signal must be available before the JD save
    # branch below so generation cannot be swallowed by the ingestion flow.
    requests_resume = _looks_like_resume_request(text)

    if (
        has_save_intent
        and not requests_resume
        and any(term in lower for term in jd_terms)
        and not any(term in lower for term in not_jd_terms)
    ):
        if not _has_substantive_payload(lower, (*save_terms, *jd_terms)):
            return RouterOutput(
                target_subgraph="clarify",
                intent_description="Ask the user to provide the job description they want to save.",
                confidence=0.95,
            )
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
        and not requests_resume
        and any(term in lower for term in experience_terms)
        and not any(term in lower for term in not_experience_terms)
    ):
        if not _has_substantive_payload(lower, (*save_terms, *experience_terms)):
            return RouterOutput(
                target_subgraph="clarify",
                intent_description="Ask the user to provide the experience content they want to save.",
                confidence=0.95,
            )
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

    looks_like_pasted_jd = len(text) >= 300 and any(term in lower for term in jd_terms)
    has_application_package_hint = any(
        term in lower
        for term in (
            "自我介绍",
            "self intro",
            "self-intro",
            "求职信",
            "cover letter",
            "邮件主题",
            "邮件正文",
            "附件名",
            "附件命名",
            "投递要求",
            "调研",
            "research",
        )
    )

    # Edit intent takes priority when there's an active resume in workspace.
    edit_terms = (
        "改一下", "修改", "改成", "改得", "改为", "更改",
        "换成", "替换", "删掉", "删除", "去掉",
        "加一条", "再加", "新增一条", "补充",
        "侧重", "强调", "突出",
        "缩短", "精简", "压缩", "砍到",
        "更正式", "更详细", "更简洁", "更专业",
        "整体语气", "全部改",
    )
    has_edit_intent = any(term in lower for term in edit_terms)
    if has_edit_intent and has_active_resume:
        return RouterOutput(
            target_subgraph="edit_resume",
            intent_description=text,
            context_hints=["active_resume"],
            extracted_params={},
            confidence=0.92,
        )

    if requests_resume:
        target: Literal["application_package", "resume_generation"] = (
            "application_package"
            if looks_like_pasted_jd or has_application_package_hint
            else "resume_generation"
        )
        params: dict[str, JsonValue] = {}
        # Capture inline JD text for persist_resume_draft_node to promote to jd_records.
        # Applies to both targets — short JDs (<300 chars) route to resume_generation but
        # still need raw_jd_text so jd_id gets persisted to the snapshot.
        if not has_active_jd and any(term in lower for term in jd_terms) and len(text) >= 80:
            params["raw_jd_text"] = text
        return RouterOutput(
            target_subgraph=target,
            intent_description="Generate a complete application package tailored to the JD."
            if target == "application_package"
            else "Generate or improve resume content.",
            context_hints=["active_jd", "active_resume", "experiences"],
            extracted_params=params,
            confidence=0.95,
        )

    experience_qa_terms = (
        "根据我的经历",
        "从我的经历",
        "基于我的经历",
        "我的背景",
        "我的工作经历",
        "我的项目经历",
        "经历库",
        "我有哪些经历",
        "我的经历有哪些",
        "analyse my experience",
        "analyze my experience",
        "based on my experience",
        "from my experience library",
    )
    if any(term in lower for term in experience_qa_terms):
        return RouterOutput(
            target_subgraph="open_ended",
            intent_description=(
                "Answer a question or provide analysis based on user's "
                "experience library. Use list_experiences and get_experience tools."
            ),
            context_hints=["experiences", "active_jd"],
            confidence=0.92,
        )

    artifact_map: dict[str, ArtifactRouteType] = {
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

    return None


def _has_substantive_payload(text: str, instruction_terms: tuple[str, ...]) -> bool:
    payload = text
    for term in sorted(instruction_terms, key=len, reverse=True):
        payload = payload.replace(term, " ")
    payload = "".join(character for character in payload if character.isalnum())
    return len(payload) >= 8


def _uploaded_file_import_route(
    existing_extracted: dict[str, JsonValue],
) -> RouterOutput | None:
    raw_text = existing_extracted.get("raw_text")
    source = existing_extracted.get("source")
    file_id = existing_extracted.get("file_id") or existing_extracted.get("uploaded_file_id")
    if (
        source != "uploaded_file"
        or not isinstance(raw_text, str)
        or not raw_text.strip()
        or not isinstance(file_id, str)
        or not file_id
    ):
        return None
    return RouterOutput(
        target_subgraph="experience_import",
        intent_description="Import experience candidates from the uploaded resume file.",
        context_hints=["uploaded_resume", "profile"],
        extracted_params=existing_extracted,
        confidence=0.98,
    )


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
