from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Protocol


class ProviderStatus(StrEnum):
    COMPLETED = "completed"
    NEEDS_INPUT = "needs_input"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    structured_output: bool
    streaming_events: bool
    repository_editing: bool
    session_resume: bool
    sandbox_control: bool


@dataclass(frozen=True, slots=True)
class ProviderRequest:
    prompt: str
    workspace: Path
    output_schema: Path | None = None
    timeout_seconds: int = 1800
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ProviderEvent:
    event_type: str
    message: str
    payload: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ProviderResult:
    status: ProviderStatus
    summary: str
    session_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


class AIProvider(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def capabilities(self) -> ProviderCapabilities: ...

    async def execute(self, request: ProviderRequest) -> AsyncIterator[ProviderEvent]: ...
