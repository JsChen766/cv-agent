from __future__ import annotations

import importlib

from app.tools.base import Tool

_registry: dict[str, Tool] = {}
_loaded = False


def register(tool: Tool) -> None:
    _registry[tool.name] = tool


def get_all() -> list[Tool]:
    _ensure_loaded()
    return list(_registry.values())


def get(name: str) -> Tool:
    _ensure_loaded()
    if name not in _registry:
        raise KeyError(f"Tool not found: {name}")
    return _registry[name]


def get_names() -> list[str]:
    _ensure_loaded()
    return list(_registry.keys())


def get_by_names(names: list[str]) -> list[Tool]:
    return [get(name) for name in names]


def _load_all() -> None:
    tool_modules = [
        "app.tools.experience.list_tool",
        "app.tools.experience.get_tool",
        "app.tools.experience.save_tool",
        "app.tools.experience.import_text_tool",
        "app.tools.jd.list_tool",
        "app.tools.jd.save_tool",
        "app.tools.resume.list_tool",
        "app.tools.artifact.create_tool",
        "app.tools.artifact.get_tool",
    ]
    for module in tool_modules:
        importlib.import_module(module)


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    _load_all()
    _loaded = True
