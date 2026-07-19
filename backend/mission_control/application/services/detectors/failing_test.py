from __future__ import annotations

from mission_control.application.services.detectors.base import (
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
)
from mission_control.application.services.repair_proposals import propose_repair

KIND = "failing_test_diagnosis"
_OUTPUT_CHARS = 6000


class FailingTestDiagnosisDetector:
    kind = KIND

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]:
        test_command = ctx.project.test_command
        if not test_command or not test_command.strip():
            raise DetectorSkipped("The project has no test command configured")
        if not ctx.repositories:
            raise DetectorSkipped("No repositories are configured for this project")
        drafts: list[FindingDraft] = []
        for repo in ctx.repositories:
            outcome = await ctx.run_command(repo, test_command)
            if outcome.ok:
                continue
            tail = outcome.combined[-_OUTPUT_CHARS:]
            reason = (
                "the command timed out"
                if outcome.timed_out
                else f"it exited with code {outcome.exit_code}"
            )
            problem = (
                f"The test command `{test_command}` fails in repository {repo.name} "
                f"because {reason}."
            )
            proposal, invocation_ids = await propose_repair(
                ctx,
                problem=problem,
                context=f"Command output (tail):\n{tail}",
                default_title=f"Fix failing tests in {repo.name}",
            )
            drafts.append(
                FindingDraft(
                    detector_kind=KIND,
                    severity="high",
                    title=f"Test suite failing in {repo.name}",
                    dedupe_key=f"{repo.id}",
                    detail=f"{problem}\n\nOutput tail:\n{tail}",
                    evidence={
                        "command": test_command,
                        "exit_code": outcome.exit_code,
                        "timed_out": outcome.timed_out,
                    },
                    proposed_objective=proposal,
                    repository_id=repo.id,
                    invocation_ids=invocation_ids,
                )
            )
        return drafts
