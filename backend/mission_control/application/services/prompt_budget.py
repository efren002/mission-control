from __future__ import annotations

import re

TRUNCATION_MARKER = (
    "\n\n[... older middle content omitted to stay within the prompt budget ...]\n\n"
)


def compact_prompt_text(value: str | None, max_chars: int) -> str:
    """Normalize low-value whitespace and keep both ends of oversized context."""
    if not value:
        return "None configured"
    normalized = "\n".join(line.rstrip() for line in value.strip().splitlines())
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    if len(normalized) <= max_chars:
        return normalized

    available = max_chars - len(TRUNCATION_MARKER)
    if available <= 0:
        return normalized[:max_chars]
    head_chars = int(available * 0.7)
    tail_chars = available - head_chars
    return (
        normalized[:head_chars].rstrip()
        + TRUNCATION_MARKER
        + normalized[-tail_chars:].lstrip()
    )


def compact_completed_tasks(
    titles: list[str],
    *,
    max_items: int = 12,
    max_chars: int = 2_500,
) -> str:
    if not titles:
        return "None"
    recent = titles[-max_items:]
    omitted = len(titles) - len(recent)
    lines = [*(["- Earlier completed tasks omitted"] if omitted else [])]
    lines.extend(f"- {compact_prompt_text(title, 300)}" for title in recent)
    return compact_prompt_text("\n".join(lines), max_chars)
