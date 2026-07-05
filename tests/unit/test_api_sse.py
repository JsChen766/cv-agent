import json

from app.api.sse import stream_graph_events


class FakeGraph:
    async def astream_events(self, initial_state, config, version):
        yield {"event": "on_chain_start", "name": "router", "data": {}}
        yield {"event": "on_chain_end", "name": "router", "data": {"output": {}}}
        yield {
            "event": "on_chain_end",
            "name": "open_ended",
            "data": {
                "output": {
                    "pending_sse_events": [
                        {"event": "agent.tool.started", "tool": "list_resumes", "input": {}}
                    ]
                }
            },
        }


async def test_stream_graph_events_projects_activity_events():
    initial_state = {
        "thread_id": "thread-1",
        "current_turn_id": "turn-1",
        "messages": [],
        "workspace": {},
        "pending_sse_events": [],
    }

    chunks = [
        chunk async for chunk in stream_graph_events(FakeGraph(), initial_state, config={})
    ]
    payloads = [_payload(chunk) for chunk in chunks]
    activity_events = [
        payload for payload in payloads if payload["event"] == "agent.activity.updated"
    ]

    assert activity_events[0]["agent_role"] == "frontdesk"
    assert activity_events[0]["status"] == "running"
    assert activity_events[0]["thread_id"] == "thread-1"
    assert activity_events[0]["turn_id"] == "turn-1"
    assert any(event.get("tool", {}).get("name") == "list_resumes" for event in activity_events)


def _payload(chunk: str) -> dict:
    data_line = next(line for line in chunk.splitlines() if line.startswith("data: "))
    return json.loads(data_line.removeprefix("data: "))
