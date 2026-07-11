from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from app.tools.actions.capabilities import generate_artifact
from app.tools.actions.models import GenerateArtifactInput
from app.tools.base import ServiceContainer


class _Provider:
    def __init__(self) -> None:
        self.messages = []

    async def chat(self, messages, **kwargs):
        self.messages = messages
        return "# Grounded cover letter"


async def test_explicit_artifact_action_assembles_owned_jd_and_experience_context(
    monkeypatch,
) -> None:
    provider = _Provider()
    monkeypatch.setattr("app.tools.actions.capabilities.get_provider", lambda: provider)
    jd = SimpleNamespace(id="jd-1", title="Backend Engineer", raw_text="Python role")
    revision = SimpleNamespace(content="Built a payment API handling 1M requests/day")
    experience = SimpleNamespace(
        id="exp-1",
        title="Engineer",
        organization="Acme",
        current_revision=revision,
    )
    artifact = SimpleNamespace(id="artifact-1", title="Cover Letter", word_count=3)
    services = ServiceContainer.model_construct(
        jd=SimpleNamespace(get_jd=AsyncMock(return_value=jd)),
        experience=SimpleNamespace(get_experience=AsyncMock(return_value=experience)),
        user=SimpleNamespace(
            get_profile=AsyncMock(return_value=SimpleNamespace(preferred_language="en-US"))
        ),
        preference=SimpleNamespace(get_active_preferences=AsyncMock(return_value=[])),
        artifact=SimpleNamespace(create_artifact=AsyncMock(return_value=artifact)),
        resume=MagicMock(),
    )

    result = await generate_artifact(
        services,
        "user-1",
        GenerateArtifactInput(artifactType="cover_letter"),
        base_workspace={"jd_id": "jd-1", "experience_ids": ["exp-1"]},
    )

    prompt = provider.messages[-1]["content"]
    assert "Python role" in prompt
    assert "1M requests/day" in prompt
    assert result.workspace["artifact_id"] == "artifact-1"
    create_data = services.artifact.create_artifact.call_args.args[1]
    assert create_data["source_jd_id"] == "jd-1"
    assert create_data["source_experience_ids"] == ["exp-1"]
