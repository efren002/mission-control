import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from mission_control.application.services import job_dispatch
from mission_control.infrastructure.database.models import DispatchJob
from mission_control.workers.actors import planner


def test_enqueue_job_creates_a_deduplicated_outbox_record() -> None:
    session = MagicMock()
    entity_id = uuid.uuid4()

    job = job_dispatch.enqueue_job(
        session,
        kind="plan_objective",
        entity_id=entity_id,
    )

    assert job.kind == "plan_objective"
    assert job.dedupe_key == f"plan_objective:{entity_id}"
    assert job.payload == {"id": str(entity_id)}
    session.add.assert_called_once_with(job)


def test_dispatch_routes_planning_jobs_to_the_idempotent_actor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entity_id = uuid.uuid4()
    job = DispatchJob(
        kind="plan_objective",
        dedupe_key=f"plan_objective:{entity_id}",
        payload={"id": str(entity_id)},
    )
    send = MagicMock()
    monkeypatch.setattr(planner.plan_objective, "send", send)

    job_dispatch._send(job)

    send.assert_called_once_with(str(entity_id))


def test_dispatch_failure_keeps_the_job_for_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = DispatchJob(
        id=uuid.uuid4(),
        kind="plan_objective",
        dedupe_key=f"plan_objective:{uuid.uuid4()}",
        payload={"id": str(uuid.uuid4())},
        attempts=0,
    )
    session = AsyncMock()
    session.scalars.return_value = [job]
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=session)
    context.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(job_dispatch, "async_session_factory", lambda: context)
    monkeypatch.setattr(
        job_dispatch,
        "_send",
        MagicMock(side_effect=RuntimeError("redis unavailable")),
    )

    result = asyncio.run(job_dispatch.dispatch_pending_jobs())

    assert result.failed == 1
    assert result.sent == 0
    assert job.attempts == 1
    assert job.last_error == "redis unavailable"
    session.delete.assert_not_awaited()
    session.commit.assert_awaited_once()


def test_successful_dispatch_removes_the_outbox_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = DispatchJob(
        id=uuid.uuid4(),
        kind="run_project_tests",
        dedupe_key=f"run_project_tests:{uuid.uuid4()}",
        payload={"id": str(uuid.uuid4())},
        attempts=0,
    )
    session = AsyncMock()
    session.scalars.return_value = [job]
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=session)
    context.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(job_dispatch, "async_session_factory", lambda: context)
    monkeypatch.setattr(job_dispatch, "_send", MagicMock())

    result = asyncio.run(job_dispatch.dispatch_pending_jobs())

    assert result.sent == 1
    assert result.failed == 0
    session.delete.assert_awaited_once_with(job)
    session.commit.assert_awaited_once()
