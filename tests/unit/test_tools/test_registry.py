from app.tools.registry import get, get_all, get_names


def test_registry_lazy_loads_tools():
    names = get_names()

    assert "list_experiences" in names
    assert "save_jd" in names
    assert len(get_all()) >= 9


def test_registered_tools_have_input_schema():
    for name in get_names():
        tool = get(name)

        assert tool.input_schema.model_json_schema()["type"] == "object"
        assert tool.name == name
