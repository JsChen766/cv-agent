"""JD subgraph nodes."""

from __future__ import annotations

from app.graphs.state import MainState
from app.providers.factory import get_provider


async def save_jd_node(state: MainState) -> dict:
    """Extract JD info from user message and save it."""
    from pydantic import BaseModel


    messages = state.get("messages", [])
    extracted = state.get("extracted_params", {})

    # If JD data already extracted by router, use it directly
    raw_text = extracted.get("raw_text") or extracted.get("jd_text")
    title = extracted.get("title") or extracted.get("jd_title")
    company = extracted.get("company")
    target_role = extracted.get("target_role")

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


async def parse_requirements_node(state: MainState) -> dict:
    """Parse JD requirements from raw text."""
    from pydantic import BaseModel

    extracted = state.get("extracted_params", {})
    raw_text = extracted.get("raw_text", "")
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

    reqs = []
    if result:
        import uuid
        reqs = [
            {"id": str(uuid.uuid4()), "text": r.text, "category": r.category, "importance": r.importance}
            for r in result.requirements
        ]

    return {
        "extracted_params": {**extracted, "requirements": reqs}
    }
