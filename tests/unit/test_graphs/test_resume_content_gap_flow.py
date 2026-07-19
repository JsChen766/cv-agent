from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.graphs.resume.nodes import (
    content_gap_node,
    content_gap_route,
    cot_planning_node,
    experience_selection_node,
    fact_check_node,
)
from app.graphs.resume.state import ResumeGenerationState


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
    config: RunnableConfig = {"configurable": {"thread_id": "resume-content-gap"}}
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

    assert resumed["resume_user_action"] == "revise"
    assert "降低 30%" in resumed["relevant_experiences"][0]["content"]


async def test_content_gap_rebuilds_selection_and_budget_from_supplement() -> None:
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("content_gap", content_gap_node)
    builder.add_node("experience_selection", experience_selection_node)
    builder.add_node("cot_planning", cot_planning_node)
    builder.add_edge(START, "content_gap")
    builder.add_conditional_edges(
        "content_gap",
        content_gap_route,
        {"revision": "experience_selection", "fact_check": END, "end": END},
    )
    builder.add_edge("experience_selection", "cot_planning")
    builder.add_edge("cot_planning", END)
    graph = builder.compile(checkpointer=MemorySaver())
    config: RunnableConfig = {
        "configurable": {"thread_id": "resume-content-gap-refresh"}
    }
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

    selected_content = resumed["selected_experiences"][0]["content"]
    assert "数据库迁移" in selected_content
    assert resumed["experience_selection_result"]["selection_reason"] != "stale"
    budget_facts = resumed["content_budget"]["experiences"][0]["facts"]
    budget_text = "\n".join(fact["text"] for fact in budget_facts)
    assert "数据库迁移" in budget_text
    assert "Python 自动化脚本" in budget_text


async def test_content_gap_reprompts_after_incomplete_supplement() -> None:
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("content_gap", content_gap_node)
    builder.add_edge(START, "content_gap")
    builder.add_edge("content_gap", END)
    graph = builder.compile(checkpointer=MemorySaver())
    config: RunnableConfig = {"configurable": {"thread_id": "resume-content-gap-retry"}}
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
    assert payload["validation_error"] == "缺少有效的经历 ID 或具体事实。"
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

    assert resumed["resume_user_action"] == "revise"
    assert "缓存预热" in resumed["relevant_experiences"][0]["content"]


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
