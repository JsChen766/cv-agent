from app.domain.resume.content_budget import build_resume_content_budget
from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_optimizer import ResumeLayoutOptimizer
from app.domain.resume.layout_service import ResumeLayoutService
from app.infra.layout import PillowFontMetrics
from tests.unit.test_domain.test_resume_layout import _structure


def test_content_budget_allocates_more_bullets_to_high_jd_match() -> None:
    high_claims = [{"text": f"high fact {index}", "category": "achievement"} for index in range(8)]
    experiences = [
        {
            "id": "exp-high",
            "category": "work",
            "claims": high_claims,
            "relevance_score": 0.9,
        },
        {
            "id": "exp-low",
            "category": "project",
            "claims": [{"text": "low fact", "category": "responsibility"}],
            "relevance_score": 0.1,
        },
    ]
    evidence_pack = {
        "matches": [
            {
                "match_score": 0.95,
                "matched_claims": [{"text": "high fact 1"}],
            }
        ]
    }

    result = build_resume_content_budget(
        experiences,
        evidence_pack,
        target_usage_ratio=0.88,
        candidate_pool_target_ratio=1.20,
    )
    by_id = {value.experience_id: value for value in result.experiences}

    assert by_id["exp-high"].jd_match_score > by_id["exp-low"].jd_match_score
    assert by_id["exp-high"].target_candidate_bullets > by_id["exp-low"].target_candidate_bullets


def test_layout_optimizer_selects_content_inside_target_band() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    constraint = LayoutConstraint(max_pages=None, requested_pages=1)
    candidate_pool = _structure(bullet_text="A" * 75, item_count=6)

    result = ResumeLayoutOptimizer(service).optimize(candidate_pool, constraint)

    assert result.fits_target_band is True
    assert result.report.page_count == 1
    assert 0.80 <= result.report.pages[0].usage_ratio <= 0.95
    assert abs(result.report.pages[0].usage_ratio - 0.88) <= 0.02


def test_layout_optimizer_uses_bounded_tuning_then_reports_content_gap() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    constraint = LayoutConstraint(max_pages=None, requested_pages=1)
    sparse_pool = _structure(bullet_text="A" * 75, item_count=4)

    result = ResumeLayoutOptimizer(service).optimize(sparse_pool, constraint)

    assert result.fits_target_band is False
    assert result.maximum_usage_ratio < 0.80
    assert result.report.status == "needs_revision"
    assert result.structure["layout_tuning"]["body_font_scale"] == 1.08
    assert result.structure["layout_tuning"]["body_line_height"] == 1.28


def test_layout_optimizer_preserves_explicit_multi_page_content() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    constraint = LayoutConstraint(max_pages=None, requested_pages=2)
    candidate_pool = _structure(bullet_text="A" * 75, item_count=10)

    result = ResumeLayoutOptimizer(service).optimize(candidate_pool, constraint)

    assert result.report.page_count > 1
    assert result.report.status == "pass"
    assert result.fits_target_band is True
    assert result.structure == candidate_pool


def test_layout_beam_is_deterministic_and_preserves_unique_jd_coverage() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    constraint = LayoutConstraint(max_pages=1, requested_pages=1)
    candidate_pool = _structure(bullet_text="A" * 75, item_count=6)
    sections = candidate_pool["sections"]
    unique_bullet = sections[0]["items"][0]["bullets"][2]
    unique_bullet["matched_jd_requirement_ids"] = ["req-unique"]

    first = ResumeLayoutOptimizer(service).optimize(candidate_pool, constraint)
    second = ResumeLayoutOptimizer(service).optimize(candidate_pool, constraint)

    assert first.structure == second.structure
    assert first.report == second.report
    selected_items = first.structure["sections"][0]["items"]
    assert all(len(item["bullets"]) >= 2 for item in selected_items)
    selected_requirement_ids = {
        requirement_id
        for item in selected_items
        for bullet in item["bullets"]
        for requirement_id in bullet.get("matched_jd_requirement_ids", [])
    }
    assert "req-unique" in selected_requirement_ids
