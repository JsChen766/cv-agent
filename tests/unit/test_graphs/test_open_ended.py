from unittest.mock import AsyncMock

from app.graphs.open_ended import open_ended_node
from app.providers.base import ChatResult, ToolCall
from app.tools.base import ServiceContainer


class FakeProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def chat_with_tools(self, messages, tools, **kwargs):
        self.calls += 1
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
    assert [event["event"] for event in result["pending_sse_events"]] == [
        "agent.tool.started",
        "agent.tool.completed",
        "agent.message.completed",
    ]
