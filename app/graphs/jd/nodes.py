"""JD subgraph nodes."""

from langchain_core.runnables import RunnableConfig

from app.domain.jd.models import JdRequirementDraft, JdRequirementImportance
from app.graphs.runtime import services_from_config
from app.graphs.state import MainState
from app.providers.factory import get_provider


async def save_jd_node(state: MainState) -> dict[str, object]:
    """Extract JD info from user message and save it."""
    from pydantic import BaseModel


    messages = state.get("messages", [])
    extracted = state.get("extracted_params", {})

    # If JD data already extracted by router, use it directly
    raw_text_value = extracted.get("raw_text") or extracted.get("jd_text")
    raw_text = raw_text_value if isinstance(raw_text_value, str) else None
    title_value = extracted.get("title") or extracted.get("jd_title")
    title = title_value if isinstance(title_value, str) else None
    company_value = extracted.get("company")
    company = company_value if isinstance(company_value, str) else None
    target_role_value = extracted.get("target_role")
    target_role = target_role_value if isinstance(target_role_value, str) else None

    if not raw_text:
        # Extract from latest user message
        user_msgs = [m for m in messages if m["role"] == "user"]
        if user_msgs:
            raw_text = user_msgs[-1]["content"]
            title = title or "Job Description"

    if not raw_text:
        return {"assistant_message": "I couldn't find a JD to save. Please paste the job description."}

    # Use LLM to extract structured JD info
    provider = get_provider()

    class JdInfo(BaseModel):
        title: str
        company: str | None = None
        target_role: str | None = None

    jd_info = await provider.chat_structured(
        [
            {"role": "system", "content": "Extract the job title, company name, and target role from this job description. If not present, return None."},
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
    state: MainState, config: RunnableConfig | None = None
) -> dict[str, object]:
    """Parse JD requirements from raw text."""
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
        import uuid
        reqs = [
            {"id": str(uuid.uuid4()), "text": r.text, "category": r.category, "importance": r.importance}
            for r in result.requirements
        ]

    services = services_from_config(config)
    if services is None:
        return {
            "extracted_params": {**extracted, "requirements": reqs},
        }

    title_value = extracted.get("title")
    company_value = extracted.get("company")
    target_role_value = extracted.get("target_role")
    jd = await services.jd.create_jd(
        state.get("user_id", ""),
        title=title_value if isinstance(title_value, str) and title_value else "Job Description",
        raw_text=raw_text,
        company=company_value if isinstance(company_value, str) else None,
        target_role=target_role_value if isinstance(target_role_value, str) else None,
        requirements=[
            JdRequirementDraft(
                id=req["id"],
                text=req["text"],
                category=req["category"],
                importance=_normalize_importance(req["importance"]),
            )
            for req in reqs
        ],
    )
    workspace = dict(state.get("workspace", {}))
    workspace["jd_id"] = jd.id
    existing = state.get("pending_sse_events", [])
    completed_event = {
        "event": "agent.completed",
        "message": f"Saved JD '{jd.title}' with {len(jd.requirements)} requirement(s).",
        "data": {"jd_id": jd.id, "requirements_count": len(jd.requirements)},
    }

    return {
        "assistant_message": f"Saved JD '{jd.title}' with {len(jd.requirements)} requirement(s).",
        "workspace": workspace,
        "extracted_params": {**extracted, "requirements": [r.model_dump() for r in jd.requirements]},
        "pending_sse_events": [*existing, completed_event],
    }


def _normalize_importance(value: str) -> JdRequirementImportance:
    if value == "high":
        return "high"
    if value == "low":
        return "low"
    return "medium"
