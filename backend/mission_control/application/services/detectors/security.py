from __future__ import annotations

import json

from mission_control.application.services.detectors.base import (
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
)
from mission_control.infrastructure.database.models import Repository

KIND = "security_health"

# Conservative, low-false-positive secret patterns.
_SECRET_PATTERN = (
    r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|"
    r"ghp_[0-9A-Za-z]{36}|xox[baprs]-[0-9A-Za-z-]{10,})"
)


async def _file_exists(ctx: DetectorContext, repo: Repository, path: str) -> bool:
    outcome = await ctx.run_command(repo, f"test -f {path}")
    return outcome.exit_code == 0


def _npm_audit_summary(raw: str) -> tuple[int, int]:
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return (0, 0)
    meta = data.get("metadata") if isinstance(data, dict) else None
    vulns = meta.get("vulnerabilities") if isinstance(meta, dict) else None
    if not isinstance(vulns, dict):
        return (0, 0)
    high = int(vulns.get("high", 0) or 0)
    critical = int(vulns.get("critical", 0) or 0)
    return (high, critical)


class SecurityHealthDetector:
    kind = KIND

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]:
        if not ctx.repositories:
            raise DetectorSkipped("No repositories are configured for this project")
        drafts: list[FindingDraft] = []
        for repo in ctx.repositories:
            drafts.extend(await self._audit_npm(ctx, repo))
            secret = await self._scan_secrets(ctx, repo)
            if secret is not None:
                drafts.append(secret)
        return drafts

    async def _audit_npm(
        self, ctx: DetectorContext, repo: Repository
    ) -> list[FindingDraft]:
        if not await _file_exists(ctx, repo, "package.json"):
            return []
        outcome = await ctx.run_command(repo, "npm audit --json")
        if outcome.timed_out:
            return []
        high, critical = _npm_audit_summary(outcome.stdout)
        if high == 0 and critical == 0:
            return []
        severity = "critical" if critical else "high"
        return [
            FindingDraft(
                detector_kind=KIND,
                severity=severity,
                title=(
                    f"{critical} critical / {high} high npm vulnerabilities in {repo.name}"
                ),
                dedupe_key=f"{repo.id}:npm_audit",
                detail="Run `npm audit` for the full report.",
                evidence={"high": high, "critical": critical},
                repository_id=repo.id,
                proposed_objective={
                    "title": f"Remediate npm vulnerabilities in {repo.name}",
                    "description": (
                        f"`npm audit` reports {critical} critical and {high} high "
                        "advisories. Upgrade the affected packages without breaking the "
                        "build."
                    ),
                    "test_hint": "Run `npm audit` and the test suite after upgrading.",
                },
            )
        ]

    async def _scan_secrets(
        self, ctx: DetectorContext, repo: Repository
    ) -> FindingDraft | None:
        outcome = await ctx.run_command(
            repo, f"git grep -nIE '{_SECRET_PATTERN}' -- . ':!*.lock'"
        )
        matches = outcome.stdout.strip()
        if not matches:
            return None
        lines = matches.splitlines()
        return FindingDraft(
            detector_kind=KIND,
            severity="critical",
            title=f"Possible committed secret in {repo.name}",
            dedupe_key=f"{repo.id}:secret_scan",
            detail="Potential secrets detected:\n" + "\n".join(lines[:20]),
            evidence={"match_count": len(lines)},
            repository_id=repo.id,
            proposed_objective={
                "title": f"Remove and rotate committed secrets in {repo.name}",
                "description": (
                    "A secret-like value appears to be committed. Remove it from the "
                    "code and history, rotate the credential, and add it to ignored "
                    "configuration."
                ),
                "test_hint": "Confirm the secret no longer appears in `git grep`.",
            },
        )
