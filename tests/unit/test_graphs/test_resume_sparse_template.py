from __future__ import annotations

from app.domain.resume.layout_service import ResumeLayoutService
from app.domain.resume.layout_templates import SPARSE_RESUME_TEMPLATE, SPARSE_TEMPLATE_ID
from app.graphs.resume.nodes import layout_measure_node
from app.infra.layout import PillowFontMetrics
from app.tools.base import ServiceContainer
from tests.unit.test_domain.test_resume_layout import _structure


async def test_layout_measure_selects_sparse_profile_for_genuinely_sparse_content(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.graphs.resume.nodes.settings.resume_sparse_template_enabled", True
    )
    structured = _structure(bullet_text="A" * 68)
    structured["sections"][0]["items"][0]["bullets"] = structured["sections"][0][
        "items"
    ][0]["bullets"][:1]
    layout = ResumeLayoutService(PillowFontMetrics())

    result = await layout_measure_node(
        {
            "variants": [{"id": "variant-1", "structured": structured}],
            "resume_candidate_pool": structured,
            "layout_constraint": {
                "max_pages": 1,
                "minimum_page_usage_ratio": 0.8,
                "target_page_usage_ratio": 0.88,
                "maximum_page_usage_ratio": 0.95,
            },
        },
        {"configurable": {"services": ServiceContainer.model_construct(resume_layout=layout)}},
    )

    assert result["layout_template_id"] == SPARSE_TEMPLATE_ID
    assert result["layout_profile_version"] == SPARSE_RESUME_TEMPLATE.profile.version
    assert result["layout_constraint"]["minimum_page_usage_ratio"] == 0.52
    assert result["resume_structure"]["layout_template_id"] == SPARSE_TEMPLATE_ID
    assert not any(
        issue["code"] == "profile_mismatch" for issue in result["layout_report"]["violations"]
    )
