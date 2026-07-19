from __future__ import annotations

import asyncio
import time
import uuid
from datetime import UTC, datetime

import dramatiq

from mission_control.infrastructure.database.models import CommandRun, Repository
from mission_control.infrastructure.database.session import async_session_factory
from mission_control.infrastructure.providers.gateway_client import (
    RuntimeGatewayClient,
    provider_workspace,
)
from mission_control.infrastructure.queue.broker import broker as broker

COMMAND_TIMEOUT_SECONDS = 900
OUTPUT_EXCERPT_CHARS = 8000


async def _run_tests(command_run_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        command_run = await session.get(CommandRun, command_run_id)
        if command_run is None or command_run.status != "queued":
            return
        repository = (
            await session.get(Repository, command_run.repository_id)
            if command_run.repository_id
            else None
        )
        if repository is None:
            command_run.status = "error"
            command_run.error = "The repository for this command run no longer exists"
            command_run.finished_at = datetime.now(UTC)
            await session.commit()
            return
        command_run.status = "running"
        command_run.started_at = datetime.now(UTC)
        await session.commit()
        command = command_run.command
        repository_path = repository.path

    last_flush = 0.0

    async def stream_output(tail: str) -> None:
        """Persist the rolling command output so the UI can show live progress."""
        nonlocal last_flush
        now = time.monotonic()
        if now - last_flush < 2.0:
            return
        last_flush = now
        async with async_session_factory() as session:
            live = await session.get(CommandRun, command_run_id)
            if live is not None and live.status == "running":
                live.output_excerpt = tail
                await session.commit()

    status = "error"
    exit_code: int | None = None
    output_excerpt: str | None = None
    error: str | None = None
    try:
        workspace = provider_workspace(repository_path)
        result = await RuntimeGatewayClient().run_command(
            workspace,
            command,
            timeout_seconds=COMMAND_TIMEOUT_SECONDS,
            on_output=stream_output,
            sandbox_id=str(command_run_id),
        )
    except Exception as failure:
        error = str(failure)[:4000]
    else:
        exit_code = result.exit_code
        output_excerpt = f"{result.stdout}{result.stderr}"[-OUTPUT_EXCERPT_CHARS:] or None
        if result.timed_out:
            status = "error"
            error = f"The command timed out after {COMMAND_TIMEOUT_SECONDS} seconds"
        elif result.exit_code == 0:
            status = "passed"
        else:
            status = "failed"

    async with async_session_factory() as session:
        command_run = await session.get(CommandRun, command_run_id)
        if command_run is None:
            return
        command_run.status = status
        command_run.exit_code = exit_code
        command_run.error = error
        if output_excerpt is not None:
            command_run.output_excerpt = output_excerpt
        command_run.finished_at = datetime.now(UTC)
        await session.commit()


@dramatiq.actor(max_retries=0)
def run_project_tests(command_run_id: str) -> None:
    asyncio.run(_run_tests(uuid.UUID(command_run_id)))
