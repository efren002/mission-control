from __future__ import annotations

import json
import uuid

from mission_control.application.services.detectors.base import (
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
    extract_json,
)

KIND = "issue_triage"
_MAX_ISSUES = 15


class IssueTriageDetector:
    kind = KIND

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]:
        if not ctx.repositories:
            raise DetectorSkipped("No repositories are configured for this project")
        # Issue triage depends on an external GitHub source; degrade to a skip
        # (recorded, not an error) whenever the environment cannot provide it.
        gh_available = await ctx.run_command(ctx.repositories[0], "gh --version")
        if not gh_available.ok:
            raise DetectorSkipped("The GitHub CLI is not available")
        drafts: list[FindingDraft] = []
        triaged_any = False
        for repo in ctx.repositories:
            remote = await ctx.run_command(repo, "git remote get-url origin")
            if "github.com" not in remote.stdout:
                continue
            listing = await ctx.run_command(
                repo,
                "gh issue list --state open --json number,title,labels,body "
                f"--limit {_MAX_ISSUES}",
            )
            if not listing.ok:
                continue
            triaged_any = True
            issues = extract_json(listing.stdout)
            if not isinstance(issues, list):
                continue
            for issue in issues:
                if not isinstance(issue, dict):
                    continue
                labels = issue.get("labels")
                if isinstance(labels, list) and labels:
                    continue  # already triaged
                number = issue.get("number")
                title = issue.get("title")
                if not isinstance(number, int) or not isinstance(title, str):
                    continue
                raw_body = issue.get("body")
                body = raw_body if isinstance(raw_body, str) else ""
                classification = await self._classify(ctx, title, body)
                proposal, invocation_ids = classification
                drafts.append(
                    FindingDraft(
                        detector_kind=KIND,
                        severity="info",
                        title=f"Untriaged issue #{number} in {repo.name}: {title}"[:300],
                        dedupe_key=f"{repo.id}:{number}",
                        detail=body[:2000] or None,
                        evidence={"issue_number": number},
                        proposed_objective=proposal,
                        repository_id=repo.id,
                        invocation_ids=invocation_ids,
                    )
                )
        if not triaged_any:
            raise DetectorSkipped("No GitHub remote with open issues was found")
        return drafts

    async def _classify(
        self, ctx: DetectorContext, title: str, body: str
    ) -> tuple[dict[str, object] | None, list[uuid.UUID]]:
        prompt = (
            "Classify this GitHub issue for triage. Suggest a type label "
            "(bug|feature|docs|question|chore), a priority (low|medium|high), and a "
            "one-line rationale.\n\n"
            f"Title: {title}\nBody: {body[:3000]}\n\n"
            'Return ONLY JSON: {"label":"...","priority":"...","rationale":"..."}'
        )
        outcome = await ctx.run_llm(prompt)
        invocation_ids = [outcome.invocation_id] if outcome.invocation_id else []
        parsed = extract_json(outcome.output)
        summary = json.dumps(parsed) if parsed is not None else outcome.output[:500]
        proposal: dict[str, object] = {
            "title": f"Triage: {title}"[:250],
            "description": f"Suggested triage for the issue.\n\n{summary}",
            "test_hint": "",
        }
        return proposal, invocation_ids
