from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, Field

from app.domain.resume.factbank.models import FactDraft
from app.providers.base import LLMProvider


class FactExtractionResponse(BaseModel):
    facts: list[FactDraft] = Field(default_factory=list)


class FactExtractor(Protocol):
    async def extract(self, content: str) -> list[FactDraft]: ...


class StructuredFactExtractor:
    def __init__(self, provider: LLMProvider) -> None:
        self._provider = provider

    async def extract(self, content: str) -> list[FactDraft]:
        messages = [
            {
                "role": "system",
                "content": (
                    "Extract atomic, verifiable resume facts from the supplied revision. "
                    "Do not infer or improve facts. Each fact must describe one claim. "
                    "source_text must be an exact, contiguous quote from the input. "
                    "Use null or an empty list when a field is absent. Technologies, metrics, "
                    "dates, scope, constraints and results must be explicitly supported by "
                    "source_text. Preserve the input language."
                ),
            },
            {
                "role": "user",
                "content": f"Extract all atomic facts from this experience revision:\n\n{content}",
            },
        ]
        result = await self._provider.chat_structured(
            messages,
            FactExtractionResponse,
            temperature=0.0,
        )
        if not isinstance(result, FactExtractionResponse):
            return FactExtractionResponse.model_validate(result).facts
        return result.facts
