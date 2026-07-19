from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from mission_control.application.services.maintenance import MaintenanceService
from mission_control.application.services.settings import get_workflow_settings
from mission_control.infrastructure.database.models import MaintenanceSchedule
from mission_control.infrastructure.database.session import async_session_factory

logger = logging.getLogger(__name__)

DEFAULT_POLL_SECONDS = 30.0


async def dispatch_due_schedules(limit: int = 20) -> int:
    """Trigger every enabled schedule whose next run is due.

    Uses row locking with skip_locked so multiple API replicas can share the
    scheduling work without double-triggering a schedule.
    """
    triggered = 0
    async with async_session_factory() as session:
        now = datetime.now(UTC)
        schedules = list(
            await session.scalars(
                select(MaintenanceSchedule)
                .where(
                    MaintenanceSchedule.enabled.is_(True),
                    MaintenanceSchedule.next_run_at.is_not(None),
                    MaintenanceSchedule.next_run_at <= now,
                )
                .order_by(MaintenanceSchedule.next_run_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        service = MaintenanceService(session)
        for schedule in schedules:
            run = await service.trigger_schedule(schedule)
            # Advance the next run even when a prior run is still active so a slow
            # detector cannot cause a tight re-trigger loop.
            schedule.next_run_at = now + timedelta(seconds=schedule.interval_seconds)
            if run is not None:
                triggered += 1
        await session.commit()
    return triggered


async def maintenance_scheduler_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        poll_seconds = DEFAULT_POLL_SECONDS
        try:
            async with async_session_factory() as session:
                workflow = await get_workflow_settings(session)
            poll_seconds = float(workflow.get("scheduler_poll_seconds") or DEFAULT_POLL_SECONDS)
            if workflow.get("enable_continuous_operations"):
                await dispatch_due_schedules()
        except Exception:
            logger.warning("maintenance_scheduler_loop_failed", exc_info=True)
        try:
            await asyncio.wait_for(stop.wait(), timeout=max(5.0, poll_seconds))
        except TimeoutError:
            continue
