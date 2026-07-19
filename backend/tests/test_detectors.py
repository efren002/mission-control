from __future__ import annotations

import uuid
from collections.abc import Callable

import pytest

from mission_control.application.services.detectors import (
    DETECTOR_KINDS,
    CommandOutcome,
    DetectorContext,
    DetectorSkipped,
    LlmOutcome,
    get_detector,
)
from mission_control.application.services.detectors.base import extract_json
from mission_control.infrastructure.database.models import Project, Repository

_WORKFLOW = {
    "planner_provider": "codex",
    "planner_model": None,
    "enable_provider_fallback": True,
    "provider_timeout_seconds": 60,
    "retain_invocation_output": True,
}


def _repo(name: str = "demo") -> Repository:
    return Repository(id=uuid.uuid4(), project_id=uuid.uuid4(), name=name, path=f"/repos/{name}")


def _ctx(
    *,
    command_map: dict[str, CommandOutcome] | None = None,
    default_command: CommandOutcome | None = None,
    llm_output: str = "{}",
    project: Project | None = None,
    repositories: list[Repository] | None = None,
    config: dict[str, object] | None = None,
) -> DetectorContext:
    matcher: Callable[[str], CommandOutcome] = _command_matcher(
        command_map or {}, default_command or CommandOutcome(0, "", "", False)
    )

    async def run_command(repository: Repository, command: str) -> CommandOutcome:
        return matcher(command)

    async def run_llm(prompt: str) -> LlmOutcome:
        return LlmOutcome(output=llm_output, invocation_id=None)

    return DetectorContext(
        project=project or Project(name="Demo", test_command=None),
        repositories=repositories if repositories is not None else [_repo()],
        config=config or {},
        workflow=dict(_WORKFLOW),
        run_command=run_command,
        run_llm=run_llm,
    )


def _command_matcher(
    command_map: dict[str, CommandOutcome], default: CommandOutcome
) -> Callable[[str], CommandOutcome]:
    def match(command: str) -> CommandOutcome:
        for needle, outcome in command_map.items():
            if needle in command:
                return outcome
        return default

    return match


async def _detect(kind: str, ctx: DetectorContext):  # type: ignore[no-untyped-def]
    return await get_detector(kind).detect(ctx)


def test_registry_exposes_all_seven_detectors() -> None:
    assert set(DETECTOR_KINDS) == {
        "dependency_maintenance",
        "failing_test_diagnosis",
        "documentation_drift",
        "issue_triage",
        "security_health",
        "repo_health",
        "mission_template",
    }
    with pytest.raises(ValueError):
        get_detector("does_not_exist")


def test_extract_json_recovers_object_from_noise() -> None:
    assert extract_json('log line\n{"a": 1} trailing') == {"a": 1}
    assert extract_json("not json") is None


async def test_dependency_detector_reports_outdated_npm_packages() -> None:
    ctx = _ctx(
        command_map={
            "test -f package.json": CommandOutcome(0, "", "", False),
            "test -f requirements.txt": CommandOutcome(1, "", "", False),
            "npm outdated": CommandOutcome(
                1, '{"left-pad": {"current": "1.0.0", "latest": "1.3.0"}}', "", False
            ),
        }
    )
    findings = await _detect("dependency_maintenance", ctx)

    assert len(findings) == 1
    assert "outdated npm dependencies" in findings[0].title
    assert findings[0].proposed_objective is not None


async def test_dependency_detector_skips_without_manifests() -> None:
    ctx = _ctx(default_command=CommandOutcome(1, "", "", False))
    with pytest.raises(DetectorSkipped):
        await _detect("dependency_maintenance", ctx)


async def test_failing_test_detector_skips_without_command() -> None:
    ctx = _ctx(project=Project(name="Demo", test_command=None))
    with pytest.raises(DetectorSkipped):
        await _detect("failing_test_diagnosis", ctx)


async def test_failing_test_detector_diagnoses_failure() -> None:
    ctx = _ctx(
        project=Project(name="Demo", test_command="pytest"),
        command_map={"pytest": CommandOutcome(1, "1 failed", "traceback", False)},
        llm_output='{"title":"Fix the failing suite","description":"...","test_hint":"pytest"}',
    )
    findings = await _detect("failing_test_diagnosis", ctx)

    assert len(findings) == 1
    assert findings[0].severity == "high"
    assert findings[0].proposed_objective["title"] == "Fix the failing suite"


async def test_failing_test_detector_ignores_passing_suite() -> None:
    ctx = _ctx(
        project=Project(name="Demo", test_command="pytest"),
        command_map={"pytest": CommandOutcome(0, "ok", "", False)},
    )
    assert await _detect("failing_test_diagnosis", ctx) == []


async def test_documentation_drift_detector_flags_stale_docs() -> None:
    ctx = _ctx(
        command_map={
            "git log -1 --format=%H -- README.md": CommandOutcome(0, "abc123\n", "", False),
            "git rev-list --count": CommandOutcome(0, "42\n", "", False),
            "git diff --name-only": CommandOutcome(0, "src/app.py\n", "", False),
        },
        llm_output='{"title":"Refresh docs","description":"...","test_hint":""}',
    )
    findings = await _detect("documentation_drift", ctx)

    assert len(findings) == 1
    assert findings[0].evidence["commits_since_doc_update"] == 42


async def test_issue_triage_detector_skips_without_gh() -> None:
    ctx = _ctx(command_map={"gh --version": CommandOutcome(127, "", "not found", False)})
    with pytest.raises(DetectorSkipped):
        await _detect("issue_triage", ctx)


async def test_security_detector_flags_npm_vulnerabilities() -> None:
    audit = '{"metadata": {"vulnerabilities": {"high": 2, "critical": 1}}}'
    ctx = _ctx(
        command_map={
            "test -f package.json": CommandOutcome(0, "", "", False),
            "npm audit": CommandOutcome(1, audit, "", False),
            "git grep": CommandOutcome(1, "", "", False),
        }
    )
    findings = await _detect("security_health", ctx)

    assert any(f.severity == "critical" for f in findings)


async def test_repo_health_detector_flags_missing_gitignore() -> None:
    ctx = _ctx(
        command_map={
            "test -f .gitignore": CommandOutcome(1, "", "", False),
            "git ls-tree": CommandOutcome(0, "", "", False),
        }
    )
    findings = await _detect("repo_health", ctx)

    assert any("Missing .gitignore" in f.title for f in findings)


async def test_mission_template_detector_instantiates_from_config() -> None:
    ctx = _ctx(
        config={"objective_title": "Weekly dependency sweep", "objective_description": "Do it"}
    )
    findings = await _detect("mission_template", ctx)

    assert len(findings) == 1
    assert findings[0].proposed_objective["title"] == "Weekly dependency sweep"


async def test_mission_template_detector_skips_without_title() -> None:
    ctx = _ctx(config={})
    with pytest.raises(DetectorSkipped):
        await _detect("mission_template", ctx)
