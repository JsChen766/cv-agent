from app.domain.resume.layout_models import LayoutConstraint
from app.domain.resume.layout_profile import DEFAULT_RESUME_LAYOUT_PROFILE
from app.domain.resume.layout_service import ResumeLayoutService
from app.infra.layout import PillowFontMetrics


def _structure(*, bullet_text: str = "A" * 70, item_count: int = 1) -> dict[str, object]:
    profile = DEFAULT_RESUME_LAYOUT_PROFILE
    return {
        "language": "zh-CN",
        "layout_profile_version": profile.version,
        "layout_profile_hash": profile.profile_hash,
        "contact": {"name": "测试用户", "email": "test@example.com"},
        "sections": [
            {
                "id": "sec-experience",
                "type": "experience",
                "heading": "工作经历",
                "items": [
                    {
                        "id": f"item-{index}",
                        "title": "后端工程师",
                        "organization": "示例公司",
                        "role": "工程师",
                        "start_date": "2024-01",
                        "end_date": "2025-01",
                        "source_experience_id": f"exp-{index}",
                        "raw_text": None,
                        "bullets": [
                            {
                                "id": f"bullet-{index}-{bullet_index}",
                                "text": bullet_text,
                                "matched_jd_requirement_ids": [],
                            }
                            for bullet_index in range(8)
                        ],
                    }
                    for index in range(item_count)
                ],
            }
        ],
    }


def test_bullet_fit_uses_measured_width_and_conservative_gate() -> None:
    service = ResumeLayoutService(PillowFontMetrics())

    below_gate = service.measure_bullet_fit(
        "A" * 70, bullet_id="short", item_id="item", section_type="experience"
    )
    passing = service.measure_bullet_fit(
        "A" * 75, bullet_id="pass", item_id="item", section_type="experience"
    )
    awkward = service.measure_bullet_fit(
        "A" * 110, bullet_id="awkward", item_id="item", section_type="experience"
    )

    assert 0.667 <= below_gate.last_line_ratio < below_gate.gate_ratio
    assert below_gate.status == "too_short"
    assert passing.status == "pass"
    assert awkward.line_count == 2
    assert awkward.status == "awkward_wrap"


def test_single_line_grounded_short_exception_is_soft_only() -> None:
    service = ResumeLayoutService(PillowFontMetrics())

    result = service.measure_bullet_fit(
        "Python",
        bullet_id="short",
        item_id="item",
        section_type="experience",
        exception="unfixable_grounded_short",
    )

    assert result.line_count == 1
    assert result.status == "unfixable_grounded_short"


def test_layout_paginates_by_blocks_and_enforces_single_page() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(item_count=10)

    single_page = service.measure_resume_layout(structure, LayoutConstraint(max_pages=1))
    multi_page = service.measure_resume_layout(structure, LayoutConstraint(max_pages=None))

    assert single_page.page_count > 1
    assert single_page.overflow_mm > 0
    assert any(v.code == "page_limit_exceeded" for v in single_page.violations)
    assert multi_page.page_count == single_page.page_count
    assert multi_page.overflow_mm == 0
    assert all(page.blocks for page in multi_page.pages)


def test_single_page_requires_at_least_ninety_percent_usage() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(bullet_text="A" * 75)

    report = service.measure_resume_layout(structure, LayoutConstraint(max_pages=1))

    assert report.page_count == 1
    assert report.pages[0].usage_ratio < 0.90
    assert report.underfill_mm > 0
    assert report.status == "needs_revision"
    assert any(v.code == "page_underfilled" for v in report.violations)


def test_single_page_at_or_above_ninety_percent_has_no_underfill_violation() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure(bullet_text="A" * 75, item_count=6)

    report = service.measure_resume_layout(structure, LayoutConstraint(max_pages=1))

    assert report.page_count == 1
    assert report.pages[0].usage_ratio >= 0.90
    assert report.underfill_mm == 0
    assert report.status == "pass"
    assert all(v.code != "page_underfilled" for v in report.violations)


def test_profile_mismatch_and_summary_never_pass() -> None:
    service = ResumeLayoutService(PillowFontMetrics())
    structure = _structure()
    structure["layout_profile_hash"] = "unknown"
    sections = structure["sections"]
    assert isinstance(sections, list)
    sections.insert(0, {"id": "summary", "type": "summary", "heading": "总结", "items": []})

    report = service.measure_resume_layout(structure)

    assert report.status == "profile_mismatch"
    assert {violation.code for violation in report.violations} >= {
        "profile_mismatch",
        "summary_forbidden",
    }
