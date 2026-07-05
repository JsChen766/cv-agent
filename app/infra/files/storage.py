from __future__ import annotations

from pathlib import Path
from typing import Protocol


class FileStorage(Protocol):
    async def save(self, content: bytes, filename: str, user_id: str) -> str: ...
    async def get(self, path: str) -> bytes: ...
    async def delete(self, path: str) -> None: ...


class LocalFileStorage:
    """Development storage — saves files to a local directory."""

    def __init__(self, base_dir: str = "./uploads") -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    async def save(self, content: bytes, filename: str, user_id: str) -> str:
        user_dir = self._base / user_id
        user_dir.mkdir(parents=True, exist_ok=True)
        dest = user_dir / filename
        dest.write_bytes(content)
        return str(dest)

    async def get(self, path: str) -> bytes:
        return Path(path).read_bytes()

    async def delete(self, path: str) -> None:
        p = Path(path)
        if p.exists():
            p.unlink()


def get_storage() -> FileStorage:
    """Factory — swap out for S3 in production via config."""
    return LocalFileStorage()
