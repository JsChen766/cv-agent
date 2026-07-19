from __future__ import annotations

from app.domain.jd.requirement_map.models import ParsedJdDraft
from app.providers.base import LLMProvider


class StructuredRequirementMapParser:
    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def parse(self, normalized_jd_text: str) -> ParsedJdDraft:
        result = await self._provider.chat_structured(
            [
                {
                    "role": "system",
                    "content": (
                        "Parse the complete job description into a grounded RequirementMap. "
                        "Return title, company, target_role when explicitly present. For every "
                        "requirement, preserve the JD meaning and classify it as exactly one of: "
                        "qualification (candidate background), responsibility (job duty), "
                        "technology (skill/tool/platform), domain (industry or business context), "
                        "or soft_skill. Set importance to must_have only when required or central, "
                        "preferred when explicitly preferred or beneficial, and optional for "
                        "culture or non-essential items. Extract concise keywords. Merge obvious "
                        "duplicates, do not infer unstated requirements, and inspect the entire JD."
                    ),
                },
                {"role": "user", "content": normalized_jd_text},
            ],
            ParsedJdDraft,
            temperature=0.1,
        )
        return ParsedJdDraft.model_validate(result)
