from __future__ import annotations

import uuid

from mission_control.application.services.detectors.base import (
    DetectorContext,
    extract_json,
)


async def propose_repair(
    ctx: DetectorContext,
    *,
    problem: str,
    context: str,
    default_title: str,
) -> tuple[dict[str, object] | None, list[uuid.UUID]]:
    """Ask a provider to draft a repair objective from finding evidence.

    Returns the proposed objective (title/description/test_hint) and the ids of
    any agent invocations created, so the caller can link them to the finding.
    The proposal is a suggestion only: it becomes an objective solely after a
    human approves the finding.
    """
    prompt = (
        "You are the Operations agent for an autonomous engineering platform. A "
        "continuous-maintenance check found a problem in a repository. Draft a single, "
        "self-contained objective a developer agent could pick up to resolve it. Keep the "
        "scope tight and safe. Do not make the change yourself.\n\n"
        f"PROBLEM:\n{problem}\n\n"
        f"EVIDENCE:\n{context[:6000]}\n\n"
        'Return ONLY JSON of the form {"title":"...","description":"...",'
        '"test_hint":"how to verify the fix"}. The title must be a concise imperative.'
    )
    outcome = await ctx.run_llm(prompt)
    invocation_ids = [outcome.invocation_id] if outcome.invocation_id else []
    parsed = extract_json(outcome.output)
    if not isinstance(parsed, dict):
        return (
            {"title": default_title, "description": problem, "test_hint": ""},
            invocation_ids,
        )
    title = parsed.get("title")
    description = parsed.get("description")
    test_hint = parsed.get("test_hint")
    proposal: dict[str, object] = {
        "title": title.strip()[:250] if isinstance(title, str) and title.strip() else default_title,
        "description": description.strip() if isinstance(description, str) else problem,
        "test_hint": test_hint.strip() if isinstance(test_hint, str) else "",
    }
    return proposal, invocation_ids
