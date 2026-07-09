from typing import cast

from app.graphs.router import router_node


async def test_router_node_uses_preset_route_without_llm() -> None:
    result = await router_node(
        {
            "target_subgraph": "resume_generation",
            "intent_description": "Generate resume from selected JD",
            "artifact_type": None,
            "context_hints": [],
            "extracted_params": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "resume_generation"
    assert result["intent_description"] == "Generate resume from selected JD"
    assert result["router_confidence"] == 1.0
    assert result["pending_sse_events"] == [
        {
            "event": "agent.route.completed",
            "target": "resume_generation",
            "intent_description": "Generate resume from selected JD",
            "confidence": 1.0,
        }
    ]


async def test_router_routes_chinese_save_experience_without_llm() -> None:
    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "保存这段项目经历：我在支付系统项目负责风控规则引擎和监控告警。",
                    "turn_id": None,
                }
            ],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "experience_import"
    assert result["router_confidence"] == 0.95
    extracted = cast("dict[str, str]", result["extracted_params"])
    assert extracted["raw_text"].startswith("保存这段项目经历")


async def test_router_preserves_uploaded_raw_text_for_experience_import() -> None:
    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "save this experience",
                    "turn_id": None,
                }
            ],
            "workspace": {"file_id": "file-1"},
            "extracted_params": {
                "raw_text": "Parsed resume experience from the uploaded file.",
                "source": "uploaded_file",
                "file_id": "file-1",
            },
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "experience_import"
    extracted = cast("dict[str, str]", result["extracted_params"])
    assert extracted["raw_text"] == "Parsed resume experience from the uploaded file."
    assert extracted["source"] == "uploaded_file"
    assert extracted["file_id"] == "file-1"


async def test_router_routes_chinese_save_jd_without_llm() -> None:
    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "帮我保存这个 JD：高级后端工程师，要求 Python、FastAPI、PostgreSQL。",
                    "turn_id": None,
                }
            ],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "jd"
    extracted = cast("dict[str, str]", result["extracted_params"])
    assert extracted["raw_text"].startswith("帮我保存这个 JD")


async def test_router_prioritizes_explicit_jd_over_responsibility_words() -> None:
    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "HR发来的岗位描述：资深产品经理，负责AI Agent工作台，要求B端SaaS和数据分析。帮我保存成JD。",
                    "turn_id": None,
                }
            ],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "jd"


async def test_router_respects_not_my_experience_negation() -> None:
    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "别把这个当我的经历，保存这个职位：后端负责人，要求FastAPI、PostgreSQL、异步任务和监控。",
                    "turn_id": None,
                }
            ],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "jd"


async def test_router_routes_self_intro_artifact_without_llm() -> None:
    result = await router_node(
        {
            "messages": [{"role": "user", "content": "帮我写一版中文自我介绍", "turn_id": None}],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "artifact"
    assert result["artifact_type"] == "self_intro"
