"""ResumeEditState — resume_edit subgraph state."""
from __future__ import annotations

from typing import Any

from app.graphs.state import MainState


class ResumeEditState(MainState, total=False):
    # Tier classification results
    edit_tier: int | None
    edit_target_kind: str | None
    edit_target_id: str | None
    edit_operations: list[dict[str, Any]]

    # Tier 2/3 outputs
    edit_new_structured: dict[str, Any] | None
    edit_new_content: str | None
    edit_new_variant_id: str | None
