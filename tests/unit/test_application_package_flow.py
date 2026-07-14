from __future__ import annotations

from typing import Any

import pytest

from app.api.routes.copilot import _resume_canvas_metadata
from app.graphs.application.nodes import (
    generate_application_artifacts_node,
    plan_application_package_node,
)
from app.graphs.resume.nodes import context_assembly_node, output_node
from app.graphs.router import router_node

_JD_WITH_SELF_INTRO = """
华夏基金 ETF 产品运营实习生。
岗位要求：熟悉基金产品，具备数据分析能力，每周到岗五天。
应聘方式：请将简历发送至招聘邮箱，邮件主题和附件按姓名＋学校命名，
并附上100字左右的自我介绍。另请自行调研最新ETF市场规模并附研究结论。
公司会按简历投递顺序安排面试。
根据这个JD来写简历
""".strip()


async def test_router_sends_pasted_jd_resume_request_to_application_package() -> None:
    result = await router_node(
        {
            "messages": [{"role": "user", "content": _JD_WITH_SELF_INTRO, "turn_id": None}],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "application_package"
    assert result["extracted_params"] == {"raw_jd_text": _JD_WITH_SELF_INTRO}


class _PlanProvider:
    async def chat_structured(self, messages, schema, **kwargs):
        return schema.model_validate(
            {
                "requirements": [
                    {
                        "artifact_type": "self_intro",
                        "title": "100字自我介绍",
                        "requirement_text": "附上100字左右的自我介绍",
                        "instruction": "生成约100字中文自我介绍",
                        "supported": True,
                        "order": 1,
                    },
                    {
                        "artifact_type": "other",
                        "title": "ETF市场研究",
                        "requirement_text": "调研最新ETF市场规模",
                        "instruction": "联网研究最新ETF市场规模",
                        "supported": False,
                        "reason": "当前 Agent 不具备外部研究能力",
                        "order": 2,
                    },
                ]
            }
        )


async def test_package_plan_keeps_supported_and_reports_unsupported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.graphs.application.nodes.get_provider", lambda: _PlanProvider())
    result = await plan_application_package_node(
        {
            "messages": [{"role": "user", "content": _JD_WITH_SELF_INTRO, "turn_id": None}],
            "jd_text": _JD_WITH_SELF_INTRO,
            "pending_sse_events": [],
        }
    )

    tasks = result["application_tasks"]
    unsupported = result["unsupported_requirements"]
    assert [task["artifact_type"] for task in tasks] == ["self_intro", "other"]
    assert "约100个中文字符" in tasks[0]["instruction"]
    assert tasks[1]["title"] == "邮件与附件命名"
    unsupported_titles = {item["title"] for item in unsupported}
    assert "外部研究要求" in unsupported_titles
    assert "实际发送或投递" in unsupported_titles


async def test_resume_context_uses_pasted_jd_without_saved_jd() -> None:
    result = await context_assembly_node(
        {
            "extracted_params": {"raw_jd_text": _JD_WITH_SELF_INTRO},
            "workspace": {},
        },
        None,
    )
    assert result["jd_text"] == _JD_WITH_SELF_INTRO


async def test_package_artifacts_are_collected_and_failures_do_not_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_artifact_node(state: dict[str, Any], config=None) -> dict[str, object]:
        if state["artifact_type"] == "other":
            raise RuntimeError("unsupported generator")
        return {
            "artifact_content": "我是候选人，具备ETF运营和数据分析经验。",
            "workspace": {"artifact_id": "artifact-1"},
        }

    monkeypatch.setattr(
        "app.graphs.application.nodes.artifact_draft_node",
        fake_artifact_node,
    )
    result = await generate_application_artifacts_node(
        {
            "application_tasks": [
                {
                    "artifact_type": "self_intro",
                    "title": "自我介绍",
                    "requirement_text": "100字自我介绍",
                    "instruction": "写100字自我介绍",
                    "order": 1,
                },
                {
                    "artifact_type": "other",
                    "title": "投递说明",
                    "requirement_text": "生成投递说明",
                    "instruction": "生成投递说明",
                    "order": 2,
                },
            ],
            "unsupported_requirements": [],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["application_deliverables"][0]["artifact_id"] == "artifact-1"
    assert result["application_deliverables"][0]["status"] == "completed"
    assert result["unsupported_requirements"][0]["status"] == "failed"


async def test_resume_output_combines_package_deliverables(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_interrupt(payload: dict[str, Any]) -> dict[str, str]:
        captured.update(payload)
        return {"action": "discard"}

    monkeypatch.setattr("langgraph.types.interrupt", fake_interrupt)
    await output_node(
        {
            "target_subgraph": "application_package",
            "variants": [{"id": "variant-1", "title": "Resume", "content": "# Resume"}],
            "application_deliverables": [
                {
                    "kind": "artifact",
                    "artifact_type": "self_intro",
                    "artifact_id": "artifact-1",
                    "title": "自我介绍",
                    "content": "介绍内容",
                    "status": "completed",
                }
            ],
            "unsupported_requirements": [
                {"title": "外部研究", "supported": False, "reason": "能力范围外"}
            ],
            "workspace": {"resume_id": "resume-1"},
            "pending_sse_events": [],
        }
    )

    assert captured["type"] == "application_package_review"
    assert captured["deliverables"][0]["artifact_type"] == "self_intro"
    assert captured["variants"][0]["content"] == "# Resume"
    assert captured["unsupported_requirements"][0]["title"] == "外部研究"


def test_package_canvas_metadata_persists_additional_deliverables() -> None:
    metadata = _resume_canvas_metadata(
        {
            "type": "application_package_review",
            "variants": [
                {
                    "id": "variant-1",
                    "resume_id": "resume-1",
                    "title": "Resume",
                    "content": "# Resume",
                    "score": {},
                }
            ],
            "deliverables": [
                {
                    "artifact_type": "self_intro",
                    "title": "自我介绍",
                    "content": "介绍内容",
                }
            ],
            "unsupported_requirements": [],
        },
        {},
    )

    assert metadata is not None
    assert metadata["resume_id"] == "resume-1"
    assert metadata["application_deliverables"][0]["artifact_type"] == "self_intro"
