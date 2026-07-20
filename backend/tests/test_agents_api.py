from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from mission_control.api.v1 import agents
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.session import get_session
from mission_control.main import app, application


async def _admin() -> str:
    return "admin"


async def _session() -> MagicMock:
    session = MagicMock()
    # agent_counts() awaits session.execute(...).tuples(); return empty rows.
    session.execute = AsyncMock(return_value=MagicMock(tuples=MagicMock(return_value=[])))
    return session


def _use_overrides() -> None:
    application.dependency_overrides[require_local_admin] = _admin
    application.dependency_overrides[get_session] = _session


def _agent_row(provider: str, role: str) -> MagicMock:
    agent = MagicMock()
    agent.id = uuid.uuid4()
    agent.name = "Test Agent"
    agent.role = role
    agent.provider = provider
    agent.model = None
    agent.instructions = ""
    agent.enabled = True
    return agent


def _patch_service(monkeypatch: pytest.MonkeyPatch, created) -> MagicMock:
    service = MagicMock()
    service.create = AsyncMock(return_value=created)
    service.update = AsyncMock(return_value=created)
    service.get = AsyncMock(return_value=created)
    monkeypatch.setattr(agents, "AgentService", lambda _: service)
    return service


async def test_create_agent_rejects_developer_role_with_http_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        agents,
        "provider_map",
        AsyncMock(return_value={"openrouter": {"kind": "http", "available": True}}),
    )
    _patch_service(monkeypatch, _agent_row("openrouter", "developer"))
    _use_overrides()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/v1/agents",
                json={"name": "Dev", "role": "developer", "provider": "openrouter"},
            )
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 409
    assert "developer" in response.json()["detail"].lower()


async def test_create_agent_allows_http_provider_for_planner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        agents,
        "provider_map",
        AsyncMock(return_value={"openrouter": {"kind": "http", "available": True}}),
    )
    service = _patch_service(monkeypatch, _agent_row("openrouter", "planner"))
    _use_overrides()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/v1/agents",
                json={"name": "Planner", "role": "planner", "provider": "openrouter"},
            )
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 201
    service.create.assert_awaited_once()


async def test_update_agent_rejects_http_provider_for_existing_developer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Existing agent is a developer on codex; switching its provider to an http
    # provider must be rejected even though role is unchanged in the payload.
    existing = _agent_row("codex", "developer")
    monkeypatch.setattr(
        agents,
        "provider_map",
        AsyncMock(return_value={"openrouter": {"kind": "http"}, "codex": {"kind": "cli"}}),
    )
    _patch_service(monkeypatch, existing)
    _use_overrides()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.put(
                f"/api/v1/agents/{existing.id}",
                json={"provider": "openrouter"},
            )
    finally:
        application.dependency_overrides.clear()

    assert response.status_code == 409
    assert "developer" in response.json()["detail"].lower()
