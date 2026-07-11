from __future__ import annotations

from app.infra.files.storage import LocalFileStorage


async def test_local_storage_strips_path_components_from_uploaded_filename(tmp_path) -> None:
    storage = LocalFileStorage(str(tmp_path))

    saved = await storage.save(b"resume", "file-1_../../outside.txt", "user-1")

    assert saved.endswith("file-1_.._.._outside.txt") is False
    assert (tmp_path / "user-1" / "outside.txt").read_bytes() == b"resume"
    assert not (tmp_path / "outside.txt").exists()


async def test_local_storage_normalizes_windows_path_components(tmp_path) -> None:
    storage = LocalFileStorage(str(tmp_path))

    saved = await storage.save(b"resume", r"folder\resume.pdf", "user-1")

    assert saved.endswith("resume.pdf")
    assert (tmp_path / "user-1" / "resume.pdf").exists()
