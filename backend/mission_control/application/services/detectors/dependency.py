from __future__ import annotations

import json

from mission_control.application.services.detectors.base import (
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
)
from mission_control.infrastructure.database.models import Repository

KIND = "dependency_maintenance"
_MAX_LISTED = 25


async def _file_exists(ctx: DetectorContext, repo: Repository, path: str) -> bool:
    outcome = await ctx.run_command(repo, f"test -f {path}")
    return outcome.exit_code == 0


def _parse_npm(raw: str) -> list[str]:
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []
    entries = []
    for name, info in data.items():
        if not isinstance(info, dict):
            continue
        entries.append(f"{name}: {info.get('current')} -> {info.get('latest')}")
    return entries


def _parse_pip(raw: str) -> list[str]:
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [
        f"{item.get('name')}: {item.get('version')} -> {item.get('latest_version')}"
        for item in data
        if isinstance(item, dict)
    ]


class DependencyMaintenanceDetector:
    kind = KIND

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]:
        if not ctx.repositories:
            raise DetectorSkipped("No repositories are configured for this project")
        drafts: list[FindingDraft] = []
        checked = 0
        for repo in ctx.repositories:
            for ecosystem, manifest, command, parser in (
                ("npm", "package.json", "npm outdated --json", _parse_npm),
                (
                    "pip",
                    "requirements.txt",
                    "pip list --outdated --format=json",
                    _parse_pip,
                ),
            ):
                if not await _file_exists(ctx, repo, manifest):
                    continue
                checked += 1
                outcome = await ctx.run_command(repo, command)
                if outcome.timed_out:
                    continue
                outdated = parser(outcome.stdout)
                if not outdated:
                    continue
                listed = outdated[:_MAX_LISTED]
                detail = "\n".join(f"- {item}" for item in listed)
                if len(outdated) > _MAX_LISTED:
                    detail += f"\n- ...and {len(outdated) - _MAX_LISTED} more"
                drafts.append(
                    FindingDraft(
                        detector_kind=KIND,
                        severity="medium" if len(outdated) > 10 else "low",
                        title=(
                            f"{len(outdated)} outdated {ecosystem} dependencies in {repo.name}"
                        ),
                        dedupe_key=f"{repo.id}:{ecosystem}",
                        detail=detail,
                        evidence={"ecosystem": ecosystem, "count": len(outdated)},
                        repository_id=repo.id,
                        proposed_objective={
                            "title": f"Update outdated {ecosystem} dependencies in {repo.name}",
                            "description": (
                                "Review and safely upgrade the outdated dependencies below, "
                                "keeping the test suite green.\n\n" + detail
                            ),
                            "test_hint": "Run the project test suite after upgrading.",
                        },
                    )
                )
        if checked == 0:
            raise DetectorSkipped("No supported dependency manifests were found")
        return drafts
