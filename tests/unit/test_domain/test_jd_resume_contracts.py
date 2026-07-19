from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

from app.domain.jd.models import JdRecord, JdRequirement, JdRequirementDraft
from app.domain.jd.service import JdService
from app.domain.resume.models import (
    Resume,
    ResumeItem,
    ResumeItemPatch,
    ResumeVariant,
    ResumeVariantPatch,
)
from app.domain.resume.service import ResumeService


async def test_create_jd_passes_source_thread_id_to_repository() -> None:
    repo = MagicMock()

    async def create_jd_row(*args: object, **kwargs: object) -> JdRecord:
        assert kwargs.get("source_thread_id") == "thread-xyz"
        return JdRecord(
            id="jd-2",
            user_id="user-1",
            title="ML Engineer",
            raw_text="Train models",
            requirements=[],
            source_thread_id="thread-xyz",
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

    repo.create = AsyncMock(side_effect=create_jd_row)
    service = JdService(repo)

    result = await service.create_jd(
        "user-1",
        title="ML Engineer",
        raw_text="Train models",
        source_thread_id="thread-xyz",
    )

    assert result.source_thread_id == "thread-xyz"


async def test_create_jd_generates_requirement_id_when_missing() -> None:
    repo = MagicMock()
    repo.create = AsyncMock()

    async def create_jd_row(*args: object, **kwargs: object) -> JdRecord:
        requirements = kwargs["requirements"]
        assert isinstance(requirements, list)
        assert requirements[0].id.startswith("req-")
        return JdRecord(
            id="jd-1",
            user_id="user-1",
            title="Backend Engineer",
            raw_text="Build APIs",
            requirements=requirements,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

    repo.create.side_effect = create_jd_row
    service = JdService(repo)

    result = await service.create_jd(
        "user-1",
        title="Backend Engineer",
        raw_text="Build APIs",
        requirements=[JdRequirementDraft(text="FastAPI", importance="high")],
    )

    assert result.requirements[0].text == "FastAPI"
    assert result.requirements[0].importance == "high"


async def test_manual_requirements_bypass_parser_and_detach_cache() -> None:
    repo = MagicMock()
    requirement_maps = MagicMock()

    async def create_jd_row(*args: object, **kwargs: object) -> JdRecord:
        assert kwargs["requirements_origin"] == "manual"
        assert kwargs["requirement_map_id"] is None
        assert isinstance(kwargs["jd_hash"], str)
        requirements = kwargs["requirements"]
        assert isinstance(requirements, list)
        return JdRecord(
            id="jd-manual",
            user_id="user-1",
            title="Backend Engineer",
            raw_text="Build APIs",
            requirements=requirements,
            jd_hash=kwargs["jd_hash"],
            requirements_origin="manual",
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

    repo.create = AsyncMock(side_effect=create_jd_row)
    service = JdService(repo, requirement_maps)

    result = await service.create_jd(
        "user-1",
        title="Backend Engineer",
        raw_text="Build APIs",
        requirements=[JdRequirementDraft(text="Python")],
        requirement_map_id="rmap-must-not-survive",
    )

    requirement_maps.resolve.assert_not_called()
    assert result.requirements_origin == "manual"


async def test_ensure_requirement_map_lazily_upgrades_legacy_jd() -> None:
    legacy = JdRecord(
        id="jd-legacy",
        user_id="user-1",
        title="Legacy",
        raw_text="Build APIs",
        requirements=[JdRequirement(id="legacy-1", text="APIs")],
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    parsed = legacy.model_copy(
        update={
            "jd_hash": "hash-1",
            "requirement_map_id": "rmap-1",
            "requirements_origin": "parsed",
        }
    )
    repo = MagicMock()
    repo.get = AsyncMock(return_value=legacy)
    repo.update_analysis = AsyncMock(return_value=parsed)
    requirement_maps = MagicMock()
    requirement_maps.resolve = AsyncMock()

    from datetime import UTC

    from app.domain.jd.requirement_map.models import (
        Requirement,
        RequirementMap,
        RequirementMapResolution,
    )

    now = datetime.now(UTC)
    requirement_maps.resolve.return_value = RequirementMapResolution(
        requirement_map=RequirementMap(
            requirement_map_id="rmap-1",
            user_id="user-1",
            jd_hash="hash-1",
            normalization_version="norm-v1",
            schema_version="schema-v1",
            parser_version="parser-v1",
            parser_model="test-model",
            requirements=(
                Requirement(
                    requirement_id="req-api",
                    description="Build APIs",
                    category="responsibility",
                    importance="must_have",
                    keywords=("API",),
                    weight=0.85,
                ),
            ),
            created_at=now,
            updated_at=now,
        ),
        cache_hit=False,
        normalized_length=10,
    )
    service = JdService(repo, requirement_maps)

    result = await service.ensure_requirement_map("user-1", "jd-legacy")

    assert result.requirement_map_id == "rmap-1"
    requirement_maps.resolve.assert_awaited_once_with("user-1", "Build APIs")
    repo.update_analysis.assert_awaited_once()


async def test_resume_item_update_by_id_uses_user_item_lookup() -> None:
    item = ResumeItem(
        id="item-1",
        resume_id="resume-1",
        section_type="experience",
        title="Old",
        content_snapshot="content",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    updated = item.model_copy(update={"title": "New"})
    repo = MagicMock()
    repo.get_item_for_user = AsyncMock(return_value=item)
    repo.update_item = AsyncMock(return_value=updated)
    service = ResumeService(repo)
    patch = ResumeItemPatch(title="New")

    result = await service.update_item_by_id("user-1", "item-1", patch)

    assert result.title == "New"
    repo.get_item_for_user.assert_awaited_once_with("user-1", "item-1")
    repo.update_item.assert_awaited_once_with("user-1", "item-1", patch)


async def test_resume_variant_update_checks_resume_ownership_before_write() -> None:
    now = datetime.now()
    variant = ResumeVariant(
        id="variant-1",
        resume_id="resume-1",
        title="Original",
        content="# Original",
        created_at=now,
    )
    resume = Resume(
        id="resume-1",
        user_id="user-1",
        title="Resume",
        created_at=now,
        updated_at=now,
    )
    patch = ResumeVariantPatch(content="# Edited")
    updated = variant.model_copy(update={"content": "# Edited"})
    repo = MagicMock()
    repo.get_variant = AsyncMock(return_value=variant)
    repo.get = AsyncMock(return_value=resume)
    repo.update_variant = AsyncMock(return_value=updated)
    service = ResumeService(repo)

    result = await service.update_variant("user-1", "variant-1", patch)

    assert result.content == "# Edited"
    repo.get.assert_awaited_once_with("user-1", "resume-1")
    repo.update_variant.assert_awaited_once_with("user-1", "variant-1", patch)
