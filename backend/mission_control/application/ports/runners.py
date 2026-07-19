from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True, slots=True)
class RunnerLimits:
    timeout_seconds: int = 1800
    memory_mb: int = 4096
    cpu_count: float = 2.0
    network_enabled: bool = False


@dataclass(frozen=True, slots=True)
class RunnerRequest:
    argv: tuple[str, ...]
    workspace: Path
    environment: dict[str, str] = field(default_factory=dict)
    limits: RunnerLimits = field(default_factory=RunnerLimits)


@dataclass(frozen=True, slots=True)
class RunnerResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_seconds: float
    timed_out: bool = False


class TaskRunner(Protocol):
    async def execute(self, request: RunnerRequest) -> RunnerResult: ...

    async def cancel(self, execution_id: str) -> None: ...
