from app.main import app


def test_copilot_chat_and_stream_are_documented_in_openapi():
    schema = app.openapi()

    chat = schema["paths"]["/v1/copilot/chat"]["post"]
    stream = schema["paths"]["/v1/copilot/chat/stream"]["post"]

    chat_content = chat["responses"]["200"]["content"]["application/json"]
    assert "examples" in chat_content
    assert "normal" in chat_content["examples"]
    assert "confirmationRequired" in chat_content["examples"]

    stream_content = stream["responses"]["200"]["content"]["text/event-stream"]
    assert "examples" in stream_content
    assert "activity" in stream_content["examples"]
    assert "agent.activity.updated" in stream_content["examples"]["activity"]["value"]
    assert "tool" in stream_content["examples"]
    assert "interrupt" in stream_content["examples"]
