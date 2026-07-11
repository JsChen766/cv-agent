"""State used internally by the JD subgraph."""

from __future__ import annotations

from typing import Any

from app.graphs.state import MainState


class JdState(MainState, total=False):
    """JD-only fields that must survive between confirm and persist nodes."""

    jd_confirmed: bool | None
    jd_candidate: dict[str, Any] | None
