"""Detect sensible default run and test commands for a repository."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DetectedCommands:
    test_command: str | None
    app_command: str | None


def _package_scripts(repository: Path) -> dict[str, object]:
    manifest = repository / "package.json"
    if not manifest.is_file():
        return {}
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    scripts = payload.get("scripts") if isinstance(payload, dict) else None
    return scripts if isinstance(scripts, dict) else {}


def detect_commands(repository_path: str | Path) -> DetectedCommands:
    """Inspect a repository tree and propose test and app commands.

    The commands must run with the toolchains available in the provider
    gateway image (PHP CLI with Composer, and Node with npm).
    """
    repository = Path(repository_path)
    if (repository / "artisan").is_file() and (repository / "composer.json").is_file():
        return DetectedCommands(
            test_command="php artisan test",
            app_command="php artisan serve --host 0.0.0.0 --port $PORT",
        )
    scripts = _package_scripts(repository)
    return DetectedCommands(
        test_command="npm test" if "test" in scripts else None,
        app_command="npm run dev -- --host 0.0.0.0 --port $PORT" if "dev" in scripts else None,
    )
