from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

from app.domain.jd.models import JdRecord, JdRequirementDraft
from app.domain.jd.service import JdService
from app.domain.resume.models import ResumeItem, ResumeItemPatch
from app.domain.resume.service import ResumeService


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
