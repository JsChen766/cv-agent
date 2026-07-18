from app.graphs.resume.nodes import (
    layout_route,
    quality_gate_node,
    quality_gate_route,
    review_route,
)


def test_underfilled_layout_routes_to_content_gap_after_revision_budget(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_layout_revision_iterations", 3)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_resume_generation_calls", 7)

    state = {
        "layout_report": {
            "status": "needs_revision",
            "violations": [{"code": "page_underfilled"}],
        },
        "layout_revision_iteration": 3,
        "generation_call_count": 4,
    }

    assert layout_route(state) == "content_gap"


def test_bullet_only_layout_issue_requires_revision(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_layout_revision_iterations", 3)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_resume_generation_calls", 7)

    state = {
        "layout_report": {
            "status": "needs_revision",
            "pages": [{"usage_ratio": 0.86}],
            "violations": [{"code": "bullet_awkward_wrap"}],
        },
        "layout_fit_status": "fit",
        "layout_revision_iteration": 0,
        "generation_call_count": 1,
    }

    assert layout_route(state) == "revision"


def test_underfilled_bullet_repair_requests_content(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_layout_revision_iterations", 3)
    monkeypatch.setattr("app.graphs.resume.nodes.settings.max_resume_generation_calls", 7)

    state = {
        "layout_report": {
            "status": "needs_revision",
            "pages": [{"usage_ratio": 0.77}],
            "violations": [
                {"code": "bullet_awkward_wrap"},
                {"code": "page_underfilled"},
            ],
        },
        "layout_fit_status": "underfilled",
        "layout_revision_iteration": 0,
        "generation_call_count": 1,
    }

    assert layout_route(state) == "content_gap"


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

    assert result["quality_status"] == "failed"
    assert quality_gate_route(result) == "failed"


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
                "pages": [
                    {
                        "page_number": 1,
                        "available_height_mm": 279,
                        "used_height_mm": 245.52,
                        "usage_ratio": 0.88,
                    }
                ],
                "violations": [],
                "status": "pass",
            },
        }
    )

    assert result["quality_status"] == "failed"
    assert result["quality_issues"] == [
        {
            "code": "browser_verification_required",
            "message": (
                "Browser layout verification is required before this candidate can be "
                "persisted or reviewed."
            ),
        }
    ]


async def test_underfilled_resume_fails_closed() -> None:
    result = await quality_gate_node(
        {
            "fact_mismatches": [],
            "coverage_before_layout": [],
            "uncovered_jd_requirement_ids": [],
            "review_result": {"verdict": "pass"},
            "layout_constraint": {
                "max_pages": 1,
                "minimum_page_usage_ratio": 0.80,
                "target_page_usage_ratio": 0.88,
                "maximum_page_usage_ratio": 0.95,
            },
            "layout_report": {
                "profile_version": "resume-template-v2",
                "profile_hash": "hash",
                "content_width_mm": 192,
                "page_available_height_mm": 279,
                "page_count": 1,
                "overflow_mm": 0,
                "pages": [
                    {
                        "page_number": 1,
                        "available_height_mm": 279,
                        "used_height_mm": 214.83,
                        "usage_ratio": 0.77,
                    }
                ],
                "violations": [
                    {
                        "code": "page_underfilled",
                        "message": "Resume is below the preferred fill target",
                        "severity": "hard",
                    }
                ],
                "status": "needs_revision",
            },
        }
    )

    assert result["quality_status"] == "failed"
    assert quality_gate_route(result) == "failed"
    assert {issue["code"] for issue in result["quality_issues"]} == {
        "layout_usage_underfilled",
        "page_underfilled",
    }


async def test_uncalibrated_profile_mismatch_is_fatal(monkeypatch) -> None:
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
                "pages": [
                    {
                        "page_number": 1,
                        "available_height_mm": 279,
                        "used_height_mm": 245.52,
                        "usage_ratio": 0.88,
                    }
                ],
                "violations": [
                    {
                        "code": "font_checksum_mismatch",
                        "message": "Font metrics do not match the layout profile",
                        "severity": "hard",
                    }
                ],
                "status": "profile_mismatch",
            },
        }
    )

    assert result["quality_status"] == "failed"
    assert quality_gate_route(result) == "failed"


async def test_calibrated_profile_mismatch_remains_fatal(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.resume.nodes.settings.resume_layout_hard_gate_enabled", True)
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
                "pages": [
                    {
                        "page_number": 1,
                        "available_height_mm": 279,
                        "used_height_mm": 245.52,
                        "usage_ratio": 0.88,
                    }
                ],
                "violations": [
                    {
                        "code": "font_checksum_mismatch",
                        "message": "Font metrics do not match the layout profile",
                        "severity": "hard",
                    }
                ],
                "status": "profile_mismatch",
            },
        }
    )

    assert result["quality_status"] == "failed"
    assert quality_gate_route(result) == "failed"


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


async def test_unresolved_short_bullet_fails_closed() -> None:
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
                "pages": [
                    {
                        "page_number": 1,
                        "available_height_mm": 279,
                        "used_height_mm": 245.52,
                        "usage_ratio": 0.88,
                    }
                ],
                "violations": [
                    {
                        "code": "bullet_too_short",
                        "message": "Last line is below the width gate",
                        "severity": "hard",
                    }
                ],
                "status": "needs_revision",
            },
        }
    )

    assert result["quality_status"] == "failed"
    assert quality_gate_route(result) == "failed"
