from __future__ import annotations

from dataclasses import dataclass

SUPPORTED_PROVIDERS = ("codex", "claude")


@dataclass(frozen=True)
class ProviderRoute:
    provider: str
    model: str | None
    attempt: int
    fallback_from_provider: str | None
    reason: str


def provider_routes(
    primary_provider: str,
    primary_model: str | None,
    *,
    fallback_enabled: bool,
) -> tuple[ProviderRoute, ...]:
    """Return the primary route and, when enabled, the other supported provider."""
    primary = ProviderRoute(
        provider=primary_provider,
        model=primary_model,
        attempt=1,
        fallback_from_provider=None,
        reason="agent_preference",
    )
    if not fallback_enabled or primary_provider not in SUPPORTED_PROVIDERS:
        return (primary,)
    fallback_provider = next(
        provider for provider in SUPPORTED_PROVIDERS if provider != primary_provider
    )
    return (
        primary,
        ProviderRoute(
            provider=fallback_provider,
            model=None,
            attempt=2,
            fallback_from_provider=primary_provider,
            reason="primary_provider_failed",
        ),
    )
