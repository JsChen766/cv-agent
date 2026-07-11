"""Shared helpers for LangGraph pending interrupts.

LangGraph has exposed pending interrupt values both on the snapshot and on
individual tasks across supported versions. API routes must use one reader so
that an interrupt shown to a client is the same interrupt they can consume.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PendingInterrupt:
    payload: dict[str, Any]
    turn_id: str | None
    interrupt_id: str | None


def _payload_from_interrupt(interrupt: object) -> dict[str, Any] | None:
    value = getattr(interrupt, "value", interrupt)
    return dict(value) if isinstance(value, Mapping) else None


def pending_interrupt_from_snapshot(snapshot: object | None) -> PendingInterrupt | None:
    """Return the first resumable interrupt, or ``None`` for a completed graph."""
    if snapshot is None or not getattr(snapshot, "next", ()):
        return None

    values = getattr(snapshot, "values", {})
    state = values if isinstance(values, Mapping) else {}
    candidates = list(getattr(snapshot, "interrupts", ()) or ())
    for task in getattr(snapshot, "tasks", ()) or ():
        candidates.extend(getattr(task, "interrupts", ()) or ())

    # ``values`` is retained as a compatibility fallback for older snapshots.
    candidates.append(state.get("interrupt_payload"))
    for candidate in candidates:
        payload = _payload_from_interrupt(candidate)
        if payload is None:
            continue
        turn_id = state.get("current_turn_id") or payload.get("turn_id")
        interrupt_id = payload.get("interrupt_id") or payload.get("interruptId")
        return PendingInterrupt(
            payload=payload,
            turn_id=turn_id if isinstance(turn_id, str) and turn_id else None,
            interrupt_id=interrupt_id if isinstance(interrupt_id, str) and interrupt_id else None,
        )
    return None
