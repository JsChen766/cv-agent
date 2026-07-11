from __future__ import annotations

import pytest

from app.api.copilot.workspace_builder import build_workspace
from app.core.errors import ForbiddenError


class _Connection:
    def __init__(self, owner: str) -> None:
        self.owner = owner

    async def fetchrow(self, query: str, record_id: str):
        return {"user_id": self.owner}


class _Acquire:
    def __init__(self, connection: _Connection) -> None:
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, *args):
        return None


class _Pool:
    def __init__(self, owner: str) -> None:
        self.connection = _Connection(owner)

    def acquire(self):
        return _Acquire(self.connection)


async def test_workspace_builder_accepts_owned_graph_context() -> None:
    workspace = await build_workspace(
        "user-1",
        {"jd_id": "jd-1", "resume_id": "resume-1", "experience_ids": ["exp-1"]},
        _Pool("user-1"),  # type: ignore[arg-type]
    )

    assert workspace == {
        "jd_id": "jd-1",
        "resume_id": "resume-1",
        "experience_ids": ["exp-1"],
    }


async def test_workspace_builder_rejects_cross_user_graph_context() -> None:
    with pytest.raises(ForbiddenError):
        await build_workspace(
            "user-1",
            {"resume_id": "resume-owned-by-user-2"},
            _Pool("user-2"),  # type: ignore[arg-type]
        )
