from mission_control.api.v1.providers import _performance_metric


def test_performance_metric_uses_weighted_duration_and_explicit_token_coverage() -> None:
    metric = _performance_metric(
        "codex",
        None,
        [
            {
                "provider": "codex",
                "role": "developer",
                "invocations": 3,
                "completed": 2,
                "failed": 1,
                "duration_total": 9_000,
                "duration_coverage": 3,
                "fallback_attempts": 1,
                "fallback_successes": 1,
                "token_coverage": 2,
                "input_tokens": 800,
                "cached_input_tokens": 200,
                "output_tokens": 200,
                "total_tokens": 1_000,
            },
            {
                "provider": "codex",
                "role": "reviewer",
                "invocations": 1,
                "completed": 1,
                "failed": 0,
                "duration_total": 7_000,
                "duration_coverage": 1,
                "fallback_attempts": 0,
                "fallback_successes": 0,
                "token_coverage": 0,
                "input_tokens": 0,
                "cached_input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            },
        ],
    )

    assert metric.invocations == 4
    assert metric.success_rate == 75
    assert metric.average_duration_ms == 4_000
    assert metric.fallback_attempts == 1
    assert metric.fallback_successes == 1
    assert metric.token_coverage == 2
    assert metric.total_tokens == 1_000
