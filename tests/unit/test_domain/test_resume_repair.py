from __future__ import annotations

import pytest

from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.repair_models import BulletRepairBatch
from app.domain.resume.repair_service import ResumeBulletRepairService
from app.infra.layout import PillowFontMetrics
from tests.unit.test_domain.test_resume_layout import _structure


def _repair_context():
    layout = ResumeLayoutService(PillowFontMetrics())
    structured = _structure(bullet_text="Python", item_count=1)
    item = structured["sections"][0]["items"][0]
    item["source_experience_id"] = "exp-1"
    item["bullets"] = [
        {
            "id": "bullet-1",
            "text": "Python",
            "source_fact_ids": ["exp-1-fact-1"],
            "matched_jd_requirement_ids": ["req-1"],
        }
    ]
    report = layout.measure_resume_layout(structured)
    experiences = [
        {
            "id": "exp-1",
            "content": "A" * 100 + " improved latency by 40%",
            "claims": [],
        }
    ]
    budget = {
        "experiences": [
            {
                "experience_id": "exp-1",
                "facts": [{"id": "exp-1-fact-1", "text": "A" * 100}],
            }
        ]
    }
    return layout, structured, report, experiences, budget


def test_local_repair_selects_passing_grounded_candidate_deterministically() -> None:
    layout, structured, report, experiences, budget = _repair_context()
    batch = BulletRepairBatch.model_validate(
        {
            "repairs": [
                {
                    "bullet_id": "bullet-1",
                    "candidates": [
                        {
                            "text": "too short",
                            "source_fact_ids": ["exp-1-fact-1"],
                            "matched_jd_requirement_ids": ["req-1"],
                        },
                        {
                            "text": "A" * 68,
                            "source_fact_ids": ["exp-1-fact-1"],
                            "matched_jd_requirement_ids": ["req-1"],
                        },
                        {
                            "text": "A" * 75,
                            "source_fact_ids": ["exp-1-fact-1"],
                            "matched_jd_requirement_ids": ["req-1"],
                        },
                    ],
                }
            ]
        }
    )

    first = ResumeBulletRepairService(layout).apply_batch(
        structured, report, batch, experiences=experiences, content_budget=budget
    )
    second = ResumeBulletRepairService(layout).apply_batch(
        structured, report, batch, experiences=experiences, content_budget=budget
    )

    assert first == second
    assert first is not None
    assert first["sections"][0]["items"][0]["bullets"][0]["text"] == "A" * 68
    assert structured["sections"][0]["items"][0]["bullets"][0]["text"] == "Python"


@pytest.mark.parametrize(
    "candidate",
    [
        {
            "text": "A" * 68,
            "source_fact_ids": ["unknown-fact"],
            "matched_jd_requirement_ids": ["req-1"],
        },
        {
            "text": "A" * 68 + " 999",
            "source_fact_ids": ["exp-1-fact-1"],
            "matched_jd_requirement_ids": ["req-1"],
        },
        {
            "text": "A" * 68,
            "source_fact_ids": ["exp-1-fact-1"],
            "matched_jd_requirement_ids": ["req-new"],
        },
    ],
)
def test_local_repair_rejects_unknown_fact_number_or_coverage(candidate) -> None:
    layout, structured, report, experiences, budget = _repair_context()
    batch = BulletRepairBatch.model_validate(
        {"repairs": [{"bullet_id": "bullet-1", "candidates": [candidate]}]}
    )

    result = ResumeBulletRepairService(layout).apply_batch(
        structured, report, batch, experiences=experiences, content_budget=budget
    )

    assert result is None


def test_local_repair_requires_exactly_all_failing_bullet_ids() -> None:
    layout, structured, report, experiences, budget = _repair_context()
    batch = BulletRepairBatch.model_validate(
        {
            "repairs": [
                {
                    "bullet_id": "unknown",
                    "candidates": [{"text": "A" * 68}],
                }
            ]
        }
    )

    assert (
        ResumeBulletRepairService(layout).apply_batch(
            structured, report, batch, experiences=experiences, content_budget=budget
        )
        is None
    )
