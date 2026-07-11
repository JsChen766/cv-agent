from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.api.interrupts import pending_interrupt_from_snapshot
from app.api.routes.copilot import _reject_if_pending_interrupt
from app.api.routes.threads import _pending_interrupt_or_conflict
from app.core.errors import ConflictError


def _snapshot(*, turn_id: str = "turn-1", interrupt_id: str = "interrupt-1") -> object:
    interrupt = SimpleNamespace(
        value={"type": "jd_save", "interrupt_id": interrupt_id, "candidate": {"title": "Backend"}}
    )
    return SimpleNamespace(
        next=("jd",),
        values={"current_turn_id": turn_id},
        interrupts=(),
        tasks=(SimpleNamespace(interrupts=(interrupt,)),),
    )


def test_pending_interrupt_reads_langgraph_task_interrupt_and_turn() -> None:
    pending = pending_interrupt_from_snapshot(_snapshot())

    assert pending is not None
    assert pending.payload["type"] == "jd_save"
    assert pending.turn_id == "turn-1"
    assert pending.interrupt_id == "interrupt-1"


def test_pending_interrupt_requires_resumable_snapshot() -> None:
    snapshot = _snapshot()
    snapshot.next = ()

    assert pending_interrupt_from_snapshot(snapshot) is None


def test_pending_interrupt_rejects_stale_turn_or_interrupt() -> None:
    snapshot = _snapshot()

    with pytest.raises(ConflictError, match="older turn"):
        _pending_interrupt_or_conflict(snapshot, turn_id="turn-old", interrupt_id=None)
    with pytest.raises(ConflictError, match="older interrupt"):
        _pending_interrupt_or_conflict(snapshot, turn_id="turn-1", interrupt_id="interrupt-old")


class _SuspendedGraph:
    async def aget_state(self, config: object) -> object:
        return _snapshot()


@pytest.mark.asyncio
async def test_new_chat_is_rejected_without_preempting_pending_interrupt() -> None:
    with pytest.raises(ConflictError) as error:
        await _reject_if_pending_interrupt(_SuspendedGraph(), {"configurable": {"thread_id": "thread-1"}})

    assert error.value.code == "pending_interrupt_exists"
