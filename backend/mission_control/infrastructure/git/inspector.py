from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path

from mission_control.core.config import Settings, get_settings


@dataclass(frozen=True, slots=True)
class RepositoryInspection:
    path: str
    branch: str
    commit_sha: str
    clean: bool
    technology: tuple[str, ...]


class RepositoryInspector:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.root = Path(self.settings.repository_root).resolve()

    async def resolve_relative_path(self, relative_path: str) -> Path:
        candidate = Path(relative_path)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError("Repository path must be relative to the configured repository root")
        target = (self.root / candidate).resolve(strict=True)
        if not target.is_dir() or not self._inside_root(target):
            raise ValueError("Repository path is outside the configured repository root")
        return target

    async def inspect_relative(self, relative_path: str) -> RepositoryInspection:
        return await self.inspect(await self.resolve_relative_path(relative_path))

    async def inspect(self, path: Path) -> RepositoryInspection:
        target = path.resolve(strict=True)  # noqa: ASYNC240 - subprocess boundary is async; filesystem check is small.
        if not target.is_dir() or not self._inside_root(target):
            raise ValueError("Repository path is outside the configured repository root")

        top_level = await self._git(target, "rev-parse", "--show-toplevel")
        if Path(top_level).resolve() != target:  # noqa: ASYNC240
            raise ValueError("Path must point to the root of a Git repository")
        branch = await self._git(target, "branch", "--show-current")
        commit_sha = await self._git(target, "rev-parse", "HEAD")
        status = await self._git(target, "status", "--porcelain=v1")
        return RepositoryInspection(
            path=str(target),
            branch=branch or "HEAD",
            commit_sha=commit_sha,
            clean=not bool(status),
            technology=self._detect_technology(target),
        )

    async def archive(self, path: Path) -> bytes:
        """Return a zip of the files tracked at HEAD (untracked files excluded)."""
        target = path.resolve(strict=True)  # noqa: ASYNC240 - subprocess boundary is async; filesystem check is small.
        if not target.is_dir() or not self._inside_root(target):
            raise ValueError("Repository path is outside the configured repository root")
        return await self._git_bytes(
            target, "archive", "--format=zip", "HEAD", timeout_seconds=60
        )

    async def commit_diff(self, path: Path, commit_sha: str) -> str:
        """Return the stat and patch for one commit against its parent."""
        target = path.resolve(strict=True)  # noqa: ASYNC240 - subprocess boundary is async; filesystem check is small.
        if not target.is_dir() or not self._inside_root(target):
            raise ValueError("Repository path is outside the configured repository root")
        if not re.fullmatch(r"[0-9a-f]{7,64}", commit_sha):
            raise ValueError("Commit reference is not a valid SHA")
        return await self._git(
            target, "show", "--stat", "--patch", "--no-color", commit_sha
        )

    def _inside_root(self, path: Path) -> bool:
        try:
            path.relative_to(self.root)
        except ValueError:
            return False
        return True

    async def _git(self, path: Path, *args: str) -> str:
        return (await self._git_bytes(path, *args)).decode().strip()

    async def _git_bytes(self, path: Path, *args: str, timeout_seconds: float = 10) -> bytes:
        process = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            str(path),
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=timeout_seconds
            )
        except TimeoutError as error:
            process.kill()
            await process.wait()
            raise ValueError("Git command timed out") from error
        if process.returncode != 0:
            detail = stderr.decode().strip() or "Git command failed"
            raise ValueError(detail)
        return stdout

    @staticmethod
    def _detect_technology(path: Path) -> tuple[str, ...]:
        markers = {
            "artisan": "Laravel",
            "manage.py": "Django",
            "composer.json": "PHP",
            "package.json": "Node.js",
            "next.config.js": "Next.js",
            "next.config.ts": "Next.js",
            "pyproject.toml": "Python",
            "Cargo.toml": "Rust",
            "go.mod": "Go",
        }
        detected = {
            technology for marker, technology in markers.items() if (path / marker).exists()
        }
        return tuple(sorted(detected))
