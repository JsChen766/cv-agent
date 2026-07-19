from types import SimpleNamespace

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.graphs.resume.nodes import (
    content_gap_node,
    content_gap_route,
    fact_check_node,
)
from app.graphs.resume.state import ResumeGenerationState
from app.tools.base import ServiceContainer


class _ExperienceService:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.revisions: list[tuple[str, str, str]] = []
        self.created: list[dict[str, object]] = []

    async def add_revision(
        self, user_id: str, experience_id: str, content: str, *, source: str
    ) -> SimpleNamespace:
        if self.fail:
            raise RuntimeError("database unavailable")
        self.revisions.append((user_id, experience_id, content))
        return SimpleNamespace(id=f"rev-{len(self.revisions)}")

    async def create_experience(self, user_id: str, **kwargs: object) -> SimpleNamespace:
        if self.fail:
            raise RuntimeError("database unavailable")
        self.created.append({"user_id": user_id, **kwargs})
        revision = SimpleNamespace(id=f"rev-new-{len(self.created)}", factbank_status="pending")
        return SimpleNamespace(
            id=f"exp-new-{len(self.created)}",
            title=kwargs["title"],
            organization=kwargs.get("organization"),
            role=kwargs.get("role"),
            location=kwargs.get("location"),
            category=kwargs["category"],
            start_date=None,
            end_date=None,
            tags=kwargs.get("tags") or [],
            current_revision_id=revision.id,
            current_revision=revision,
        )


def _config(thread_id: str, service: _ExperienceService | None = None) -> RunnableConfig:
    services = ServiceContainer.model_construct(experience=service or _ExperienceService())
    return {"configurable": {"thread_id": thread_id, "services": services}}


def _underfilled_report() -> dict[str, object]:
    return {
        "profile_version": "resume-template-v2",
        "profile_hash": "hash",
        "content_width_mm": 192,
        "page_available_height_mm": 279,
        "page_count": 1,
        "overflow_mm": 0,
        "minimum_page_usage_ratio": 0.80,
        "target_page_usage_ratio": 0.88,
        "maximum_page_usage_ratio": 0.95,
        "underfill_mm": 55.8,
        "pages": [
            {
                "page_number": 1,
                "available_height_mm": 279,
                "used_height_mm": 167.4,
                "usage_ratio": 0.60,
            }
        ],
        "violations": [
            {
                "code": "page_underfilled",
                "message": "Resume uses 60%",
                "severity": "hard",
            }
        ],
        "status": "needs_revision",
    }


async def test_content_gap_interrupt_reports_exact_deficit_and_accepts_supplement() -> None:
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("content_gap", content_gap_node)
    builder.add_edge(START, "content_gap")
    builder.add_edge("content_gap", END)
    graph = builder.compile(checkpointer=MemorySaver())
    config = _config("resume-content-gap")
    state: ResumeGenerationState = {
        "user_id": "user-1",
        "layout_report": _underfilled_report(),
        "layout_constraint": {
            "max_pages": None,
            "requested_pages": 1,
            "minimum_page_usage_ratio": 0.80,
            "target_page_usage_ratio": 0.88,
            "maximum_page_usage_ratio": 0.95,
        },
        "content_budget": {
            "experiences": [
                {
                    "experience_id": "exp-1",
                    "category": "work",
                    "jd_match_score": 0.91,
                }
            ]
        },
        "relevant_experiences": [
            {
                "id": "exp-1",
                "title": "后端开发实习",
                "category": "work",
                "content": "负责 API 开发。",
                "claims": [],
            }
        ],
    }

    interrupted = await graph.ainvoke(state, config=config)
    payload = interrupted["__interrupt__"][0].value

    assert payload["type"] == "resume_content_gap"
    assert payload["current_usage_ratio"] == 0.60
    assert payload["target_usage_ratio"] == 0.80
    assert payload["missing_height_mm"] == 55.8
    assert payload["suggestions"][0]["experience_id"] == "exp-1"

    resumed = await graph.ainvoke(
        Command(
            resume={
                "action": "supplement",
                "experience_id": "exp-1",
                "content": "独立实现缓存模块，将接口响应时间降低 30%。",
            }
        ),
        config=config,
    )

    assert resumed["resume_user_action"] == "reload"
    assert resumed["resume_context_ready"] is False
    assert "降低 30%" in resumed["relevant_experiences"][0]["content"]


async def test_content_gap_invalidates_derived_state_before_full_context_reload() -> None:
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("content_gap", content_gap_node)
    builder.add_edge(START, "content_gap")
    builder.add_conditional_edges(
        "content_gap",
        content_gap_route,
        {"reload": END, "fact_check": END, "failed": END, "end": END},
    )
    graph = builder.compile(checkpointer=MemorySaver())
    config = _config("resume-content-gap-refresh")
    old_experience = {
        "id": "exp-1",
        "title": "数据分析实习生",
        "category": "work",
        "content": "编写复杂 SQL 脚本。",
        "claims": [{"text": "编写复杂 SQL 脚本"}],
    }
    state: ResumeGenerationState = {
        "user_id": "user-1",
        "layout_report": _underfilled_report(),
        "layout_constraint": {
            "max_pages": None,
            "requested_pages": 1,
            "minimum_page_usage_ratio": 0.80,
            "target_page_usage_ratio": 0.88,
            "maximum_page_usage_ratio": 0.95,
        },
        "content_budget": {
            "experiences": [
                {
                    "experience_id": "exp-1",
                    "category": "work",
                    "jd_match_score": 0.91,
                    "facts": [{"id": "exp-1-fact-1", "text": "编写复杂 SQL 脚本"}],
                }
            ]
        },
        "relevant_experiences": [dict(old_experience)],
        # Reproduces the stale derived snapshot that previously shadowed the
        # supplemented relevant_experiences during planning and generation.
        "selected_experiences": [dict(old_experience)],
        "experience_selection_result": {"selection_reason": "stale"},
        "matching_plan": {"strategy": "stale"},
        "variants": [{"id": "stale-variant"}],
        "resume_structure": {"language": "zh-CN", "sections": []},
        "compiled_resume": {"plan_version": "stale"},
        "generation_call_count": 2,
    }

    await graph.ainvoke(state, config=config)
    resumed = await graph.ainvoke(
        Command(
            resume={
                "action": "supplement",
                "experience_id": "exp-1",
                "content": "完成数据库迁移与表对账，并编写 Python 自动化脚本。",
            }
        ),
        config=config,
    )

    assert resumed["resume_user_action"] == "reload"
    assert resumed["resume_context_ready"] is False
    assert resumed["selected_experiences"] == []
    assert resumed["experience_selection_result"] is None
    assert resumed["matching_plan"] is None
    assert resumed["content_budget"] is None
    assert resumed["fact_retrieval_result"] is None
    assert resumed["material_sufficiency_report"] is None
    assert resumed["variants"] == []
    assert resumed["compiled_resume"] is None
    assert resumed["resume_structure"] is None
    assert resumed["previous_structured"] == {"language": "zh-CN", "sections": []}
    assert resumed["generation_call_count"] == 2
    assert resumed["incremental_recalculation"]["affected_experience_ids"] == ["exp-1"]
    assert resumed["incremental_recalculation"]["change_kind"] == ("existing_experience_revision")
    assert "数据库迁移" in resumed["relevant_experiences"][0]["content"]


async def test_content_gap_reprompts_after_incomplete_supplement() -> None:
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("content_gap", content_gap_node)
    builder.add_edge(START, "content_gap")
    builder.add_edge("content_gap", END)
    graph = builder.compile(checkpointer=MemorySaver())
    config = _config("resume-content-gap-retry")
    state: ResumeGenerationState = {
        "user_id": "user-1",
        "layout_report": _underfilled_report(),
        "layout_constraint": {
            "max_pages": None,
            "requested_pages": 1,
            "minimum_page_usage_ratio": 0.80,
            "target_page_usage_ratio": 0.88,
            "maximum_page_usage_ratio": 0.95,
        },
        "content_budget": {
            "experiences": [
                {
                    "experience_id": "exp-1",
                    "category": "work",
                    "jd_match_score": 0.91,
                }
            ]
        },
        "relevant_experiences": [
            {
                "id": "exp-1",
                "title": "后端开发实习",
                "category": "work",
                "content": "负责 API 开发。",
                "claims": [],
            }
        ],
    }

    interrupted = await graph.ainvoke(state, config=config)
    initial_payload = interrupted["__interrupt__"][0].value
    retried = await graph.ainvoke(
        Command(resume={"action": "supplement"}),
        config=config,
    )
    payload = retried["__interrupt__"][0].value

    assert payload["type"] == "resume_content_gap"
    assert payload["validation_error"] == "缺少有效经历 ID，或新经历缺少标题/具体事实。"
    assert payload["interrupt_id"] != initial_payload["interrupt_id"]

    resumed = await graph.ainvoke(
        Command(
            resume={
                "action": "supplement",
                "experience_id": "exp-1",
                "content": "设计缓存预热流程，减少高峰期冷启动请求。",
            }
        ),
        config=config,
    )

    assert resumed["resume_user_action"] == "reload"
    assert "缓存预热" in resumed["relevant_experiences"][0]["content"]


async def test_content_gap_persistence_failure_does_not_reload_or_consume_interaction() -> None:
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("content_gap", content_gap_node)
    builder.add_edge(START, "content_gap")
    builder.add_edge("content_gap", END)
    graph = builder.compile(checkpointer=MemorySaver())
    config = _config("resume-content-gap-persist-failure", _ExperienceService(fail=True))
    state: ResumeGenerationState = {
        "user_id": "user-1",
        "layout_report": _underfilled_report(),
        "relevant_experiences": [
            {
                "id": "exp-1",
                "title": "后端开发实习",
                "category": "work",
                "content": "负责 API 开发。",
                "claims": [],
            }
        ],
    }

    await graph.ainvoke(state, config=config)
    result = await graph.ainvoke(
        Command(
            resume={
                "action": "supplement",
                "experience_id": "exp-1",
                "content": "新增可验证事实",
            }
        ),
        config=config,
    )

    assert result["resume_user_action"] == "failed"
    assert result["quality_issues"][0]["code"] == "experience_revision_persist_failed"
    assert result.get("content_gap_interaction_count", 0) == 0
    assert result.get("resume_context_ready") is not False


async def test_content_gap_classifies_and_persists_new_experience() -> None:
    service = _ExperienceService()
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("content_gap", content_gap_node)
    builder.add_edge(START, "content_gap")
    builder.add_edge("content_gap", END)
    graph = builder.compile(checkpointer=MemorySaver())
    config = _config("resume-content-gap-new-experience", service)
    state: ResumeGenerationState = {
        "user_id": "user-1",
        "layout_report": _underfilled_report(),
        "relevant_experiences": [],
    }

    await graph.ainvoke(state, config=config)
    result = await graph.ainvoke(
        Command(
            resume={
                "action": "supplement",
                "new_experience": {
                    "title": "智能检索项目",
                    "category": "project",
                    "content": "使用 Python 构建混合检索流程并完成离线评测。",
                    "tags": ["Python"],
                },
            }
        ),
        config=config,
    )

    assert result["resume_user_action"] == "reload"
    assert service.created[0]["category"] == "project"
    assert result["incremental_recalculation"]["change_kind"] == "new_experience"
    assert result["incremental_recalculation"]["affected_experience_ids"] == ["exp-new-1"]
    assert result["relevant_experiences"][-1]["id"] == "exp-new-1"


async def test_content_gap_bypasses_interrupt_for_in_band_layout() -> None:
    report = _underfilled_report()
    report["underfill_mm"] = 0
    report["pages"] = [
        {
            "page_number": 1,
            "available_height_mm": 279,
            "used_height_mm": 239.94,
            "usage_ratio": 0.86,
        }
    ]
    report["violations"] = [
        {
            "code": "bullet_awkward_wrap",
            "message": "Awkward wrap",
            "severity": "hard",
        }
    ]

    result = await content_gap_node(
        {
            "layout_report": report,
            "layout_constraint": {
                "requested_pages": 1,
                "minimum_page_usage_ratio": 0.80,
                "target_page_usage_ratio": 0.88,
                "maximum_page_usage_ratio": 0.95,
            },
        }
    )

    assert result["resume_user_action"] == "continue"
    assert content_gap_route(result) == "fact_check"


async def test_fact_check_is_deterministic_and_rejects_unsourced_numbers() -> None:
    result = await fact_check_node(
        {
            "variants": [
                {
                    "structured": {
                        "sections": [
                            {
                                "type": "experience",
                                "items": [
                                    {
                                        "source_experience_id": "exp-1",
                                        "title": "后端开发实习",
                                        "organization": "示例公司",
                                        "role": "实习生",
                                        "start_date": "2025-01",
                                        "end_date": "2025-06",
                                        "bullets": [
                                            {"text": "将响应时间降低 99%。"},
                                        ],
                                    }
                                ],
                            }
                        ]
                    }
                }
            ],
            "relevant_experiences": [
                {
                    "id": "exp-1",
                    "title": "后端开发实习",
                    "organization": "示例公司",
                    "role": "实习生",
                    "start_date": "2025-01",
                    "end_date": "2025-06",
                    "content": "负责 API 开发。",
                    "claims": [],
                    "tags": ["Python"],
                }
            ],
        }
    )

    assert result["fact_mismatches"] == [
        {
            "field": "metric",
            "drafted_value": "99%",
            "source_value": None,
            "experience_title": "后端开发实习",
            "detail": "Numeric claim is absent from the source experience",
        }
    ]
