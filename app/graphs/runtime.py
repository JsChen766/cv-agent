from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.tools.base import ServiceContainer


def services_from_config(config: RunnableConfig | None) -> ServiceContainer | None:
    configurable = (config or {}).get("configurable", {})
    services = configurable.get("services")
    return services if isinstance(services, ServiceContainer) else None


def pool_from_config(config: RunnableConfig | None):
    configurable = (config or {}).get("configurable", {})
    return configurable.get("pool")
