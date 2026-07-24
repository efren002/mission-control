from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from mission_control.api.v1 import providers as providers_module
from mission_control.core.security import require_local_admin
from mission_control.main import application

VALID_BODY = {
    "name": "openrouter",
    "kind": "http",
    "format": "openai",
    "base_url": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-3.5-sonnet",
    "api_key": "sk-test-123",
    "max_tokens": 8192,
}


async def _admin() -> str:
    return "admin"


def _patch_gateway(monkeypatch: pytest.MonkeyPatch) -> dict[str, AsyncMock]:
    """Replace ProviderGatewayClient with a stub recording each call."""
    calls: dict[str, AsyncMock] = {
        "create": AsyncMock(return_value=(200, {"providers": {"openrouter": {"kind": "http"}}})),
        "update": AsyncMock(return_value=(200, {"providers": {"openrouter": {"kind": "http"}}})),
        "delete": AsyncMock(return_value=(200, {"providers": {}})),
    }

    class _Stub:
        def __init__(self, *_, **__):
            pass

        create_custom_provider = calls["create"]
        update_custom_provider = calls["update"]
        delete_custom_provider = calls["delete"]

    monkeypatch.setattr(providers_module, "ProviderGatewayClient", _Stub)
    return calls


@pytest.fixture(autouse=True)
def _admin_override():
    application.dependency_overrides[require_local_admin] = _admin
    yield
    application.dependency_overrides.pop(require_local_admin, None)


async def test_create_custom_provider_proxies_to_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _patch_gateway(monkeypatch)
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/v1/providers/custom", json=VALID_BODY)
    assert response.status_code == 200
    assert response.json() == {"providers": {"openrouter": {"kind": "http"}}}
    calls["create"].assert_awaited_once()
    forwarded = calls["create"].await_args.args[0]
    assert forwarded["name"] == "openrouter"
    assert forwarded["format"] == "openai"
    assert forwarded["api_key"] == "sk-test-123"


async def test_create_custom_provider_rejects_missing_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_gateway(monkeypatch)
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/providers/custom",
            json={k: v for k, v in VALID_BODY.items() if k != "api_key"},
        )
    assert response.status_code == 422


async def test_create_custom_provider_rejects_invalid_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_gateway(monkeypatch)
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/providers/custom",
            json={
                "name": "a",
                "kind": "http",
                "format": "openai",
                "base_url": "https://x/v1",
                "api_key": "k",
            },
        )
    assert response.status_code == 422


async def test_update_custom_provider_proxies_with_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _patch_gateway(monkeypatch)
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.put("/api/v1/providers/custom/openrouter", json=VALID_BODY)
    assert response.status_code == 200
    calls["update"].assert_awaited_once_with("openrouter", VALID_BODY)


async def test_delete_custom_provider_proxies_with_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _patch_gateway(monkeypatch)
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.delete("/api/v1/providers/custom/openrouter")
    assert response.status_code == 200
    calls["delete"].assert_awaited_once_with("openrouter")
