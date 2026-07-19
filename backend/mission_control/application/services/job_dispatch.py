from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.infrastructure.database.models import CommandRun, DispatchJob, Run
from mission_control.infrastructure.database.session import async_session_factory

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DispatchResult:
    sent: int = 0
    failed: int = 0


def enqueue_job(
    session: AsyncSession,
    *,
    kind: str,
    entity_id: uuid.UUID,
) -> DispatchJob:
    job = DispatchJob(
        kind=kind,
        dedupe_key=f"{kind}:{entity_id}",
        payload={"id": str(entity_id)},
    )
    session.add(job)
    return job


def _send(job: DispatchJob) -> None:
    entity_id = job.payload.get("id")
    if not isinstance(entity_id, str):
        raise ValueError("Dispatch job payload is missing its entity ID")
    if job.kind == "plan_objective":
        from mission_control.workers.actors.planner import plan_objective

        plan_objective.send(entity_id)
        return
    if job.kind == "run_project_tests":
        from mission_control.workers.actors.commands import run_project_tests

        run_project_tests.send(entity_id)
        return
    if job.kind == "run_maintenance_detector":
        from mission_control.workers.actors.maintenance import run_maintenance_detector

        run_maintenance_detector.send(entity_id)
        return
    raise ValueError(f"Unsupported dispatch job kind: {job.kind}")


async def recover_undispatched_jobs(session: AsyncSession) -> int:
    """Recreate outbox records for legacy/stale work that never reached Redis."""
    recovered = 0
    planning_runs = await session.scalars(
        select(Run).where(Run.status == "planning", Run.current_step == "planner")
    )
    queued_commands = await session.scalars(
        select(CommandRun).where(CommandRun.status == "queued")
    )
    candidates = [
        ("plan_objective", run.id) for run in planning_runs
    ] + [
        ("run_project_tests", command.id) for command in queued_commands
    ]
    for kind, entity_id in candidates:
        dedupe_key = f"{kind}:{entity_id}"
        exists = await session.scalar(
            select(DispatchJob.id).where(DispatchJob.dedupe_key == dedupe_key)
        )
        if exists is None:
            enqueue_job(session, kind=kind, entity_id=entity_id)
            recovered += 1
    if recovered:
        await session.commit()
    return recovered


async def dispatch_pending_jobs(limit: int = 20) -> DispatchResult:
    sent = 0
    failed = 0
    async with async_session_factory() as session:
        jobs = list(
            await session.scalars(
                select(DispatchJob)
                .order_by(DispatchJob.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        for job in jobs:
            try:
                # Dramatiq's Redis publication is synchronous; keep a slow or
                # unavailable broker from blocking the API event loop.
                await asyncio.to_thread(_send, job)
            except Exception as error:
                job.attempts += 1
                job.last_error = str(error)[:2000]
                failed += 1
                logger.warning(
                    "job_dispatch_failed",
                    extra={"job_id": str(job.id), "kind": job.kind},
                    exc_info=True,
                )
            else:
                await session.delete(job)
                sent += 1
        await session.commit()
    return DispatchResult(sent=sent, failed=failed)


async def dispatch_loop(stop: asyncio.Event, interval_seconds: float = 5.0) -> None:
    while not stop.is_set():
        try:
            async with async_session_factory() as session:
                await recover_undispatched_jobs(session)
            await dispatch_pending_jobs()
        except Exception:
            logger.warning("job_dispatch_loop_failed", exc_info=True)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
        except TimeoutError:
            continue
