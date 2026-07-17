from app.graphs.resume.nodes import (
    layout_route,
    quality_gate_node,
    quality_gate_route,
    review_route,
)


def test_layout_revision_budget_never_fakes_pass(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_layout_revision_iterations", 3)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_resume_generation_calls", 7)

    state = {
        "layout_report": {"status": "needs_revision"},
        "layout_revision_iteration": 3,
        "generation_call_count": 4,
    }

    assert layout_route(state) == "fact_check"


def test_self_review_limit_routes_to_quality_gate(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_self_review_iterations", 3)

    assert (
        review_route(
            {
                "review_iteration": 3,
                "generation_call_count": 3,
                "review_result": {"verdict": "needs_revision"},
            }
        )
        == "quality_gate"
    )


async def test_fact_failure_is_not_an_acceptable_candidate() -> None:
    result = await quality_gate_node(
        {
            "fact_mismatches": [
                {
                    "field": "metric",
                    "drafted_value": "99%",
                    "source_value": None,
                    "experience_title": "Example",
                }
            ]
        }
    )

    assert result["quality_status"] == "failed"
    assert quality_gate_route(result) == "failed"


async def test_layout_or_coverage_issue_requires_explicit_decision() -> None:
    result = await quality_gate_node(
        {
            "fact_mismatches": [],
            "coverage_before_layout": ["req-1"],
            "uncovered_jd_requirement_ids": ["req-1"],
            "review_result": {"verdict": "pass"},
            "layout_report": {
                "profile_version": "resume-template-v2",
                "profile_hash": "hash",
                "content_width_mm": 192,
                "page_available_height_mm": 279,
                "page_count": 2,
                "overflow_mm": 20,
                "violations": [
                    {
                        "code": "page_limit_exceeded",
                        "message": "Two pages",
                        "severity": "hard",
                    }
                ],
                "status": "needs_revision",
            },
        }
    )

    assert result["quality_status"] == "needs_user_decision"
    assert quality_gate_route(result) == "needs_user_decision"


async def test_uncalibrated_layout_never_silently_passes(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_layout_hard_gate_enabled", False)
    result = await quality_gate_node(
        {
            "fact_mismatches": [],
            "coverage_before_layout": [],
            "uncovered_jd_requirement_ids": [],
            "review_result": {"verdict": "pass"},
            "layout_report": {
                "profile_version": "resume-template-v2",
                "profile_hash": "hash",
                "content_width_mm": 192,
                "page_available_height_mm": 279,
                "page_count": 1,
                "overflow_mm": 0,
                "violations": [],
                "status": "pass",
            },
        }
    )

    assert result["quality_status"] == "needs_user_decision"
    assert result["quality_issues"] == [
        {
            "code": "layout_calibration_pending",
            "message": (
                "Browser calibration is pending; the estimated layout cannot be silently "
                "treated as a hard quality pass."
            ),
        }
    ]


async def test_invalid_layout_report_becomes_quality_failure() -> None:
    result = await quality_gate_node(
        {
            "fact_mismatches": [],
            "layout_report": {"status": "needs_revision"},
            "review_result": {"verdict": "pass"},
            "coverage_before_layout": [],
            "uncovered_jd_requirement_ids": [],
        }
    )

    assert result["quality_status"] == "failed"
    assert result["quality_issues"][0]["code"] == "invalid_layout_report"
