from __future__ import annotations

from mission_control.application.services.detectors.base import (
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
)
from mission_control.application.services.repair_proposals import propose_repair

KIND = "documentation_drift"
_DEFAULT_THRESHOLD = 10


class DocumentationDriftDetector:
    kind = KIND

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]:
        if not ctx.repositories:
            raise DetectorSkipped("No repositories are configured for this project")
        threshold = ctx.config.get("commit_threshold")
        threshold = int(threshold) if isinstance(threshold, int) else _DEFAULT_THRESHOLD
        drafts: list[FindingDraft] = []
        for repo in ctx.repositories:
            doc_probe = await ctx.run_command(
                repo, "git log -1 --format=%H -- README.md"
            )
            last_doc_sha = doc_probe.stdout.strip()
            if not last_doc_sha:
                # No README history to compare against; nothing to drift from.
                continue
            count_probe = await ctx.run_command(
                repo, f"git rev-list --count {last_doc_sha}..HEAD"
            )
            raw_count = count_probe.stdout.strip()
            if not raw_count.isdigit():
                continue
            commits_since = int(raw_count)
            if commits_since < threshold:
                continue
            changed = await ctx.run_command(
                repo, f"git diff --name-only {last_doc_sha}..HEAD"
            )
            changed_files = changed.stdout.strip()
            problem = (
                f"README.md in {repo.name} has not been updated in {commits_since} "
                "commits while code around it changed. The documentation may be stale."
            )
            proposal, invocation_ids = await propose_repair(
                ctx,
                problem=problem,
                context=f"Files changed since the last README update:\n{changed_files[:5000]}",
                default_title=f"Refresh documentation in {repo.name}",
            )
            drafts.append(
                FindingDraft(
                    detector_kind=KIND,
                    severity="low",
                    title=f"Documentation may be drifting in {repo.name}",
                    dedupe_key=f"{repo.id}",
                    detail=problem,
                    evidence={
                        "commits_since_doc_update": commits_since,
                        "last_doc_sha": last_doc_sha,
                    },
                    proposed_objective=proposal,
                    repository_id=repo.id,
                    invocation_ids=invocation_ids,
                )
            )
        return drafts
