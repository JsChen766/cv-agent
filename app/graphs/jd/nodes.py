"""JD subgraph nodes."""

import uuid
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.types import interrupt

from app.domain.jd.models import (
    JdRequirementDraft,
    JdRequirementImportance,
    JdRequirementV2Category,
)
from app.domain.jd.requirement_map.models import Requirement, RequirementImportance
from app.domain.jd.service import requirements_fingerprint
from app.graphs.jd.state import JdState
from app.graphs.runtime import services_from_config
from app.graphs.streaming import emit_thinking, get_optional_stream_writer


async def extract_jd_node(state: JdState) -> dict[str, Any]:
    """Locate the complete JD text without invoking a provider."""
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

    return {
        "extracted_params": {
            **extracted,
            "raw_text": raw_text,
            "title": title or "Job Description",
            "company": company,
            "target_role": target_role,
        }
    }


async def parse_requirements_node(
    state: JdState, config: RunnableConfig | None = None
) -> dict[str, Any]:
    """Resolve the cached RequirementMap or perform one structured parse."""
    extracted = state.get("extracted_params", {})
    raw_text_value = extracted.get("raw_text", "")
    raw_text = raw_text_value if isinstance(raw_text_value, str) else ""
    if not raw_text:
        return {}

    writer = get_optional_stream_writer()
    if writer is not None:
        emit_thinking(writer, "正在提取并整理岗位要求…")

    services = services_from_config(config)
    if services is None:
        return {
            "assistant_message": "JD 服务不可用，无法解析岗位要求。",
        }
    resolution = await services.jd.analyze_raw_text(state.get("user_id", ""), raw_text)
    requirement_map = resolution.requirement_map
    reqs = [_legacy_requirement(item) for item in requirement_map.requirements]
    if writer is not None:
        cache_note = "（已复用缓存）" if resolution.cache_hit else ""
        emit_thinking(writer, f"已整理 {len(reqs)} 条岗位要求{cache_note}，准备确认…")

    return {
        "extracted_params": {
            **extracted,
            "title": requirement_map.title or extracted.get("title") or "Job Description",
            "company": requirement_map.company or extracted.get("company"),
            "target_role": requirement_map.target_role or extracted.get("target_role"),
            "requirements": reqs,
            "jd_hash": requirement_map.jd_hash,
            "requirement_map_id": requirement_map.requirement_map_id,
            "requirements_fingerprint": requirements_fingerprint(reqs),
        },
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
        "jd_hash": extracted.get("jd_hash"),
        "requirement_map_id": extracted.get("requirement_map_id"),
        "requirements_fingerprint": extracted.get("requirements_fingerprint"),
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
    raw_candidate = state.get("jd_candidate")
    candidate: dict[str, Any] = dict(raw_candidate) if isinstance(raw_candidate, dict) else {}
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
                keywords=tuple(str(value) for value in r.get("keywords") or [])
                if isinstance(r, dict)
                else (),
                weight=_optional_weight(r.get("weight")) if isinstance(r, dict) else None,
                v2_importance=_normalize_v2_importance(r.get("v2_importance"))
                if isinstance(r, dict)
                else None,
                v2_category=_normalize_v2_category(r.get("v2_category"))
                if isinstance(r, dict)
                else None,
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
        jd_hash=str(candidate["jd_hash"]) if candidate.get("jd_hash") else None,
        requirement_map_id=(
            str(candidate["requirement_map_id"]) if candidate.get("requirement_map_id") else None
        ),
        requirements_origin=(
            "parsed"
            if candidate.get("requirements_fingerprint")
            == requirements_fingerprint([item.model_dump(mode="json") for item in reqs])
            else "manual"
        ),
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


def _normalize_v2_importance(value: object) -> RequirementImportance | None:
    if value in {"must_have", "preferred", "optional"}:
        if value == "must_have":
            return "must_have"
        if value == "optional":
            return "optional"
        return "preferred"
    return None


def _optional_weight(value: object) -> float | None:
    if isinstance(value, int | float) and 0.0 <= float(value) <= 1.0:
        return float(value)
    return None


def _normalize_v2_category(value: object) -> JdRequirementV2Category | None:
    if value == "qualification":
        return "qualification"
    if value == "responsibility":
        return "responsibility"
    if value == "technology":
        return "technology"
    if value == "domain":
        return "domain"
    if value == "soft_skill":
        return "soft_skill"
    return None


def _legacy_requirement(requirement: Requirement) -> dict[str, Any]:
    if requirement.importance == "must_have":
        importance = "high"
    elif requirement.importance == "optional":
        importance = "low"
    else:
        importance = "medium"
    category = {
        "qualification": "experience",
        "responsibility": "experience",
        "technology": "skill",
        "domain": "domain",
        "soft_skill": "skill",
    }[requirement.category]
    return {
        "id": requirement.requirement_id,
        "text": requirement.description,
        "category": category,
        "importance": importance,
        "keywords": list(requirement.keywords),
        "weight": requirement.weight,
        "v2_importance": requirement.importance,
        "v2_category": requirement.category,
    }
