from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from app.domain.jd.models import JdRecord, JdRequirement
from app.domain.resume.models import (
    Resume,
    ResumeItem,
    ResumeItemCreate,
    ResumeVariant,
    ResumeVariantCreate,
)
from app.graphs.jd.nodes import jd_persist_node, parse_requirements_node
from app.graphs.resume.nodes import output_node, persist_resume_draft_node
from app.graphs.resume.state import ResumeGenerationState
from app.tools.base import ServiceContainer


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
        source_thread_id: str | None = None,
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
            source_thread_id=source_thread_id,
            created_at=now,
            updated_at=now,
        )
        self.created = record
        return record


async def test_jd_graph_persists_saved_jd_and_returns_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """parse_requirements_node extracts requirements; jd_persist_node writes to DB when confirmed."""
    service = _FakeJdService()
    services = ServiceContainer.model_construct(jd=service)
    monkeypatch.setattr("app.graphs.jd.nodes.get_provider", lambda: _FakeJdProvider())

    # Step 1: parse_requirements_node only extracts, does NOT persist
    parse_result = await parse_requirements_node(
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
    assert service.created is None, "parse_requirements_node must NOT persist"
    extracted = cast("dict[str, list[dict[str, str]]]", parse_result["extracted_params"])
    assert extracted["requirements"][0]["text"] == "Python backend development"

    # Step 2: jd_persist_node writes to DB when confirmed
    persist_result = await jd_persist_node(
        {
            "user_id": "user-1",
            "thread_id": "thread-test",
            "jd_confirmed": True,
            "jd_candidate": {
                "title": "高级后端工程师",
                "company": "Acme",
                "target_role": "Backend Engineer",
                "raw_text": "高级后端工程师，要求 Python、FastAPI、PostgreSQL。",
                "requirements": extracted["requirements"],
            },
            "extracted_params": extracted,
            "workspace": {},
            "pending_sse_events": [],
        },
        {"configurable": {"services": services}},
    )

    assert service.created is not None
    assert persist_result["workspace"] == {"jd_id": "jd-1"}
    assert "已加入 JD 匹配记录" in persist_result["assistant_message"]
    assert service.created.source_thread_id == "thread-test"


class _FakeResumeService:
    def __init__(self) -> None:
        self.created_resume_id: str | None = None
        self.resume: Resume | None = None
        self.variant: ResumeVariant | None = None

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
        self.resume = Resume(
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
        return self.resume

    async def save_variant(self, resume_id: str, data: ResumeVariantCreate) -> ResumeVariant:
        self.variant = ResumeVariant(
            id="variant-1",
            resume_id=resume_id,
            jd_id=data.jd_id,
            title=data.title,
            content=data.content,
            score=data.score,
            evidence_summary=data.evidence_summary,
            risk_summary=data.risk_summary,
            missing_info=data.missing_info,
            gate_status=data.gate_status,
            quality_issues=data.quality_issues,
            quality_gate_version=data.quality_gate_version,
            created_at=datetime.now(UTC),
        )
        return self.variant

    async def get_variant(self, variant_id: str) -> ResumeVariant:
        assert self.variant is not None and self.variant.id == variant_id
        return self.variant

    async def get_acceptable_variant(self, user_id: str, variant_id: str) -> ResumeVariant:
        variant = await self.get_variant(variant_id)
        assert variant.gate_status == "passed"
        return variant

    async def get_resume(self, user_id: str, resume_id: str) -> Resume:
        assert self.resume is not None and self.resume.id == resume_id
        return self.resume

    async def add_item(self, user_id: str, resume_id: str, data: ResumeItemCreate) -> ResumeItem:
        assert self.resume is not None and self.resume.id == resume_id
        now = datetime.now(UTC)
        item = ResumeItem(
            id="item-1",
            resume_id=resume_id,
            section_type=data.section_type,
            title=data.title,
            content_snapshot=data.content_snapshot,
            order_index=data.order_index,
            source_experience_id=data.source_experience_id,
            source_variant_id=data.source_variant_id,
            created_at=now,
            updated_at=now,
        )
        self.resume.items.append(item)
        return item


async def test_resume_draft_persists_before_output_interrupt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _FakeResumeService()
    services = ServiceContainer.model_construct(resume=service)
    monkeypatch.setattr("langgraph.types.interrupt", lambda payload: {"confirmed": True})

    persisted = await persist_resume_draft_node(
        {
            "user_id": "user-1",
            "workspace": {"jd_id": "jd-1"},
            "variants": [{"title": "Draft", "content": "Resume markdown"}],
            "pending_sse_events": [],
            "quality_status": "passed",
        },
        {"configurable": {"services": services}},
    )

    assert service.created_resume_id == "resume-1"
    assert persisted["workspace"] == {"jd_id": "jd-1", "resume_id": "resume-1"}
    result = await output_node(
        {
            "user_id": "user-1",
            "workspace": persisted["workspace"],
            "variants": persisted["variants"],
            "pending_sse_events": [],
            "quality_status": "passed",
        },
        {"configurable": {"services": services}},
    )
    assert result["workspace"] == {"jd_id": "jd-1", "resume_id": "resume-1"}
    pending_events = cast("list[dict[str, Any]]", result["pending_sse_events"])
    # The final candidate is emitted once, then the review interrupt exposes it via `resume`.
    assert pending_events[0]["event"] == "content.diff.started"
    interrupt_event = pending_events[-1]
    assert interrupt_event["variants"] == []
    assert interrupt_event["resume"] is not None
    assert interrupt_event["resume"]["id"] == "variant-1"
    assert interrupt_event["resume"]["title"] == "Draft"


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
        "quality_status": "passed",
    }
    config: RunnableConfig = {"configurable": {"thread_id": thread_id}}

    result = await graph.ainvoke(state, config=config)

    assert "__interrupt__" in result, "Graph should have interrupted, but __interrupt__ is missing"

    state_after = await graph.aget_state(config)
    assert state_after.next, "Graph state should have a pending interrupt after suspension"

    from langgraph.types import Command

    resume_result = await graph.ainvoke(Command(resume={"confirmed": True}), config=config)
    assert resume_result.get("assistant_message") == "Resume review confirmed."
    assert resume_result.get("workspace") == {"jd_id": "jd-1"}


async def test_resume_review_accept_saves_variant_and_consumes_interrupt() -> None:
    service = _FakeResumeService()
    services = ServiceContainer.model_construct(resume=service)
    checkpointer = MemorySaver()
    builder = StateGraph(ResumeGenerationState)
    builder.add_node("persist_draft", persist_resume_draft_node)
    builder.add_node("output", output_node)
    builder.add_edge(START, "persist_draft")
    builder.add_edge("persist_draft", "output")
    builder.add_edge("output", END)
    graph = builder.compile(checkpointer=checkpointer)
    config: RunnableConfig = {
        "configurable": {
            "thread_id": "test-resume-accept",
            "services": services,
        }
    }

    interrupted = await graph.ainvoke(
        {
            "user_id": "user-1",
            "workspace": {"jd_id": "jd-1"},
            "variants": [{"title": "Draft", "content": "Resume markdown"}],
            "pending_sse_events": [],
            "quality_status": "passed",
        },
        config=config,
    )

    assert interrupted["workspace"] == {"jd_id": "jd-1", "resume_id": "resume-1"}
    assert interrupted["__interrupt__"][0].value["workspace"]["resume_id"] == "resume-1"

    from langgraph.types import Command

    accepted = await graph.ainvoke(
        Command(
            resume={
                "action": "accept",
                "selected_variant_id": "variant-1",
            }
        ),
        config=config,
    )

    assert "__interrupt__" not in accepted
    assert accepted["workspace"]["resume_item_id"] == "item-1"
    assert service.resume is not None
    assert [item.source_variant_id for item in service.resume.items] == ["variant-1"]
