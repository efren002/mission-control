from __future__ import annotations

import json
import logging
import uuid

from redis import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.core.config import get_settings
from mission_control.infrastructure.database.models import RunEvent

logger = logging.getLogger(__name__)


async def append_run_event(
    session: AsyncSession,
    run_id: uuid.UUID,
    event_type: str,
    payload: dict[str, object] | None = None,
    *,
    publish: bool = True,
) -> RunEvent:
    await session.execute(select(func.pg_advisory_xact_lock(func.hashtext(str(run_id)))))
    next_sequence = (
        await session.scalar(
            select(func.coalesce(func.max(RunEvent.sequence), 0)).where(
                RunEvent.run_id == run_id
            )
        )
        or 0
    ) + 1
    event = RunEvent(
        run_id=run_id,
        sequence=next_sequence,
        event_type=event_type,
        payload=payload or {},
    )
    session.add(event)
    await session.flush()

    if publish:
        message = {
            "run_id": str(run_id),
            "type": event_type,
            "source": "workflow",
            **(payload or {}),
        }
        try:
            Redis.from_url(get_settings().redis_url, decode_responses=True).publish(
                "mission-control.events", json.dumps(message)
            )
        except Exception:
            logger.warning("run_event_publish_failed", exc_info=True)
    return event
