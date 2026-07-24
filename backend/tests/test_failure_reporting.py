from mission_control.application.services.failure_reporting import (
    classify_failure,
    compact_diagnostic,
)


def test_classifies_provider_connection_failures_as_retryable() -> None:
    report = classify_failure(
        "peer closed connection without sending complete message body (incomplete chunked read)",
        current_step="execution_failed",
    )

    assert report is not None
    assert report.category == "provider_connection"
    assert report.retryable is True
    assert "retry the failed task" in report.message


def test_explicit_rate_limit_signal_wins_over_transport_text() -> None:
    report = classify_failure(
        "All connection attempts failed",
        current_step="execution_failed",
        rate_limited=True,
    )

    assert report is not None
    assert report.category == "rate_limited"


def test_classifies_runtime_mismatch_before_generic_verification_failure() -> None:
    report = classify_failure(
        "Composer detected issues: dependencies require PHP >= 8.4.1, current version is 8.2.32",
        current_step="verification_failed",
    )

    assert report is not None
    assert report.category == "runtime_incompatible"
    assert report.retryable is False


def test_verification_failure_has_actionable_fallback() -> None:
    report = classify_failure(
        "Acceptance criteria 2 and 3 were not demonstrated",
        current_step="verification_failed",
    )

    assert report is not None
    assert report.category == "verification_failed"


def test_compact_diagnostic_bounds_and_flattens_provider_output() -> None:
    diagnostic = compact_diagnostic("failure\n" + ("payload " * 1_000), limit=80)

    assert diagnostic is not None
    assert "\n" not in diagnostic
    assert len(diagnostic) == 80
    assert diagnostic.endswith("…")
