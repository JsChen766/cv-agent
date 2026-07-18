from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.core.observability import TraceRecorder
from app.tools.base import ServiceContainer


def services_from_config(config: RunnableConfig | None) -> ServiceContainer | None:
    configurable = (config or {}).get("configurable", {})
    services = configurable.get("services")
    return services if isinstance(services, ServiceContainer) else None


def trace_from_config(config: RunnableConfig | None) -> TraceRecorder | None:
    configurable = (config or {}).get("configurable", {})
    recorder = configurable.get("trace_recorder")
    return recorder if isinstance(recorder, TraceRecorder) else None


def pool_from_config(config: RunnableConfig | None) -> object | None:
    configurable = (config or {}).get("configurable", {})
    return configurable.get("pool")


def thread_id_from_config(config: RunnableConfig | None) -> str | None:
    configurable = (config or {}).get("configurable", {})
    value = configurable.get("thread_id")
    return str(value) if value else None


def thread_repo_from_config(config: RunnableConfig | None) -> object | None:
    """Return the pre-instantiated ThreadRepository from configurable, or None."""
    configurable = (config or {}).get("configurable", {})
    return configurable.get("thread_repo")
