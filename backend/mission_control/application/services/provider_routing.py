from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

DEVELOPER_ROLE = "developer"
HTTP_KIND = "http"
CLI_KIND = "cli"


@dataclass(frozen=True)
class ProviderKind:
    name: str
    kind: str  # "cli" | "http"


@dataclass(frozen=True)
class ProviderRoute:
    provider: str
    model: str | None
    attempt: int
    fallback_from_provider: str | None
    reason: str
    kind: str = CLI_KIND


def _build_default_providers() -> tuple[ProviderKind, ...]:
    # Legacy default used when no gateway provider map is available (gateway
    # down, or callers that predate custom providers). Preserves the original
    # codex/claude CLI pair so behavior is unchanged without custom providers.
    return (ProviderKind("codex", CLI_KIND), ProviderKind("claude", CLI_KIND))


DEFAULT_PROVIDERS: tuple[ProviderKind, ...] = _build_default_providers()


def supported_providers(
    provider_map: Mapping[str, object] | None,
) -> tuple[ProviderKind, ...]:
    """Resolve the supported-provider list.

    Without a gateway provider map, falls back to the legacy codex/claude CLI
    pair so behavior stays unchanged. With one, every reported provider becomes
    supported, carrying its declared kind.
    """
    if not provider_map:
        return DEFAULT_PROVIDERS
    entries: list[ProviderKind] = []
    for name, status in provider_map.items():
        kind = CLI_KIND
        if isinstance(status, Mapping):
            declared = status.get("kind", CLI_KIND)
            kind = (
                declared
                if isinstance(declared, str) and declared in {CLI_KIND, HTTP_KIND}
                else CLI_KIND
            )
        entries.append(ProviderKind(name, kind))
    return tuple(entries)


def provider_kind(provider_map: Mapping[str, object] | None, provider: str) -> str:
    """Look up a provider's kind. Unknown providers default to cli."""
    if not provider_map:
        return CLI_KIND
    status = provider_map.get(provider)
    if not isinstance(status, Mapping):
        return CLI_KIND
    declared = status.get("kind", CLI_KIND)
    return (
        declared
        if isinstance(declared, str) and declared in {CLI_KIND, HTTP_KIND}
        else CLI_KIND
    )


def can_assign_role(provider_kind_value: str, role: str) -> bool:
    """HTTP providers return text only and cannot edit the git worktree, so the
    developer role (which checkpoints file changes) must stay CLI-only."""
    return not (provider_kind_value == HTTP_KIND and role == DEVELOPER_ROLE)


def provider_routes(
    primary_provider: str,
    primary_model: str | None,
    *,
    fallback_enabled: bool,
    provider_map: Mapping[str, object] | None = None,
) -> tuple[ProviderRoute, ...]:
    """Return the primary route and, when enabled, a same-kind fallback.

    Fallback is bounded to one attempt and stays within the primary provider's
    kind (http->http, cli->cli) so an HTTP provider never silently falls back to
    a CLI binary with different filesystem semantics. Preserves the legacy
    codex<->claude swap when no provider map is supplied.
    """
    supported = supported_providers(provider_map)
    known = {entry.name: entry for entry in supported}
    primary_entry = known.get(primary_provider, ProviderKind(primary_provider, CLI_KIND))

    primary = ProviderRoute(
        provider=primary_provider,
        model=primary_model,
        attempt=1,
        fallback_from_provider=None,
        reason="agent_preference",
        kind=primary_entry.kind,
    )
    if not fallback_enabled or primary_provider not in known:
        return (primary,)

    for candidate in supported:
        if candidate.name == primary_provider:
            continue
        if candidate.kind == primary_entry.kind:
            return (
                primary,
                ProviderRoute(
                    provider=candidate.name,
                    model=None,
                    attempt=2,
                    fallback_from_provider=primary_provider,
                    reason="primary_provider_failed",
                    kind=candidate.kind,
                ),
            )
    return (primary,)
