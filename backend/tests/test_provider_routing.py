from mission_control.application.services.provider_routing import (
    can_assign_role,
    provider_kind,
    provider_routes,
    supported_providers,
)


def test_provider_routes_adds_other_provider_without_reusing_model() -> None:
    routes = provider_routes("codex", "gpt-custom", fallback_enabled=True)

    assert [(route.provider, route.model) for route in routes] == [
        ("codex", "gpt-custom"),
        ("claude", None),
    ]
    assert routes[1].attempt == 2
    assert routes[1].fallback_from_provider == "codex"
    assert routes[1].reason == "primary_provider_failed"


def test_provider_routes_can_disable_fallback() -> None:
    routes = provider_routes("claude", None, fallback_enabled=False)

    assert len(routes) == 1
    assert routes[0].provider == "claude"
    assert routes[0].attempt == 1


def test_supported_providers_defaults_to_codex_and_claude_without_map() -> None:
    assert [p.name for p in supported_providers(None)] == ["codex", "claude"]
    assert [p.kind for p in supported_providers(None)] == ["cli", "cli"]


def test_supported_providers_includes_http_entries_from_provider_map() -> None:
    provider_map = {
        "codex": {"kind": "cli"},
        "claude": {"kind": "cli"},
        "openrouter": {"kind": "http"},
        "9router": {"kind": "http"},
    }
    supported = supported_providers(provider_map)
    by_name = {p.name: p.kind for p in supported}
    assert by_name == {"codex": "cli", "claude": "cli", "openrouter": "http", "9router": "http"}


def test_provider_routes_falls_back_within_same_kind_for_http() -> None:
    provider_map = {
        "codex": {"kind": "cli"},
        "claude": {"kind": "cli"},
        "openrouter": {"kind": "http"},
        "anthropic-direct": {"kind": "http"},
    }
    routes = provider_routes(
        "openrouter",
        None,
        fallback_enabled=True,
        provider_map=provider_map,
    )
    assert [(r.provider, r.kind) for r in routes] == [
        ("openrouter", "http"),
        ("anthropic-direct", "http"),
    ]
    assert routes[1].attempt == 2
    assert routes[1].fallback_from_provider == "openrouter"


def test_provider_routes_returns_no_fallback_when_no_other_same_kind() -> None:
    # Only one http provider configured — no same-kind fallback available.
    provider_map = {
        "codex": {"kind": "cli"},
        "claude": {"kind": "cli"},
        "openrouter": {"kind": "http"},
    }
    routes = provider_routes(
        "openrouter", None, fallback_enabled=True, provider_map=provider_map
    )
    assert len(routes) == 1
    assert routes[0].provider == "openrouter"


def test_can_assign_role_rejects_http_provider_for_developer() -> None:
    assert can_assign_role("http", "developer") is False
    assert can_assign_role("cli", "developer") is True
    assert can_assign_role("http", "planner") is True
    assert can_assign_role("http", "reviewer") is True


def test_provider_kind_reads_kind_from_provider_map() -> None:
    provider_map = {"openrouter": {"kind": "http"}, "codex": {"kind": "cli"}}
    assert provider_kind(provider_map, "openrouter") == "http"
    assert provider_kind(provider_map, "codex") == "cli"
    # Unknown provider with no map defaults to cli (legacy behavior).
    assert provider_kind(None, "codex") == "cli"
    assert provider_kind(provider_map, "unknown") == "cli"

