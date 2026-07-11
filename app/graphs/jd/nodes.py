"""JD subgraph nodes."""

import uuid
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.types import interrupt

from app.domain.jd.models import JdRequirementDraft, JdRequirementImportance
from app.graphs.jd.state import JdState
from app.graphs.runtime import services_from_config
from app.providers.factory import get_provider


async def extract_jd_node(state: JdState) -> dict[str, Any]:
    """Extract title/company/target_role from user message. Does NOT persist."""
    from pydantic import BaseModel

    messages = state.get("messages", [])
    extracted = state.get("extracted_params", {})

    raw_text_value = extracted.get("raw_text") or extracted.get("jd_text")
    raw_text = raw_text_value if isinstance(raw_text_value, str) else None
    title_value = extracted.get("title") or extracted.get("jd_title")
    title = title_value if isinstance(title_value, str) else None
    company_value = extracted.get("company")
    company = company_value if isinstance(company_value, str) else None
    target_role_value = extracted.get("target_role")
    target_role = target_role_value if isinstance(target_role_value, str) else None

    if not raw_text:
        user_msgs = [m for m in messages if m["role"] == "user"]
        if user_msgs:
            raw_text = user_msgs[-1]["content"]
            title = title or "Job Description"

    if not raw_text:
        return {
            "assistant_message": "I couldn't find a JD to save. Please paste the job description."
        }

    provider = get_provider()

    class JdInfo(BaseModel):
        title: str
        company: str | None = None
        target_role: str | None = None

    jd_info = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": "Extract the job title, company name, and target role from this job description. If not present, return None.",
            },
            {"role": "user", "content": raw_text[:3000]},
        ],
        JdInfo,
        temperature=0.1,
    )

    return {
        "extracted_params": {
            **extracted,
            "raw_text": raw_text,
            "title": jd_info.title if jd_info else (title or "Job Description"),
            "company": jd_info.company if jd_info else company,
            "target_role": jd_info.target_role if jd_info else target_role,
        }
    }


async def parse_requirements_node(
    state: JdState, config: RunnableConfig | None = None
) -> dict[str, Any]:
    """Parse JD requirements from raw text. Stores in extracted_params; does NOT persist."""
    from pydantic import BaseModel

    extracted = state.get("extracted_params", {})
    raw_text_value = extracted.get("raw_text", "")
    raw_text = raw_text_value if isinstance(raw_text_value, str) else ""
    if not raw_text:
        return {}

    provider = get_provider()

    class Requirement(BaseModel):
        text: str
        category: str = "skill"
        importance: str = "medium"

    class RequirementList(BaseModel):
        requirements: list[Requirement]

    result = await provider.chat_structured(
        [
            {
                "role": "system",
                "content": (
                    "Extract job requirements from this JD. For each requirement:\n"
                    "- text: the requirement statement\n"
                    "- category: 'must_have', 'nice_to_have', 'skill', or 'experience'\n"
                    "- importance: 'high', 'medium', or 'low'"
                ),
            },
            {"role": "user", "content": raw_text[:4000]},
        ],
        RequirementList,
        temperature=0.1,
    )

    reqs: list[dict[str, str]] = []
    if result:
        reqs = [
            {
                "id": str(uuid.uuid4()),
                "text": r.text,
                "category": r.category,
                "importance": r.importance,
            }
            for r in result.requirements
        ]

    return {
        "extracted_params": {**extracted, "requirements": reqs},
    }


async def jd_confirm_node(state: JdState) -> dict[str, Any]:
    """Interrupt to ask the user whether to save the extracted JD."""
    from app.core.events import AgentInterruptEvent

    extracted = state.get("extracted_params", {})

    title_value = extracted.get("title")
    company_value = extracted.get("company")
    target_role_value = extracted.get("target_role")
    raw_text_value = extracted.get("raw_text", "")
    reqs_value = extracted.get("requirements", [])

    candidate: dict[str, Any] = {
        "title": title_value if isinstance(title_value, str) else "Job Description",
        "company": company_value if isinstance(company_value, str) else None,
        "target_role": target_role_value if isinstance(target_role_value, str) else None,
        "raw_text": raw_text_value if isinstance(raw_text_value, str) else "",
        "requirements": reqs_value if isinstance(reqs_value, list) else [],
    }

    interrupt_payload: AgentInterruptEvent = {
        "event": "agent.interrupt",
        "interrupt_id": str(uuid.uuid4()),
        "type": "jd_save",
        "message": "检测到一条 JD，是否加入匹配记录？",
        "candidate": candidate,
        "action_options": [
            {"id": "confirm", "label": "加入", "description": "保存到 JD 匹配记录"},
            {"id": "discard", "label": "忽略", "description": "不保存"},
        ],
    }

    existing = state.get("pending_sse_events", [])
    new_state: dict[str, Any] = {
        "interrupt_payload": interrupt_payload,
        "pending_sse_events": [*existing, dict(interrupt_payload)],
    }

    resume_value = interrupt(interrupt_payload)

    # User discarded or a new chat message preempted this interrupt.
    if isinstance(resume_value, dict) and resume_value.get("action") in ("preempted", "discard"):
        return {
            **new_state,
            "interrupt_payload": None,
            "jd_confirmed": False,
            "jd_candidate": candidate,
        }

    # Confirmation interrupts throughout the product use action-option ids
    # (for example, {"action": "confirm"}).  Some clients submit only an
    # edited candidate on resume; that is also an affirmative JD save.  An
    # explicit rejection must always win over every affirmative shorthand.
    confirmed = False
    merged_candidate = candidate
    if isinstance(resume_value, dict):
        action = resume_value.get("action") or resume_value.get("decision")
        explicitly_rejected = resume_value.get("confirmed") is False or action in {
            "preempted",
            "discard",
        }
        confirmed = not explicitly_rejected and (
            resume_value.get("confirmed") is True
            or action in {"confirm", "accept", "save"}
            or isinstance(resume_value.get("candidate"), dict)
        )
        if "candidate" in resume_value and isinstance(resume_value["candidate"], dict):
            merged_candidate = {**candidate, **resume_value["candidate"]}

    return {
        **new_state,
        "interrupt_payload": None,
        "jd_confirmed": confirmed,
        "jd_candidate": merged_candidate,
    }


async def jd_persist_node(state: JdState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Persist JD if confirmed; update assistant_message and workspace."""
    confirmed = state.get("jd_confirmed", False)
    candidate: dict[str, Any] = state.get("jd_candidate") or {}  # type: ignore[assignment]
    extracted = state.get("extracted_params", {})
    existing = state.get("pending_sse_events", [])

    if not confirmed:
        completed_event = {
            "event": "agent.completed",
            "message": "已忽略该 JD。",
            "data": {},
        }
        return {
            "assistant_message": "已忽略该 JD。",
            "pending_sse_events": [*existing, completed_event],
            "jd_confirmed": None,
            "jd_candidate": None,
        }

    services = services_from_config(config)
    if services is None:
        completed_event = {
            "event": "agent.completed",
            "message": "JD 服务不可用，无法保存。",
            "data": {},
        }
        return {
            "assistant_message": "JD 服务不可用，无法保存。",
            "pending_sse_events": [*existing, completed_event],
            "jd_confirmed": None,
            "jd_candidate": None,
        }

    reqs_raw = candidate.get("requirements") or []
    reqs: list[JdRequirementDraft] = []
    if isinstance(reqs_raw, list):
        reqs = [
            JdRequirementDraft(
                id=r.get("id") if isinstance(r, dict) else None,
                text=str(r.get("text", "")) if isinstance(r, dict) else str(r),
                category=str(r.get("category", "skill")) if isinstance(r, dict) else "skill",
                importance=_normalize_importance(
                    str(r.get("importance", "medium")) if isinstance(r, dict) else "medium"
                ),
            )
            for r in reqs_raw
            if r
        ]

    title = str(candidate.get("title") or "Job Description")
    thread_id_value = state.get("thread_id")
    source_thread_id = thread_id_value if isinstance(thread_id_value, str) else None

    jd = await services.jd.create_jd(
        state.get("user_id", ""),
        title=title,
        raw_text=str(candidate.get("raw_text") or ""),
        company=str(candidate["company"]) if candidate.get("company") else None,
        target_role=str(candidate["target_role"]) if candidate.get("target_role") else None,
        requirements=reqs,
        source_thread_id=source_thread_id,
    )

    workspace = dict(state.get("workspace", {}))
    workspace["jd_id"] = jd.id

    completed_event = {
        "event": "agent.completed",
        "message": f"已加入 JD 匹配记录：{jd.title}",
        "data": {"jd_id": jd.id, "requirements_count": len(jd.requirements)},
    }

    return {
        "assistant_message": f"已加入 JD 匹配记录：{jd.title}",
        "workspace": workspace,
        "extracted_params": {
            **extracted,
            "requirements": [r.model_dump() for r in jd.requirements],
        },
        "pending_sse_events": [*existing, completed_event],
        "jd_confirmed": None,
        "jd_candidate": None,
    }


def _normalize_importance(value: str) -> JdRequirementImportance:
    if value == "high":
        return "high"
    if value == "low":
        return "low"
    return "medium"
