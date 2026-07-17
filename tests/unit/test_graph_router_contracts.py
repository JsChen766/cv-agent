from typing import cast

from app.graphs.router import RouterOutput, _normalize_llm_routing, router_node


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


async def test_router_prioritizes_resume_generation_over_jd_reference() -> None:
    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "请根据当前激活的 JD 和我的经历，生成一份针对后端岗位的简历。",
                    "turn_id": None,
                }
            ],
            "workspace": {"jd_id": "jd-1"},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "resume_generation"


async def test_router_prioritizes_application_package_over_experience_import() -> None:
    message = (
        "Generate a complete application package and resume from this job description. "
        "Use my saved experience records and also include a cover letter. "
        + "Backend platform engineering requirements with Python and PostgreSQL. " * 6
    )

    result = await router_node(
        {
            "messages": [{"role": "user", "content": message, "turn_id": None}],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "application_package"


class _MisroutingProvider:
    async def chat_structured(self, messages, schema, *, temperature=0.2):
        return schema.model_validate(
            {
                "target_subgraph": "jd",
                "intent_description": "Save the job description.",
                "confidence": 0.95,
            }
        )


async def test_router_corrects_llm_jd_route_for_explicit_resume_request(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.router._heuristic_route", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.graphs.router.get_provider", lambda: _MisroutingProvider())

    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "根据这个 JD 帮我生成一版简历。",
                    "turn_id": None,
                }
            ],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "resume_generation"


async def test_router_honors_validated_resume_generation_hint(monkeypatch) -> None:
    monkeypatch.setattr("app.graphs.router._heuristic_route", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.graphs.router.get_provider", lambda: _MisroutingProvider())

    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "请按目标岗位处理我的材料。",
                    "turn_id": None,
                }
            ],
            "workspace": {},
            "routing_hint": "resume_generation",
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "resume_generation"


def test_low_confidence_specialized_route_is_normalized_to_clarify() -> None:
    routing = RouterOutput(
        target_subgraph="resume_generation",
        intent_description="Maybe edit something",
        confidence=0.4,
    )

    assert _normalize_llm_routing(routing).target_subgraph == "clarify"


def test_fuzzy_specialized_route_is_normalized_to_open_ended() -> None:
    routing = RouterOutput(
        target_subgraph="artifact",
        intent_description="Possibly write something",
        confidence=0.65,
    )

    assert _normalize_llm_routing(routing).target_subgraph == "open_ended"


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


async def test_router_routes_uploaded_file_to_experience_import_without_llm() -> None:
    result = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "please handle this",
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
    assert result["router_confidence"] == 0.98
    extracted = cast("dict[str, str]", result["extracted_params"])
    assert extracted["raw_text"] == "Parsed resume experience from the uploaded file."


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


async def test_router_clarifies_bare_jd_save_instruction_without_content() -> None:
    result = await router_node(
        {
            "messages": [
                {"role": "user", "content": "帮我保存一个 JD", "turn_id": None}
            ],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "clarify"


async def test_router_clarifies_bare_experience_save_instruction_without_content() -> None:
    result = await router_node(
        {
            "messages": [
                {"role": "user", "content": "帮我添加一段工作经历", "turn_id": None}
            ],
            "workspace": {},
            "pending_sse_events": [],
        }
    )

    assert result["target_subgraph"] == "clarify"


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


# ---------------------------------------------------------------------------
# Multi-turn routing regression: same thread, different intents
# Verifies that a stale extracted_params from a prior upload turn does NOT
# hijack routing in subsequent turns (the _build_initial_state fix clears
# extracted_params to {} at the start of every turn).
# ---------------------------------------------------------------------------


async def test_multi_turn_upload_then_jd_then_resume_generation() -> None:
    """Turn 1: file upload → experience_import (extracted_params populated).
    Turn 2: JD pasted, extracted_params cleared to {} → jd.
    Turn 3: resume generation request, extracted_params cleared to {} → resume_generation.
    """
    # --- Turn 1: file attached, extracted_params has upload data ---
    turn1 = await router_node(
        {
            "messages": [
                {"role": "user", "content": "帮我导入这份简历", "turn_id": "t1"}
            ],
            "workspace": {"file_id": "file-abc"},
            "extracted_params": {
                "raw_text": "Work: Senior Engineer at Acme Corp 2020-2024",
                "source": "uploaded_file",
                "file_id": "file-abc",
            },
            "pending_sse_events": [],
        }
    )
    assert turn1["target_subgraph"] == "experience_import", (
        f"Turn 1 should route to experience_import, got {turn1['target_subgraph']}"
    )

    # --- Turn 2: no file this turn; _build_initial_state sets extracted_params={} ---
    # Simulates what happens after the fix: checkpointer stale value is overwritten.
    turn2 = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "这是我要投的 JD：高级后端工程师，要求 Python FastAPI PostgreSQL。帮我保存这个 JD。",
                    "turn_id": "t2",
                }
            ],
            "workspace": {},
            # extracted_params cleared to {} by _build_initial_state (the fix)
            "extracted_params": {},
            "pending_sse_events": [],
        }
    )
    assert turn2["target_subgraph"] == "jd", (
        f"Turn 2 should route to jd, got {turn2['target_subgraph']}. "
        "Likely cause: stale extracted_params['source']=='uploaded_file' not cleared."
    )

    # --- Turn 3: resume generation request ---
    turn3 = await router_node(
        {
            "messages": [
                {
                    "role": "user",
                    "content": "根据这个 JD 帮我生成一版简历",
                    "turn_id": "t3",
                }
            ],
            "workspace": {},
            # extracted_params cleared to {} by _build_initial_state (the fix)
            "extracted_params": {},
            "pending_sse_events": [],
        }
    )
    assert turn3["target_subgraph"] == "resume_generation", (
        f"Turn 3 should route to resume_generation, got {turn3['target_subgraph']}"
    )
