from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

FailureCategory = Literal[
    "rate_limited",
    "provider_connection",
    "provider_process",
    "runtime_incompatible",
    "verification_failed",
    "unknown",
]

_RATE_LIMIT = re.compile(
    r"\b429\b|rate[ -]?limit|session limit|usage limit|usage_cap_reached|too many requests",
    re.IGNORECASE,
)
_CONNECTION = re.compile(
    r"all connection attempts failed|connection (?:reset|refused|closed)|"
    r"incomplete chunked read|peer closed|timed? out|temporary failure in name resolution",
    re.IGNORECASE,
)
_RUNTIME = re.compile(
    r"requires php|php .*version|platform requirements|composer dependencies|"
    r"unsupported runtime|runtime incompatib",
    re.IGNORECASE,
)
_PROVIDER_PROCESS = re.compile(
    r"provider exited|reading additional input from stdin|provider execution",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class FailureReport:
    category: FailureCategory
    message: str
    retryable: bool


def compact_diagnostic(value: str | None, *, limit: int = 2_000) -> str | None:
    if not value:
        return None
    compacted = " ".join(value.split())
    if len(compacted) <= limit:
        return compacted
    return f"{compacted[: limit - 1]}…"


def classify_failure(
    detail: str | None,
    *,
    current_step: str | None = None,
    rate_limited: bool = False,
) -> FailureReport | None:
    diagnostic = compact_diagnostic(detail)
    if not diagnostic:
        return None
    if rate_limited or _RATE_LIMIT.search(diagnostic):
        return FailureReport(
            category="rate_limited",
            message=(
                "The provider has reached its usage limit. Wait for the limit to reset or use "
                "another connected provider, then retry the failed step."
            ),
            retryable=True,
        )
    if _CONNECTION.search(diagnostic):
        return FailureReport(
            category="provider_connection",
            message=(
                "The provider connection was interrupted. Check gateway health, then retry the "
                "failed task; completed task checkpoints are preserved."
            ),
            retryable=True,
        )
    if _RUNTIME.search(diagnostic):
        return FailureReport(
            category="runtime_incompatible",
            message=(
                "The generated project requires a different runtime or dependency version. "
                "Update the project runtime configuration before retrying verification."
            ),
            retryable=False,
        )
    if current_step == "verification_failed":
        return FailureReport(
            category="verification_failed",
            message=(
                "The deterministic checks or acceptance review failed. Inspect the evidence "
                "below, correct the project or runtime, then retry verification."
            ),
            retryable=True,
        )
    if _PROVIDER_PROCESS.search(diagnostic):
        return FailureReport(
            category="provider_process",
            message=(
                "The provider process exited unexpectedly. Verify the provider connection and "
                "retry the failed step."
            ),
            retryable=True,
        )
    return FailureReport(
        category="unknown",
        message="The workflow failed unexpectedly. Review the diagnostic below before retrying.",
        retryable=False,
    )
