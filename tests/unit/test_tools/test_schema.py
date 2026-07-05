import pytest
from pydantic import ValidationError

from app.tools.registry import get
from app.tools.schema import to_anthropic_tool, to_openai_tool, validate_tool_input


def test_openai_schema_uses_tool_input_schema():
    tool = get("list_experiences")

    schema = to_openai_tool(tool)

    assert schema["type"] == "function"
    assert schema["function"]["name"] == "list_experiences"
    assert "limit" in schema["function"]["parameters"]["properties"]


def test_anthropic_schema_uses_tool_input_schema():
    tool = get("get_artifact")

    schema = to_anthropic_tool(tool)

    assert schema["name"] == "get_artifact"
    assert "artifact_id" in schema["input_schema"]["properties"]


def test_validate_tool_input_accepts_json_string():
    tool = get("list_resumes")

    model = validate_tool_input(tool, '{"limit": 5}')

    assert model.limit == 5


def test_validate_tool_input_rejects_bad_args():
    tool = get("list_resumes")

    with pytest.raises(ValidationError):
        validate_tool_input(tool, {"limit": 0})
