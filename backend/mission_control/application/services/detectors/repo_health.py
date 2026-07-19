from __future__ import annotations

from mission_control.application.services.detectors.base import (
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
)
from mission_control.infrastructure.database.models import Repository

KIND = "repo_health"
_LARGE_FILE_BYTES = 5_000_000


class RepoHealthDetector:
    kind = KIND

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]:
        if not ctx.repositories:
            raise DetectorSkipped("No repositories are configured for this project")
        drafts: list[FindingDraft] = []
        for repo in ctx.repositories:
            missing = await self._missing_gitignore(ctx, repo)
            if missing is not None:
                drafts.append(missing)
            large = await self._large_tracked_files(ctx, repo)
            if large is not None:
                drafts.append(large)
        return drafts

    async def _missing_gitignore(
        self, ctx: DetectorContext, repo: Repository
    ) -> FindingDraft | None:
        outcome = await ctx.run_command(repo, "test -f .gitignore")
        if outcome.exit_code == 0:
            return None
        return FindingDraft(
            detector_kind=KIND,
            severity="low",
            title=f"Missing .gitignore in {repo.name}",
            dedupe_key=f"{repo.id}:missing_gitignore",
            detail="The repository has no .gitignore, risking accidental commits.",
            evidence={},
            repository_id=repo.id,
            proposed_objective={
                "title": f"Add a .gitignore to {repo.name}",
                "description": (
                    "Add a .gitignore appropriate to the repository's stack to prevent "
                    "build artifacts and secrets from being committed."
                ),
                "test_hint": "Confirm .gitignore exists and build artifacts are ignored.",
            },
        )

    async def _large_tracked_files(
        self, ctx: DetectorContext, repo: Repository
    ) -> FindingDraft | None:
        # List tracked blobs with sizes; awk keeps only files above the threshold.
        command = (
            "git ls-tree -r -l HEAD | "
            f"awk '$4 > {_LARGE_FILE_BYTES} {{print $4, $5}}' | sort -rn | head -20"
        )
        outcome = await ctx.run_command(repo, command)
        listing = outcome.stdout.strip()
        if not listing:
            return None
        return FindingDraft(
            detector_kind=KIND,
            severity="medium",
            title=f"Large files tracked in {repo.name}",
            dedupe_key=f"{repo.id}:large_files",
            detail="Large tracked files (bytes, path):\n" + listing,
            evidence={"count": len(listing.splitlines())},
            repository_id=repo.id,
            proposed_objective={
                "title": f"Reduce large tracked files in {repo.name}",
                "description": (
                    "Large binaries are tracked in Git, bloating clones. Move them to "
                    "artifact storage or Git LFS and remove them from history where safe."
                ),
                "test_hint": "Confirm the large files are no longer tracked.",
            },
        )
