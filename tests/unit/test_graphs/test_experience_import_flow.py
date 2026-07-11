from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.graphs.experience.nodes import (
    import_review_route,
    parse_import_node,
    review_import_node,
    save_import_node,
)
from app.tools.base import ServiceContainer


class _ParseProvider:
    async def chat_structured(self, messages, schema, **kwargs):
        return schema.model_validate(
            {
                "candidates": [
                    {
                        "title": "Backend Engineer",
                        "organization": "Acme",
                        "start_date": "2024-01",
                        "end_date": "Present",
                        "content": "Built payment APIs",
                        "category": "work",
                    }
                ]
            }
        )


async def test_experience_parse_normalizes_dates_and_keeps_raw_upload(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.experience.nodes.get_provider", lambda: _ParseProvider())

    result = await parse_import_node(
        {
            "messages": [{"role": "user", "content": "short instruction"}],
            "extracted_params": {"raw_text": "full parsed resume text"},
            "pending_sse_events": [],
        }
    )

    candidate = result["import_candidates"][0]
    assert candidate["start_date"] == "2024-01"
    assert candidate["end_date"] == "present"


async def test_experience_discard_stops_before_persistence(monkeypatch) -> None:
    monkeypatch.setattr(
        "langgraph.types.interrupt",
        lambda payload: {"action": "discard"},
    )
    reviewed = await review_import_node(
        {
            "import_candidates": [{"title": "Backend", "content": "Built APIs"}],
            "pending_sse_events": [],
        }
    )
    service = MagicMock()
    service.create_experience = AsyncMock()
    services = ServiceContainer.model_construct(experience=service)

    saved = await save_import_node(
        {**reviewed, "user_id": "user-1"},
        {"configurable": {"services": services}},
    )

    assert import_review_route(reviewed) == "end"
    assert reviewed["assistant_message"] == "已取消导入。"
    assert saved == {}
    service.create_experience.assert_not_awaited()


async def test_experience_false_confirmation_cannot_fall_through_to_save(monkeypatch) -> None:
    monkeypatch.setattr(
        "langgraph.types.interrupt",
        lambda payload: {"confirmed": False},
    )

    reviewed = await review_import_node(
        {
            "import_candidates": [{"title": "Backend", "content": "Built APIs"}],
            "pending_sse_events": [],
        }
    )

    assert reviewed["import_candidates"] == []
    assert import_review_route(reviewed) == "end"


async def test_experience_save_validates_all_dates_before_first_write() -> None:
    service = MagicMock()
    service.create_experience = AsyncMock()
    services = ServiceContainer.model_construct(experience=service)
    state = {
        "user_id": "user-1",
        "import_candidates": [
            {"title": "Valid", "content": "A", "start_date": "2024-01"},
            {"title": "Invalid", "content": "B", "start_date": "not-a-date"},
        ],
    }

    with pytest.raises(ValueError):
        await save_import_node(state, {"configurable": {"services": services}})

    service.create_experience.assert_not_awaited()
