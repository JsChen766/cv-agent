from langchain_core.messages import AIMessage

from app.providers.base import ToolCall
from app.providers.openai_format import _chat_result_from_ai_message


def test_openai_tool_call_parser_reads_langchain_ai_message():
    message = AIMessage(
        content="",
        tool_calls=[
            {
                "id": "call-1",
                "name": "list_resumes",
                "args": {"limit": 1},
            }
        ],
    )

    result = _chat_result_from_ai_message(message)

    assert result.tool_calls == [
        ToolCall(id="call-1", name="list_resumes", arguments={"limit": 1})
    ]
