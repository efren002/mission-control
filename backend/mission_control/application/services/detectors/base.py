from __future__ import annotations

import json
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from mission_control.infrastructure.database.models import Project, Repository

SEVERITIES = ("info", "low", "medium", "high", "critical")


@dataclass(frozen=True, slots=True)
class CommandOutcome:
    """Result of running a shell command inside a repository workspace."""

    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool

    @property
    def combined(self) -> str:
        return f"{self.stdout}{self.stderr}"

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


@dataclass(frozen=True, slots=True)
class LlmOutcome:
    output: str
    invocation_id: uuid.UUID | None


@dataclass(slots=True)
class FindingDraft:
    """A candidate finding produced by a detector, before persistence."""

    detector_kind: str
    severity: str
    title: str
    dedupe_key: str
    detail: str | None = None
    evidence: dict[str, object] = field(default_factory=dict)
    proposed_objective: dict[str, object] | None = None
    repository_id: uuid.UUID | None = None
    invocation_ids: list[uuid.UUID] = field(default_factory=list)


# A detector runs commands against a specific repository workspace.
CommandRunner = Callable[[Repository, str], Awaitable[CommandOutcome]]
# A detector asks a provider to reason about gathered evidence.
LlmRunner = Callable[[str], Awaitable[LlmOutcome]]


@dataclass(slots=True)
class DetectorContext:
    project: Project
    repositories: list[Repository]
    config: dict[str, object]
    workflow: dict[str, object]
    run_command: CommandRunner
    run_llm: LlmRunner


class DetectorSkipped(Exception):
    """Raised when a detector cannot run in the current environment.

    A skip is a recorded, non-error outcome (for example issue triage without a
    GitHub remote) rather than a failure.
    """


class Detector(Protocol):
    kind: str

    async def detect(self, ctx: DetectorContext) -> list[FindingDraft]: ...


_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)
_JSON_ARRAY = re.compile(r"\[.*\]", re.DOTALL)


def extract_json(output: str) -> object | None:
    """Best-effort recovery of a JSON value from noisy provider output."""
    text = output.strip()
    for candidate in (text, _first_match(_JSON_OBJECT, text), _first_match(_JSON_ARRAY, text)):
        if not candidate:
            continue
        try:
            loaded: object = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return loaded
    return None


def _first_match(pattern: re.Pattern[str], text: str) -> str | None:
    match = pattern.search(text)
    return match.group() if match else None
