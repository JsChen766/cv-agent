from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeVar, cast

from langchain_core.runnables import RunnableConfig

from app.core.observability import current_recorder
from app.domain.resume.observability_models import ResumeGenerationRunStart, RunTrigger
from app.graphs.runtime import services_from_config, trace_from_config
from app.tools.base import ToolResult
from app.tools.schema import summarize_tool_result

logger = logging.getLogger(__name__)


def thinking(text: str) -> dict[str, Any]:
    return {"event": "agent.thinking", "text": text}


def node_started(node: str, description: str) -> dict[str, Any]:
    return {"event": "agent.node.started", "node": node, "description": description}


def node_completed(node: str, duration_ms: int) -> dict[str, Any]:
    return {"event": "agent.node.completed", "node": node, "duration_ms": duration_ms}


def tool_started(tool: str, input: dict[str, Any]) -> dict[str, Any]:
    return {"event": "agent.tool.started", "tool": tool, "input": input}


def tool_completed(tool: str, result: ToolResult) -> dict[str, Any]:
    return {
        "event": "agent.tool.completed",
        "tool": tool,
        "result_summary": summarize_tool_result(result),
    }


def tool_failed(tool: str, error: str) -> dict[str, Any]:
    return {"event": "agent.tool.failed", "tool": tool, "error": error}


StateT = TypeVar("StateT", bound=Mapping[str, Any])
NodeResult = dict[str, object]


def traced_node(
    node_name: str,
    node: Callable[..., Awaitable[NodeResult]],
) -> Callable[..., Awaitable[NodeResult]]:
    """Wrap a graph node once, preserving exceptions and interrupt semantics."""
    accepts_config = "config" in inspect.signature(node).parameters

    async def wrapped(
        state: StateT, config: RunnableConfig | None = None
    ) -> NodeResult:
        recorder = trace_from_config(config) or current_recorder()
        if recorder is None:
            return await node(state, config=config) if accepts_config else await node(state)
        services = services_from_config(config)
        observability = services.resume_observability if services is not None else None
        if observability is not None and recorder.claim_persist_start():
            try:
                await observability.start_run(
                    ResumeGenerationRunStart(
                        id=recorder.run_id,
                        user_id=str(state.get("user_id") or ""),
                        request_id=recorder.request_id,
                        thread_id=recorder.thread_id,
                        turn_id=recorder.turn_id,
                        parent_run_id=recorder.parent_run_id,
                        trigger=cast("RunTrigger", recorder.trigger),
                        trace_version=recorder.trace_version,
                        provider=recorder.provider,
                        model=recorder.model,
                        started_at=recorder.started_at,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                recorder.telemetry_persist_failed = True
                logger.warning("Resume trace start failed for %s: %s", recorder.run_id, exc)
        with recorder.activate(node=node_name), recorder.span("nodes", node_name):
            return await node(state, config=config) if accepts_config else await node(state)

    # Do not use functools.wraps here. inspect.signature() follows __wrapped__,
    # which would hide this wrapper's config parameter for nodes whose original
    # function accepts only state. LangGraph would then omit RunnableConfig and
    # those node/LLM spans would silently disappear from the request trace.
    wrapped.__name__ = getattr(node, "__name__", node_name)
    wrapped.__doc__ = getattr(node, "__doc__", None)
    # This module uses postponed annotations, while LangGraph inspects the
    # concrete runtime annotation to decide whether to inject RunnableConfig.
    wrapped.__annotations__["config"] = RunnableConfig | None
    return cast("Callable[..., Awaitable[NodeResult]]", wrapped)
