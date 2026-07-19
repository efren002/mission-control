from mission_control.application.services.provider_routing import provider_routes


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
