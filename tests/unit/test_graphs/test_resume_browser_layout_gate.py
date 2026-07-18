from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.domain.resume.models import ResumeVariant
from app.domain.resume.observability_models import (
    BrowserLayoutObservationResult,
    BrowserLayoutVerificationResult,
    BrowserLayoutViolation,
)
from app.graphs.resume.nodes import browser_layout_gate_node, browser_layout_gate_route
from app.tools.base import ServiceContainer


def _observation() -> dict[str, object]:
    return {
        "run_id": None,
        "surface": "review",
        "measurement_version": "browser-layout-observation-v1",
        "template_id": "resume-standard",
        "profile_version": "resume-template-v2",
        "profile_hash": "profile-hash",
        "fonts_ready": True,
        "loaded_font_families": ["SimSun"],
        "page_count": 1,
        "overflow_px": 0,
        "used_height_px": 880,
        "available_height_px": 1000,
        "viewport": {
            "width_px": 1440,
            "height_px": 1200,
            "device_pixel_ratio": 1,
        },
        "page_metrics": [],
        "bullets": [
            {
                "bullet_id": "bullet-1",
                "line_count": 2,
                "last_line_width_px": 210,
                "available_line_width_px": 300,
            }
        ],
        "client_build": "test",
        "observed_at": datetime.now(UTC).isoformat(),
        "idempotency_key": "observation-1",
    }


def _saved_observation(**updates: object) -> BrowserLayoutObservationResult:
    values = {
        "id": "rlobs-1",
        "run_id": None,
        "user_id": "user-1",
        "resume_id": "resume-1",
        "variant_id": "variant-1",
        "surface": "review",
        "measurement_version": "browser-layout-observation-v1",
        "template_id": "resume-standard",
        "profile_version": "resume-template-v2",
        "profile_hash": "profile-hash",
        "profile_matches": True,
        "fonts_ready": True,
        "loaded_font_families": ["SimSun"],
        "page_count": 1,
        "overflow_px": 0,
        "used_height_px": 880,
        "available_height_px": 1000,
        "page_usage_ratio": 0.88,
        "viewport": {"width_px": 1440, "height_px": 1200, "device_pixel_ratio": 1},
        "page_metrics": [],
        "bullet_metrics": [],
        "client_build": "test",
        "observed_at": datetime.now(UTC),
        "idempotency_key": "observation-1",
        "created_at": datetime.now(UTC),
        "created": True,
    }
    values.update(updates)
    return BrowserLayoutObservationResult.model_validate(values)


class _ObservabilityService:
    def __init__(self, result: BrowserLayoutVerificationResult) -> None:
        self.result = result

    async def verify_layout_observation(self, **kwargs):
        return self.result


class _ResumeService:
    def __init__(self) -> None:
        self.statuses: list[str] = []

    async def set_variant_quality(self, user_id, variant_id, status, issues):
        self.statuses.append(status)
        return ResumeVariant(
            id="variant-1",
            resume_id="resume-1",
            title="Draft",
            content="# Resume",
            structured=_structured(),
            gate_status=status,
            quality_issues=issues,
            quality_gate_version="browser-layout-gate-v1",
            created_at=datetime.now(UTC),
        )


def _structured() -> dict[str, object]:
    return {
        "language": "zh-CN",
        "layout_template_id": "resume-standard",
        "layout_profile_version": "resume-template-v2",
        "layout_profile_hash": "profile-hash",
        "sections": [
            {
                "id": "section-1",
                "type": "experience",
                "heading": "经历",
                "items": [
                    {
                        "id": "item-1",
                        "title": "工程师",
                        "bullets": [{"id": "bullet-1", "text": "负责平台开发"}],
                    }
                ],
            }
        ],
    }


def _state() -> dict[str, object]:
    return {
        "user_id": "user-1",
        "workspace": {"resume_id": "resume-1"},
        "variants": [
            {
                "id": "variant-1",
                "title": "Draft",
                "content": "# Resume",
                "structured": _structured(),
            }
        ],
        "layout_revision_iteration": 0,
        "local_repair_call_count": 0,
    }


async def test_browser_gate_promotes_only_server_verified_variant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    verification = BrowserLayoutVerificationResult(
        status="passed",
        observation=_saved_observation(),
    )
    resume = _ResumeService()
    services = ServiceContainer.model_construct(
        resume=resume,
        resume_observability=_ObservabilityService(verification),
    )
    monkeypatch.setattr(
        "app.graphs.resume.nodes.settings.resume_layout_hard_gate_enabled", True
    )
    monkeypatch.setattr(
        "langgraph.types.interrupt",
        lambda payload: {"action": "verify_layout", "observation": _observation()},
    )

    result = await browser_layout_gate_node(
        _state(), {"configurable": {"services": services}}
    )

    assert browser_layout_gate_route(result) == "passed"
    assert resume.statuses == ["passed"]
    assert result["variants"][0]["gate_status"] == "passed"


async def test_browser_gate_routes_tail_only_failure_to_local_repair(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    verification = BrowserLayoutVerificationResult(
        status="needs_revision",
        observation=_saved_observation(),
        violations=[
            BrowserLayoutViolation(
                code="bullet_tail",
                message="Tail below gate",
                bullet_id="bullet-1",
            )
        ],
        repairable_bullet_ids=["bullet-1"],
    )
    resume = _ResumeService()
    services = ServiceContainer.model_construct(
        resume=resume,
        resume_observability=_ObservabilityService(verification),
    )
    monkeypatch.setattr(
        "app.graphs.resume.nodes.settings.resume_layout_hard_gate_enabled", True
    )
    monkeypatch.setattr(
        "langgraph.types.interrupt",
        lambda payload: {"action": "verify_layout", "observation": _observation()},
    )
    state = _state()
    state["layout_report"] = {
        "profile_version": "resume-template-v2",
        "profile_hash": "profile-hash",
        "content_width_mm": 192,
        "page_available_height_mm": 279,
        "page_count": 1,
        "overflow_mm": 0,
        "pages": [],
        "bullet_fits": [
            {
                "bullet_id": "bullet-1",
                "section_type": "experience",
                "item_id": "item-1",
                "line_count": 2,
                "line_widths_mm": [100, 80],
                "last_line_width_mm": 80,
                "last_line_ratio": 0.8,
                "target_ratio": 0.8,
                "gate_ratio": 0.667,
                "status": "pass",
                "recommendation": "none",
            }
        ],
        "violations": [],
        "status": "pass",
    }

    result = await browser_layout_gate_node(
        state, {"configurable": {"services": services}}
    )

    assert browser_layout_gate_route(result) == "repair"
    assert resume.statuses == ["needs_revision"]
    assert result["layout_report"]["bullet_fits"][0]["status"] == "too_short"
