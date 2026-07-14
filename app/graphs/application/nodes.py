import logging
import re
from typing import Literal, cast

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field

from app.graphs.application.state import ApplicationPackageState
from app.graphs.artifact.nodes import artifact_draft_node
from app.graphs.state import MainState
from app.providers.factory import get_provider

logger = logging.getLogger(__name__)

SupportedArtifactType = Literal[
    "self_intro",
    "cover_letter",
    "match_report",
    "interview_prep",
    "linkedin_summary",
    "other",
]

_SUPPORTED_ARTIFACT_TYPES = {
    "self_intro",
    "cover_letter",
    "match_report",
    "interview_prep",
    "linkedin_summary",
    "other",
}


class PlannedApplicationRequirement(BaseModel):
    artifact_type: SupportedArtifactType = "other"
    title: str
    requirement_text: str
    instruction: str
    supported: bool = True
    reason: str | None = None
    order: int = Field(default=1, ge=1)


class ApplicationRequirementPlan(BaseModel):
    requirements: list[PlannedApplicationRequirement] = Field(default_factory=list)


def _latest_user_message(state: ApplicationPackageState) -> str:
    messages = state.get("messages", [])
    for message in reversed(messages):
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            return message["content"]
    return ""


def _deterministic_requirements(text: str) -> list[dict[str, object]]:
    """Guarantee common submission deliverables even if structured extraction misses them."""
    lower = text.lower()
    requirements: list[dict[str, object]] = []
    if re.search(r"自我介绍|self[ -]?intro(?:duction)?", lower):
        length_match = re.search(
            r"(?:约|大约|不超过|控制在)?\s*(\d{2,4})\s*字.{0,16}自我介绍|"
            r"自我介绍.{0,16}(?:约|大约|不超过|控制在)?\s*(\d{2,4})\s*字",
            text,
        )
        length = (
            next((group for group in length_match.groups() if group), None)
            if length_match
            else None
        )
        length_instruction = f"控制在约{length}个中文字符" if length else "遵守 JD 中的字数限制"
        requirements.append(
            {
                "artifact_type": "self_intro",
                "title": "JD 要求的自我介绍",
                "requirement_text": "JD 要求提交自我介绍",
                "instruction": (
                    f"根据 JD 中的投递要求生成中文自我介绍，{length_instruction}，"
                    "并严格遵守其他内容和格式限制。"
                ),
                "supported": True,
                "reason": None,
                "order": 1,
            }
        )
    if re.search(r"求职信|cover letter", lower):
        requirements.append(
            {
                "artifact_type": "cover_letter",
                "title": "JD 要求的求职信",
                "requirement_text": "JD 要求提交求职信",
                "instruction": "根据 JD 和候选人经历生成符合投递要求的求职信。",
                "supported": True,
                "reason": None,
                "order": len(requirements) + 1,
            }
        )

    naming_match = re.search(r"邮件主题|邮件正文|附件名|附件命名|命名附件", text)
    if naming_match:
        requirements.append(
            {
                "artifact_type": "other",
                "title": "邮件与附件命名",
                "requirement_text": "JD 包含邮件主题、正文或附件命名要求",
                "instruction": (
                    "提取 JD 中的邮件主题、邮件正文和附件命名规则，生成可直接使用的模板；"
                    "未知的姓名、学校、年级、到岗时间等信息使用清晰占位符，不得编造；"
                    "只输出必要模板和简短说明，整体控制在300个中文字符以内。"
                ),
                "supported": True,
                "reason": None,
                "order": len(requirements) + 1,
            }
        )

    research_match = re.search(
        r"(?:另请|并请|请|需要|需).{0,20}(?:调研|研究|搜索|查找|核实).{0,40}",
        text,
    )
    if research_match:
        requirements.append(
            {
                "artifact_type": "other",
                "title": "外部研究要求",
                "requirement_text": research_match.group(0).strip(),
                "instruction": research_match.group(0).strip(),
                "supported": False,
                "reason": "当前 Agent 不具备外部检索、研究或事实核验能力",
                "order": len(requirements) + 1,
            }
        )

    if re.search(r"(?:发送|投递).{0,24}(?:邮箱|邮件|@)", text):
        requirements.append(
            {
                "artifact_type": "other",
                "title": "实际发送或投递",
                "requirement_text": "JD 要求向指定邮箱实际发送或投递材料",
                "instruction": "向招聘方实际发送或投递材料",
                "supported": False,
                "reason": "当前 Agent 可以生成材料，但不能代替用户实际发送邮件或完成外部投递",
                "order": len(requirements) + 1,
            }
        )
    return requirements


def _normalise_plan(
    plan: ApplicationRequirementPlan | None,
    deterministic: list[dict[str, object]],
    source_text: str = "",
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    supported: list[dict[str, object]] = []
    unsupported: list[dict[str, object]] = []

    def unsupported_key(item: dict[str, object]) -> str:
        text = " ".join(
            str(item.get(field) or "").lower()
            for field in ("title", "requirement_text", "instruction")
        )
        if any(term in text for term in ("调研", "研究", "搜索", "查找", "核实", "research")):
            return "external_research"
        if any(term in text for term in ("发送", "投递", "send", "submit")):
            return "external_submission"
        return str(item.get("title") or text)

    if plan is not None:
        for requirement in plan.requirements:
            item = requirement.model_dump()
            explicit_terms = {
                "self_intro": ("自我介绍", "self intro", "self-intro"),
                "cover_letter": ("求职信", "cover letter"),
                "match_report": ("匹配报告", "match report"),
                "interview_prep": ("面试准备", "interview prep"),
                "linkedin_summary": ("linkedin",),
            }
            required_terms = explicit_terms.get(requirement.artifact_type)
            if required_terms and not any(term in source_text.lower() for term in required_terms):
                continue
            if requirement.supported and requirement.artifact_type in _SUPPORTED_ARTIFACT_TYPES:
                supported.append(item)
            else:
                item["supported"] = False
                item["reason"] = requirement.reason or "当前 Agent 不具备完成该要求所需的能力"
                unsupported.append(item)

    for item in deterministic:
        artifact_type = str(item.get("artifact_type"))
        if item.get("supported") is False:
            key = unsupported_key(item)
            existing_unsupported_index = next(
                (
                    index
                    for index, existing in enumerate(unsupported)
                    if unsupported_key(existing) == key
                ),
                None,
            )
            if existing_unsupported_index is None:
                unsupported.append(item)
            else:
                unsupported[existing_unsupported_index] = {
                    **unsupported[existing_unsupported_index],
                    **item,
                }
            continue
        existing_index = next(
            (
                index
                for index, existing in enumerate(supported)
                if artifact_type != "other" and str(existing.get("artifact_type")) == artifact_type
            ),
            None,
        )
        if existing_index is not None:
            supported[existing_index] = {**supported[existing_index], **item}
        elif not any(
            str(existing.get("artifact_type")) == artifact_type
            and existing.get("title") == item.get("title")
            for existing in supported
        ):
            supported.append(item)

    def order_value(item: dict[str, object]) -> int:
        value = item.get("order", 1)
        return value if isinstance(value, int) else 1

    supported.sort(key=order_value)
    for index, item in enumerate(supported, start=1):
        item["order"] = index
    return supported, unsupported


async def plan_application_package_node(
    state: ApplicationPackageState,
) -> dict[str, object]:
    """Extract every additional application deliverable required by the JD."""
    raw_message = _latest_user_message(state)
    jd_text = str(state.get("jd_text") or state.get("assembled_jd_text") or raw_message)
    deterministic = _deterministic_requirements(jd_text)
    plan: ApplicationRequirementPlan | None = None

    try:
        plan = await get_provider().chat_structured(
            [
                {
                    "role": "system",
                    "content": (
                        "You plan an application package. Extract ADDITIONAL OUTPUTS that the JD "
                        "requires the candidate to submit together with the resume. Do not include "
                        "the resume itself. Do not treat skills, qualifications, job duties, working "
                        "hours, or availability as separate outputs. Supported outputs include a "
                        "self-introduction, cover letter, email subject/body, attachment filename, "
                        "match report, interview preparation, LinkedIn summary, and textual submission "
                        "checklist. Use artifact_type='other' for supported textual outputs not covered "
                        "by a named type. External browsing/research, contacting people, sending email, "
                        "submitting forms, or verifying external facts are unsupported: set supported=false "
                        "and explain why. Preserve exact length, format, naming, and language constraints "
                        "inside instruction. Return requirements in the order they should be shown."
                    ),
                },
                {
                    "role": "user",
                    "content": f"User request and job description:\n\n{jd_text[:8000]}",
                },
            ],
            ApplicationRequirementPlan,
            temperature=0.1,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Application requirement planning degraded to deterministic rules: %s", exc)

    tasks, unsupported = _normalise_plan(plan, deterministic, jd_text)
    existing_events = state.get("pending_sse_events", [])
    planned_event = {
        "event": "application.package.planned",
        "supported_count": len(tasks) + 1,  # resume is always part of this graph
        "unsupported_count": len(unsupported),
    }
    return {
        "application_tasks": tasks,
        "application_deliverables": [],
        "unsupported_requirements": unsupported,
        "pending_sse_events": [*existing_events, planned_event],
    }


async def generate_application_artifacts_node(
    state: ApplicationPackageState,
    config: RunnableConfig | None = None,
) -> dict[str, object]:
    """Generate supported JD submission materials without blocking the resume on failures."""
    deliverables: list[dict[str, object]] = []
    unsupported = list(state.get("unsupported_requirements", []))
    workspace = dict(state.get("workspace", {}))

    for task in state.get("application_tasks", []):
        artifact_type = str(task.get("artifact_type") or "other")
        instruction = str(task.get("instruction") or task.get("requirement_text") or "")
        task_state = dict(state)
        task_state.update(
            {
                "artifact_type": artifact_type,
                "intent_description": instruction,
                "workspace": workspace,
                "assembled_jd_text": state.get("jd_text") or state.get("assembled_jd_text"),
                "assembled_experiences": state.get("relevant_experiences", []),
                "assembled_preferences": state.get("user_preferences", []),
                "assembled_user_profile": state.get("user_profile"),
                "assembled_guideline_instructions": state.get("guideline_instructions", []),
                "pending_sse_events": [],
            }
        )
        try:
            result = await artifact_draft_node(cast("MainState", task_state), config)
            result_workspace = result.get("workspace")
            if isinstance(result_workspace, dict):
                workspace.update(result_workspace)
            content = str(result.get("artifact_content") or "")
            deliverables.append(
                {
                    "kind": "artifact",
                    "artifact_type": artifact_type,
                    "artifact_id": workspace.get("artifact_id"),
                    "title": str(task.get("title") or "投递材料"),
                    "content": content,
                    "requirement_text": str(task.get("requirement_text") or ""),
                    "order": int(task.get("order", len(deliverables) + 1)),
                    "status": "completed",
                }
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Application deliverable generation failed for %s", artifact_type)
            unsupported.append(
                {
                    **task,
                    "supported": True,
                    "status": "failed",
                    "reason": f"生成失败：{exc}",
                }
            )

    existing_events = state.get("pending_sse_events", [])
    completed_events = [
        {
            "event": "application.deliverable.completed",
            "deliverable": deliverable,
        }
        for deliverable in deliverables
    ]
    return {
        "application_deliverables": deliverables,
        "unsupported_requirements": unsupported,
        "workspace": workspace,
        "pending_sse_events": [*existing_events, *completed_events],
    }
