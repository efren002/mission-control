from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from mission_control.application.services.detectors import FindingDraft
from mission_control.application.services.maintenance import MaintenanceService
from mission_control.infrastructure.database.models import (
    MaintenanceFinding,
    MaintenanceRun,
    MaintenanceSchedule,
)


def _schedule(**overrides: object) -> MaintenanceSchedule:
    defaults: dict[str, object] = {
        "id": uuid.uuid4(),
        "project_id": uuid.uuid4(),
        "name": "Nightly deps",
        "detector_kind": "dependency_maintenance",
        "interval_seconds": 86_400,
        "enabled": True,
        "config": {},
    }
    defaults.update(overrides)
    return MaintenanceSchedule(**defaults)


def _draft() -> FindingDraft:
    return FindingDraft(
        detector_kind="dependency_maintenance",
        severity="low",
        title="Outdated packages",
        dedupe_key="repo:npm",
        proposed_objective={"title": "Upgrade", "description": "do it", "test_hint": ""},
    )


async def test_create_schedule_rejects_unknown_detector_kind() -> None:
    session = MagicMock()
    session.get = AsyncMock(return_value=object())
    service = MaintenanceService(session)

    with pytest.raises(ValueError):
        await service.create_schedule(
            project_id=uuid.uuid4(),
            name="bad",
            detector_kind="not_real",
            interval_seconds=3600,
        )


async def test_persist_findings_creates_new_finding() -> None:
    session = MagicMock()
    session.scalar = AsyncMock(return_value=None)  # no existing duplicate
    session.add = MagicMock(side_effect=lambda item: setattr(item, "id", uuid.uuid4()))
    session.flush = AsyncMock()
    session.execute = AsyncMock()
    service = MaintenanceService(session)

    created = await service.persist_findings(_schedule(), [_draft()])

    assert created == 1
    session.add.assert_called_once()


async def test_persist_findings_skips_open_duplicate() -> None:
    session = MagicMock()
    session.scalar = AsyncMock(return_value=uuid.uuid4())  # an open duplicate exists
    session.add = MagicMock()
    session.flush = AsyncMock()
    service = MaintenanceService(session)

    created = await service.persist_findings(_schedule(), [_draft()])

    assert created == 0
    session.add.assert_not_called()


async def test_persist_findings_links_invocations_to_finding() -> None:
    session = MagicMock()
    session.scalar = AsyncMock(return_value=None)
    session.add = MagicMock(side_effect=lambda item: setattr(item, "id", uuid.uuid4()))
    session.flush = AsyncMock()
    session.execute = AsyncMock()
    draft = _draft()
    draft.invocation_ids = [uuid.uuid4()]
    service = MaintenanceService(session)

    created = await service.persist_findings(_schedule(), [draft])

    assert created == 1
    session.execute.assert_awaited_once()


async def test_trigger_schedule_returns_none_when_run_active() -> None:
    session = MagicMock()
    session.scalar = AsyncMock(return_value=uuid.uuid4())  # active run present
    session.add = MagicMock()
    session.flush = AsyncMock()
    service = MaintenanceService(session)

    result = await service.trigger_schedule(_schedule())

    assert result is None
    session.add.assert_not_called()


async def test_trigger_schedule_enqueues_when_idle() -> None:
    session = MagicMock()
    session.scalar = AsyncMock(return_value=None)  # no active run
    session.add = MagicMock(side_effect=lambda item: setattr(item, "id", uuid.uuid4()))
    session.flush = AsyncMock()
    service = MaintenanceService(session)

    result = await service.trigger_schedule(_schedule())

    assert isinstance(result, MaintenanceRun)
    # One MaintenanceRun and one DispatchJob are added to the session.
    assert session.add.call_count == 2


async def test_approve_finding_requires_proposed_status() -> None:
    finding = MaintenanceFinding(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        detector_kind="dependency_maintenance",
        severity="low",
        title="x",
        dedupe_key="x",
        status="dismissed",
    )
    session = MagicMock()
    session.scalar = AsyncMock(return_value=finding)
    service = MaintenanceService(session)

    with pytest.raises(ValueError):
        await service.approve_finding(finding.id)


async def test_approve_finding_requires_a_proposal() -> None:
    finding = MaintenanceFinding(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        detector_kind="repo_health",
        severity="low",
        title="x",
        dedupe_key="x",
        status="proposed",
        proposed_objective=None,
    )
    session = MagicMock()
    session.scalar = AsyncMock(return_value=finding)
    session.commit = AsyncMock()
    service = MaintenanceService(session)

    with pytest.raises(ValueError):
        await service.approve_finding(finding.id)


async def test_due_schedule_selection_and_advance(monkeypatch: pytest.MonkeyPatch) -> None:
    from mission_control.application.services import maintenance_scheduler

    schedule = _schedule(next_run_at=datetime.now(UTC) - timedelta(minutes=1))

    session = MagicMock()
    scalars_result = MagicMock()
    scalars_result.__iter__ = lambda self: iter([schedule])
    session.scalars = AsyncMock(return_value=scalars_result)
    session.scalar = AsyncMock(return_value=None)
    session.add = MagicMock(side_effect=lambda item: setattr(item, "id", uuid.uuid4()))
    session.flush = AsyncMock()
    session.commit = AsyncMock()

    class _FakeSessionCtx:
        async def __aenter__(self) -> MagicMock:
            return session

        async def __aexit__(self, *args: object) -> None:
            return None

    monkeypatch.setattr(
        maintenance_scheduler, "async_session_factory", lambda: _FakeSessionCtx()
    )

    triggered = await maintenance_scheduler.dispatch_due_schedules()

    assert triggered == 1
    # next_run_at is pushed into the future so the schedule is not re-triggered.
    assert schedule.next_run_at is not None
    assert schedule.next_run_at > datetime.now(UTC)
