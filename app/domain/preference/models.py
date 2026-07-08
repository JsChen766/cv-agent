from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, JsonValue

from app.core.types import PreferenceSource, SignalType


class Preference(BaseModel):
    id: str
    user_id: str
    rule: str           # e.g. "用量化数字描述成果"
    category: str       # "tone" | "format" | "content" | "length" | "other"
    source: PreferenceSource
    priority: int       # explicit=100, rejection=70, edit_pattern=50
    confidence: float = 1.0
    reinforcement_count: int = 1
    scope: str = "global"  # "global" | "resume" | "cover_letter" etc.
    active: bool = True
    created_at: datetime
    last_reinforced_at: datetime


class PreferenceSignal(BaseModel):
    id: str
    user_id: str
    signal_type: SignalType
    raw_content: str
    generation_context: dict[str, JsonValue] = Field(default_factory=dict)
    processed: bool = False
    created_at: datetime
