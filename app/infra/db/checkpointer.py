from __future__ import annotations

from typing import Any

from app.core.config import settings

_checkpointer: Any | None = None
_checkpointer_cm: Any | None = None


async def create_checkpointer() -> Any:
    """Create and setup the LangGraph PostgreSQL checkpointer."""
    global _checkpointer, _checkpointer_cm
    if _checkpointer is not None:
        return _checkpointer

    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    dsn = settings.database_url.replace("+asyncpg", "")
    _checkpointer_cm = AsyncPostgresSaver.from_conn_string(dsn)
    _checkpointer = await _checkpointer_cm.__aenter__()
    await _checkpointer.setup()
    return _checkpointer


async def close_checkpointer() -> None:
    global _checkpointer, _checkpointer_cm
    if _checkpointer_cm is not None:
        await _checkpointer_cm.__aexit__(None, None, None)
    _checkpointer = None
    _checkpointer_cm = None


def get_checkpointer() -> Any:
    if _checkpointer is None:
        raise RuntimeError("LangGraph checkpointer not initialised.")
    return _checkpointer
