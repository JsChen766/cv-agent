"""Unit tests for PreferenceService — no database required."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.errors import NotFoundError
from app.domain.preference.models import Preference
from app.domain.preference.service import PreferenceService


def _make_pref(pref_id: str = "pref-1", rule: str = "Use bullet points") -> Preference:
    now = datetime.now()
    return Preference(
        id=pref_id,
        user_id="user-1",
        rule=rule,
        category="style",
        source="explicit",
        priority=100,
        confidence=1.0,
        reinforcement_count=1,
        last_reinforced_at=now,
        scope="global",
        active=True,
        created_at=now,
        updated_at=now,
    )


@pytest.fixture
def repo():
    r = MagicMock()
    r.list = AsyncMock(return_value=[])
    r.get = AsyncMock(return_value=None)
    r.create = AsyncMock()
    r.update = AsyncMock()
    r.deactivate = AsyncMock()
    r.add_signal = AsyncMock()
    r.find_similar = AsyncMock(return_value=[])
    return r


@pytest.fixture
def svc(repo):
    return PreferenceService(repo)


async def test_get_active_preferences_returns_sorted(svc, repo):
    high = _make_pref("p1", "rule A")
    high.priority = 100
    low = _make_pref("p2", "rule B")
    low.priority = 50
    repo.list.return_value = [low, high]

    result = await svc.get_active_preferences("user-1")
    assert result[0].priority == 100
    assert result[1].priority == 50


async def test_add_explicit_preference_creates_with_priority_100(svc, repo):
    pref = _make_pref()
    repo.create.return_value = pref

    result = await svc.add_explicit_preference(
        "user-1", rule="No buzzwords", category="style"
    )
    assert result.id == pref.id
    call_kwargs = repo.create.call_args[0][2]  # third positional arg is the data dict
    assert call_kwargs["priority"] == 100
    assert call_kwargs["source"] == "explicit"


async def test_delete_preference_raises_when_not_found(svc, repo):
    repo.get.return_value = None
    with pytest.raises(NotFoundError):
        await svc.delete_preference("user-1", "pref-missing")


async def test_delete_preference_deactivates(svc, repo):
    pref = _make_pref()
    repo.get.return_value = pref
    await svc.delete_preference("user-1", "pref-1")
    repo.deactivate.assert_called_once_with("user-1", "pref-1")


async def test_record_signal_stores_signal(svc, repo):
    from app.domain.preference.models import PreferenceSignal

    signal = MagicMock(spec=PreferenceSignal)
    repo.add_signal.return_value = signal

    result = await svc.record_signal(
        "user-1",
        signal_type="rejection",
        raw_content="too formal",
    )
    assert result is signal
    repo.add_signal.assert_called_once()


async def test_upsert_from_extraction_creates_new_when_no_similar(svc, repo):
    repo.find_similar.return_value = []
    new_pref = _make_pref()
    repo.create.return_value = new_pref

    result = await svc.upsert_from_extraction(
        "user-1",
        rule="Keep it concise",
        category="style",
        source="edit_pattern",
        priority=50,
        confidence=0.8,
        embedding=[0.1] * 10,
    )
    assert result.id == new_pref.id
    repo.create.assert_called_once()


async def test_upsert_from_extraction_reinforces_existing(svc, repo):
    existing = _make_pref()
    existing.reinforcement_count = 2
    existing.confidence = 0.9
    repo.find_similar.return_value = [existing]
    repo.update.return_value = existing

    await svc.upsert_from_extraction(
        "user-1",
        rule="Keep it concise",
        category="style",
        source="edit_pattern",
        priority=50,
        confidence=0.8,
        embedding=[0.1] * 10,
    )
    update_data = repo.update.call_args[0][1]
    assert update_data["reinforcement_count"] == 3
    repo.create.assert_not_called()
