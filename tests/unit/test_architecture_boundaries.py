from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"


def _imports_under(folder: str) -> list[tuple[Path, str]]:
    imports: list[tuple[Path, str]] = []
    for path in (APP_ROOT / folder).rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                imports.append((path, node.module))
            elif isinstance(node, ast.Import):
                imports.extend((path, alias.name) for alias in node.names)
    return imports


def test_core_does_not_depend_on_application_layers() -> None:
    violations = [
        (path, module)
        for path, module in _imports_under("core")
        if module.startswith("app.")
    ]
    assert violations == []


def test_domain_has_no_framework_or_infrastructure_imports() -> None:
    forbidden = ("fastapi", "langgraph", "asyncpg", "sqlalchemy", "app.infra")
    violations = [
        (path, module)
        for path, module in _imports_under("domain")
        if module.startswith(forbidden)
    ]
    assert violations == []


def test_graphs_and_tools_do_not_import_infrastructure() -> None:
    violations = [
        (path, module)
        for folder in ("graphs", "tools")
        for path, module in _imports_under(folder)
        if module.startswith("app.infra")
    ]
    assert violations == []


def test_providers_do_not_depend_on_tools_layer() -> None:
    violations = [
        (path, module)
        for path, module in _imports_under("providers")
        if module.startswith("app.tools")
    ]
    assert violations == []
