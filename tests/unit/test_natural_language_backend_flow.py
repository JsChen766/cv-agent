from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

import pytest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from app.domain.jd.models import JdRecord, JdRequirement
from app.domain.resume.models import Resume, ResumeVariant, ResumeVariantCreate
from app.graphs.jd.nodes import parse_requirements_node
from app.graphs.resume.nodes import output_node
from app.graphs.resume.state import ResumeGenerationState
from app.tools.base import ServiceContainer
from langchain_core.runnables import RunnableConfig


class _FakeJdProvider:
    async def chat_structured(
        self,
        messages: list[dict[str, str]],
        schema: type[BaseModel],
        *,
        temperature: float = 0.2,
    ) -> BaseModel:
        return schema.model_validate(
            {
                "requirements": [
                    {
                        "text": "Python backend development",
                        "category": "skill",
                        "importance": "high",
                    }
                ]
            }
        )


class _FakeJdService:
    def __init__(self) -> None:
        self.created: JdRecord | None = None

    async def create_jd(
        self,
        user_id: str,
        *,
        title: str,
        raw_text: str,
        company: str | None = None,
        target_role: str | None = None,
        requirements: list[Any] | None = None,
    ) -> JdRecord:
        now = datetime.now(UTC)
        record = JdRecord(
            id="jd-1",
            user_id=user_id,
            title=title,
            company=company,
            target_role=target_role,
            raw_text=raw_text,
            requirements=[
                JdRequirement.model_validate(
                    req.model_dump() if hasattr(req, "model_dump") else req
                )
                for req in (requirements or [])
            ],
            created_at=now,
            updated_at=now,
        )
        self.created = record
        return record


async def test_jd_graph_persists_saved_jd_and_returns_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _FakeJdService()
    services = ServiceContainer.model_construct(jd=service)
    monkeypatch.setattr("app.graphs.jd.nodes.get_provider", lambda: _FakeJdProvider())

    result = await parse_requirements_node(
        {
            "user_id": "user-1",
            "workspace": {},
            "extracted_params": {
                "raw_text": "高级后端工程师，要求 Python、FastAPI、PostgreSQL。",
                "title": "高级后端工程师",
                "company": "Acme",
                "target_role": "Backend Engineer",
            },
            "pending_sse_events": [],
        },
        {"configurable": {"services": services}},
    )

    assert service.created is not None
    assert result["workspace"] == {"jd_id": "jd-1"}
    assert result["assistant_message"] == "Saved JD '高级后端工程师' with 1 requirement(s)."
    extracted = cast("dict[str, list[dict[str, str]]]", result["extracted_params"])
    assert extracted["requirements"][0]["text"] == "Python backend development"


class _FakeResumeService:
    def __init__(self) -> None:
        self.created_resume_id: str | None = None

    async def create_resume(
        self,
        user_id: str,
        title: str,
        *,
        target_role: str | None = None,
        jd_id: str | None = None,
    ) -> Resume:
        now = datetime.now(UTC)
        self.created_resume_id = "resume-1"
        return Resume(
            id="resume-1",
            user_id=user_id,
            title=title,
            target_role=target_role,
            jd_id=jd_id,
            items=[],
            variants=[],
            created_at=now,
            updated_at=now,
        )

    async def save_variant(self, resume_id: str, data: ResumeVariantCreate) -> ResumeVariant:
        return ResumeVariant(
            id="variant-1",
            resume_id=resume_id,
            jd_id=data.jd_id,
            title=data.title,
            content=data.content,
            score=data.score,
            evidence_summary=data.evidence_summary,
            risk_summary=data.risk_summary,
            missing_info=data.missing_info,
            created_at=datetime.now(UTC),
        )


async def test_resume_output_creates_resume_for_natural_language_flow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _FakeResumeService()
    services = ServiceContainer.model_construct(resume=service)
    monkeypatch.setattr("langgraph.types.interrupt", lambda payload: {"confirmed": True})

    result = await output_node(
        {
            "user_id": "user-1",
            "workspace": {"jd_id": "jd-1"},
            "variants": [{"title": "Draft", "content": "Resume markdown"}],
            "pending_sse_events": [],
        },
        {"configurable": {"services": services}},
    )

    assert service.created_resume_id == "resume-1"
    assert result["workspace"] == {"jd_id": "jd-1", "resume_id": "resume-1"}
    pending_events = cast("list[dict[str, Any]]", result["pending_sse_events"])
    assert pending_events[0]["variants"] == [
        {"id": "variant-1", "title": "Draft", "score": {"overall": 0.0, "relevance": 0.0, "clarity": 0.0, "evidence_strength": 0.0, "quantified_impact": 0.0}}
    ]


async def test_resume_subgraph_interrupt_persisted_via_checkpointer() -> None:
    """Verify that output_node's interrupt() is persisted when subgraph runs with a
    checkpointer — the core fix for natural-language resume generation."""
    checkpointer = MemorySaver()
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("output", output_node)
    builder.add_edge(START, "output")
    builder.add_edge("output", END)
    graph = builder.compile(checkpointer=checkpointer)

    thread_id = "test-resume-interrupt-1"
    state: ResumeGenerationState = {
        "user_id": "user-1",
        "workspace": {"jd_id": "jd-1"},
        "variants": [{"title": "Draft", "content": "Resume markdown"}],
        "pending_sse_events": [],
    }
    config: RunnableConfig = {"configurable": {"thread_id": thread_id}}

    result = await graph.ainvoke(state, config=config)

    assert "__interrupt__" in result, (
        "Graph should have interrupted, but __interrupt__ is missing"
    )

    state_after = await graph.aget_state(config)
    assert state_after.next, "Graph state should have a pending interrupt after suspension"

    from langgraph.types import Command

    resume_result = await graph.ainvoke(Command(resume={"confirmed": True}), config=config)
    assert resume_result.get("assistant_message") == "Resume review confirmed."
    assert resume_result.get("workspace") == {"jd_id": "jd-1"}
