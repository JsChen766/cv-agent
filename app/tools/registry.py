from __future__ import annotations

from app.tools.base import Tool

_registry: dict[str, Tool] = {}


def register(tool: Tool) -> None:
    _registry[tool.name] = tool


def get_all() -> list[Tool]:
    return list(_registry.values())


def get(name: str) -> Tool:
    if name not in _registry:
        raise KeyError(f"Tool not found: {name}")
    return _registry[name]


def get_names() -> list[str]:
    return list(_registry.keys())


# ── Auto-import all tool modules to trigger registration ──────────────────────
def _load_all() -> None:
    import importlib
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
        try:
            importlib.import_module(module)
        except ImportError:
            pass  # tool not yet implemented — skip silently
