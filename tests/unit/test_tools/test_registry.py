import pytest

from app.tools.registry import get, get_all, get_names, register


def test_registry_lazy_loads_tools() -> None:
    names = get_names()

    assert "list_experiences" in names
    assert "save_jd" in names
    assert "generate_resume_from_jd" not in names
    assert "accept_variant" in names
    assert len(get_all()) >= 15


def test_registered_tools_have_input_schema() -> None:
    for name in get_names():
        tool = get(name)

        assert tool.input_schema.model_json_schema()["type"] == "object"
        assert tool.name == name


def test_registry_rejects_duplicate_tool_names() -> None:
    existing = get("list_jds")
    duplicate = type("DuplicateTool", (), {**vars(type(existing)), "name": "list_jds"})()

    with pytest.raises(ValueError, match="already registered"):
        register(duplicate)
