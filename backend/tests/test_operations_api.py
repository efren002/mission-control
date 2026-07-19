from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from mission_control.api.v1 import operations
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import MaintenanceRun, Objective
from mission_control.infrastructure.database.session import get_session
from mission_control.main import app, application


async def _admin() -> str:
    return "admin"


async def _session() -> AsyncMock:
    return AsyncMock()


def _use_overrides() -> None:
    application.dependency_overrides[require_local_admin] = _admin
    application.dependency_overrides[get_session] = _session


async def test_list_detector_kinds_returns_all_seven() -> None:
    _use_overrides()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/operations/detector-kinds")
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 200
    assert "failing_test_diagnosis" in response.json()
    assert len(response.json()) == 7


async def test_approve_finding_returns_objective_and_dispatches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    finding_id = uuid.uuid4()
    objective = Objective(id=uuid.uuid4(), project_id=uuid.uuid4(), title="Fix", status="planning")
    service = MagicMock()
    service.approve_finding = AsyncMock(return_value=objective)
    monkeypatch.setattr(operations, "MaintenanceService", lambda _: service)
    dispatch = AsyncMock()
    monkeypatch.setattr(operations, "dispatch_pending_jobs", dispatch)
    _use_overrides()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(f"/api/v1/operations/findings/{finding_id}/approve")
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 202
    assert response.json()["objective_id"] == str(objective.id)
    service.approve_finding.assert_awaited_once_with(finding_id)
    dispatch.assert_awaited_once()


async def test_approve_finding_conflict_when_service_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = MagicMock()
    service.approve_finding = AsyncMock(side_effect=ValueError("Only proposed findings"))
    monkeypatch.setattr(operations, "MaintenanceService", lambda _: service)
    monkeypatch.setattr(operations, "dispatch_pending_jobs", AsyncMock())
    _use_overrides()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                f"/api/v1/operations/findings/{uuid.uuid4()}/approve"
            )
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 409


async def test_run_now_returns_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    schedule_id = uuid.uuid4()
    run = MaintenanceRun(
        id=uuid.uuid4(),
        schedule_id=schedule_id,
        detector_kind="repo_health",
        status="running",
        findings_created=0,
    )
    service = MagicMock()
    service.run_now = AsyncMock(return_value=run)
    monkeypatch.setattr(operations, "MaintenanceService", lambda _: service)
    monkeypatch.setattr(operations, "dispatch_pending_jobs", AsyncMock())
    _use_overrides()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                f"/api/v1/operations/schedules/{schedule_id}/run-now"
            )
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 202
    assert response.json()["detector_kind"] == "repo_health"
