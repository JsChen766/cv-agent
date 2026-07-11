from copy import deepcopy
from unittest.mock import AsyncMock

from pydantic import BaseModel

from app.graphs.open_ended import _confirm_and_execute_tool, open_ended_node
from app.providers.base import ChatResult, ToolCall
from app.tools.base import ServiceContainer, ToolContext
from app.tools.executor import ToolConfirmationRequired


class FakeProvider:
    def __init__(self) -> None:
        self.calls = 0
        self.message_snapshots = []

    async def chat_with_tools(self, messages, tools, **kwargs):
        self.calls += 1
        self.message_snapshots.append(deepcopy(messages))
        if self.calls == 1:
            return ChatResult(
                tool_calls=[
                    ToolCall(id="call-1", name="list_resumes", arguments={"limit": 1})
                ]
            )
        return ChatResult(content="You have no saved resumes.")


async def test_open_ended_executes_low_risk_tool(monkeypatch):
    provider = FakeProvider()
    resume_service = type("ResumeService", (), {})()
    resume_service.list_resumes = AsyncMock(return_value=([], None))
    services = ServiceContainer.model_construct(
        experience=object(),
        jd=object(),
        resume=resume_service,
        artifact=object(),
        preference=object(),
        user=object(),
    )
    state = {
        "thread_id": "thread-1",
        "user_id": "user-1",
        "messages": [{"role": "user", "content": "List my resumes"}],
        "pending_sse_events": [],
    }
    config = {"configurable": {"thread_id": "thread-1", "services": services}}
    monkeypatch.setattr("app.graphs.open_ended.get_provider", lambda: provider)

    result = await open_ended_node(state, config)

    assert result["assistant_message"] == "You have no saved resumes."
    assert resume_service.list_resumes.await_count == 1
    second_messages = provider.message_snapshots[1]
    assert second_messages[-2]["role"] == "assistant"
    assert second_messages[-2]["tool_calls"][0]["id"] == "call-1"
    assert second_messages[-1]["role"] == "tool"
    assert second_messages[-1]["tool_call_id"] == "call-1"
    assert [event["event"] for event in result["pending_sse_events"]] == [
        "agent.tool.started",
        "agent.tool.completed",
        "agent.message.completed",
    ]


async def test_confirmation_requires_explicit_affirmative_resume(monkeypatch):
    class Input(BaseModel):
        value: str

    tool = type(
        "WriteTool",
        (),
        {
            "name": "write_tool",
            "execute": AsyncMock(),
        },
    )()
    confirmation = ToolConfirmationRequired(tool, Input(value="data"))
    context = ToolContext.model_construct(user_id="user-1", thread_id="thread-1", services=None)
    monkeypatch.setattr("langgraph.types.interrupt", lambda payload: {"confirmed": False})

    result = await _confirm_and_execute_tool(confirmation, context, [])

    assert result.status == "failed"
    tool.execute.assert_not_awaited()
