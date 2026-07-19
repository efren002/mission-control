from __future__ import annotations

from mission_control.application.services.detectors.base import (
    DetectorContext,
    DetectorSkipped,
    FindingDraft,
)

KIND = "mission_template"


class MissionTemplateDetector:
    """Recurring mission templates.

    Rather than diagnosing a problem, this instantiates a saved objective spec on
    a schedule as a proposed finding. Approving the finding creates the objective
    and starts planning through the normal, gated pipeline.
    """

    kind = KIND

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]:
        title = ctx.config.get("objective_title")
        if not isinstance(title, str) or not title.strip():
            raise DetectorSkipped("The mission template has no objective_title configured")
        description = ctx.config.get("objective_description")
        description_text = description.strip() if isinstance(description, str) else ""
        test_hint = ctx.config.get("test_hint")
        return [
            FindingDraft(
                detector_kind=KIND,
                severity="info",
                title=f"Recurring mission ready: {title.strip()}"[:300],
                dedupe_key=title.strip().lower(),
                detail=description_text or None,
                evidence={"template": True},
                proposed_objective={
                    "title": title.strip()[:250],
                    "description": description_text,
                    "test_hint": test_hint.strip() if isinstance(test_hint, str) else "",
                },
            )
        ]
