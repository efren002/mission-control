from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from mission_control.api.v1 import project_runtime
from mission_control.application.services.job_dispatch import DispatchResult
from mission_control.application.services.project_runtime import (
    ProjectRuntimeService,
    RuntimeSnapshot,
)
from mission_control.application.services.runtime_detection import (
    DetectedCommands,
    detect_commands,
)
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import CommandRun, Project, Repository
from mission_control.infrastructure.database.session import get_session
from mission_control.infrastructure.providers.gateway_client import RuntimeGatewayClient
from mission_control.main import app, application


def test_detects_node_commands_from_package_scripts(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"test":"vitest --run","dev":"next dev"}}',
        encoding="utf-8",
    )

    detected = detect_commands(tmp_path)

    assert detected.test_command == "npm test"
    assert detected.app_command == "npm run dev -- --host 0.0.0.0 --port $PORT"


def test_detects_laravel_commands(tmp_path: Path) -> None:
    (tmp_path / "artisan").touch()
    (tmp_path / "composer.json").write_text("{}", encoding="utf-8")

    detected = detect_commands(tmp_path)

    assert detected.test_command == "php artisan test"
    assert detected.app_command == "php artisan serve --host 0.0.0.0 --port $PORT"


def test_project_runtime_defaults_to_the_credential_free_gateway() -> None:
    service = ProjectRuntimeService(AsyncMock())

    assert isinstance(service.gateway, RuntimeGatewayClient)


@pytest.mark.asyncio
async def test_runtime_route_returns_effective_commands_and_app_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = uuid.uuid4()
    repository_id = uuid.uuid4()
    now = datetime.now(UTC)
    snapshot = RuntimeSnapshot(
        project=Project(
            id=project_id,
            name="Storefront",
            status="active",
            memory="",
            test_command=None,
            app_command="npm start -- --port $PORT",
            created_at=now,
            updated_at=now,
        ),
        repository=Repository(
            id=repository_id,
            project_id=project_id,
            name="storefront",
            path="/repositories/storefront",
            default_branch="main",
            created_at=now,
            updated_at=now,
        ),
        detected=DetectedCommands(
            test_command="npm test",
            app_command="npm run dev -- --host 0.0.0.0 --port $PORT",
        ),
        effective_test_command="npm test",
        effective_app_command="npm start -- --port $PORT",
        test_run=None,
        app={
            "status": "running",
            "port": 8201,
            "command": "npm start -- --port 8201",
            "startedAt": now.isoformat(),
            "exitCode": None,
            "logTail": "ready",
        },
        gateway_error=None,
    )
    service = MagicMock()
    service.snapshot = AsyncMock(return_value=snapshot)
    monkeypatch.setattr(project_runtime, "ProjectRuntimeService", lambda _: service)
    async def admin_override() -> str:
        return "admin"

    async def session_override() -> AsyncMock:
        return AsyncMock()

    application.dependency_overrides[require_local_admin] = admin_override
    application.dependency_overrides[get_session] = session_override
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(
                f"/api/v1/projects/{project_id}/runtime",
                params={"repository_id": str(repository_id)},
            )
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["effective_test_command"] == "npm test"
    assert payload["effective_app_command"] == "npm start -- --port $PORT"
    assert payload["app"]["preview_url"] == "http://localhost:8201"
    service.snapshot.assert_awaited_once_with(project_id, repository_id)


@pytest.mark.asyncio
async def test_run_tests_route_queues_the_commands_actor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = uuid.uuid4()
    repository_id = uuid.uuid4()
    command_run_id = uuid.uuid4()
    now = datetime.now(UTC)
    command_run = CommandRun(
        id=command_run_id,
        project_id=project_id,
        repository_id=repository_id,
        kind="test",
        command="npm test",
        status="queued",
        created_at=now,
        updated_at=now,
    )
    service = MagicMock()
    service.queue_tests = AsyncMock(return_value=command_run)
    monkeypatch.setattr(project_runtime, "ProjectRuntimeService", lambda _: service)
    dispatch = AsyncMock(return_value=DispatchResult(sent=1))
    monkeypatch.setattr(project_runtime, "dispatch_pending_jobs", dispatch)

    async def admin_override() -> str:
        return "admin"

    async def session_override() -> AsyncMock:
        return AsyncMock()

    application.dependency_overrides[require_local_admin] = admin_override
    application.dependency_overrides[get_session] = session_override
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                f"/api/v1/projects/{project_id}/runtime/tests",
                params={"repository_id": str(repository_id)},
            )
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 202
    assert response.json()["id"] == str(command_run_id)
    service.queue_tests.assert_awaited_once_with(project_id, repository_id)
    dispatch.assert_awaited_once()
