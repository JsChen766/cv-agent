"""Extract structured claims from experience content via LLM."""

from __future__ import annotations

from pydantic import BaseModel

from app.rag.evidence.models import Claim


class ClaimList(BaseModel):
    claims: list[Claim]


async def extract_claims(content: str) -> list[Claim]:
    """Call LLM to extract structured claims from experience content."""
    from app.providers.factory import get_provider

    provider = get_provider()
    messages = [
        {
            "role": "system",
            "content": (
                "You are an expert resume analyst. Extract concrete, verifiable claims from "
                "the given experience content. Each claim should be a single, specific statement.\n\n"
                "For each claim, identify:\n"
                "- text: the claim statement\n"
                "- category: one of 'achievement', 'skill', 'responsibility', 'metric'\n"
                "- is_quantified: true if the claim contains numbers/percentages/timeframes"
            ),
        },
        {
            "role": "user",
            "content": f"Extract claims from this experience:\n\n{content}",
        },
    ]
    result = await provider.chat_structured(messages, ClaimList, temperature=0.1)
    return result.claims if result else []
