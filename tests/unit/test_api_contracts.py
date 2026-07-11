from datetime import datetime

import pytest
from pydantic import JsonValue, ValidationError

from app.api.routes.copilot import (
    ActionPayload,
    ActionType,
    ExportResumePayload,
    GenerateArtifactPayload,
    GenerateResumeFromJdPayload,
    OptimizeResumeItemPayload,
    RewriteExperiencePayload,
    VariantPayload,
)
from app.api.routes.product.jd import _serialize
from app.domain.jd.models import JdRecord


def test_action_payload_parses_supported_generate_artifact_action() -> None:
    action = ActionPayload(
        type="generate_artifact",
        payload={"artifactType": "self_intro", "instruction": "Draft a short intro"},
    )

    payload = action.payload_model()

    assert isinstance(payload, GenerateArtifactPayload)
    assert payload.artifactType == "self_intro"


@pytest.mark.parametrize(
    ("action_type", "raw_payload", "expected_model"),
    [
        (
            "optimize_resume_item",
            {"resumeItemId": "item-1", "instruction": "tighten"},
            OptimizeResumeItemPayload,
        ),
        (
            "rewrite_experience",
            {"experienceId": "exp-1", "instruction": "make bullets"},
            RewriteExperiencePayload,
        ),
        ("generate_resume_from_jd", {"jdId": "jd-1"}, GenerateResumeFromJdPayload),
        ("accept_variant", {"variantId": "variant-1"}, VariantPayload),
        ("show_evidence", {"variantId": "variant-1"}, VariantPayload),
        (
            "generate_artifact",
            {"artifactType": "self_intro", "instruction": "draft"},
            GenerateArtifactPayload,
        ),
        ("export_resume", {"resumeId": "resume-1"}, ExportResumePayload),
    ],
)
def test_action_payload_parses_all_supported_action_subtypes(
    action_type: ActionType,
    raw_payload: dict[str, JsonValue],
    expected_model: type[object],
) -> None:
    action = ActionPayload(type=action_type, payload=raw_payload)

    payload = action.payload_model()

    assert isinstance(payload, expected_model)


def test_action_payload_rejects_missing_required_fields() -> None:
    with pytest.raises(ValidationError):
        ActionPayload(type="generate_artifact", payload={})


def test_action_payload_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        ActionPayload(
            type="generate_artifact",
            payload={"artifactType": "self_intro", "unexpected": "nope"},
        )


def test_jd_serialize_includes_source_thread_id() -> None:
    jd = JdRecord(
        id="jd-1",
        user_id="user-1",
        title="Backend Engineer",
        raw_text="Build APIs",
        requirements=[],
        source_thread_id="thread-abc",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    data = _serialize(jd)
    assert data["sourceThreadId"] == "thread-abc"


def test_jd_serialize_source_thread_id_none_when_absent() -> None:
    jd = JdRecord(
        id="jd-2",
        user_id="user-1",
        title="Frontend Engineer",
        raw_text="Build UIs",
        requirements=[],
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    data = _serialize(jd)
    assert "sourceThreadId" in data
    assert data["sourceThreadId"] is None
