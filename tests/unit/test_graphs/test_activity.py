from app.graphs.activity import (
    activity_from_interrupt,
    activity_from_node_event,
    activity_from_tool_event,
)


def test_self_review_projects_to_resume_reviewer():
    event = activity_from_node_event(
        "self_review",
        "running",
        thread_id="thread-1",
        turn_id="turn-1",
        sequence=1,
    )

    assert event is not None
    assert event["event"] == "agent.activity.updated"
    assert event["agent_role"] == "resume_reviewer"
    assert event["agent_label"] == "简历质检员"
    assert event["status"] == "running"


def test_experience_tool_projects_tool_metadata():
    event = activity_from_tool_event(
        {"event": "agent.tool.started", "tool": "save_experience"},
        thread_id="thread-1",
        turn_id="turn-1",
        sequence=2,
    )

    assert event is not None
    assert event["agent_role"] == "experience_orchestrator"
    assert event["tool"] == {
        "name": "save_experience",
        "label": "保存经历",
        "status": "running",
    }


def test_resume_review_interrupt_projects_waiting_user():
    event = activity_from_interrupt(
        {"type": "resume_review"},
        thread_id="thread-1",
        turn_id="turn-1",
        sequence=3,
    )

    assert event["agent_role"] == "resume_reviewer"
    assert event["status"] == "waiting_user"
