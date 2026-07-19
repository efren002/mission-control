import asyncio
import io
import json
import subprocess
import uuid
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from mission_control.api.v1 import auth, runs
from mission_control.api.v1 import tasks as tasks_api
from mission_control.api.v1.agents import agent_counts
from mission_control.api.v1.runs import ExecutionRequest
from mission_control.application.services.agents import DEFAULT_AGENT_PROFILES
from mission_control.application.services.catalog import CatalogService
from mission_control.application.services.prompt_budget import (
    TRUNCATION_MARKER,
    compact_completed_tasks,
    compact_prompt_text,
)
from mission_control.application.services.settings import get_workflow_settings
from mission_control.core.config import Settings
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import (
    Agent,
    AgentInvocation,
    Approval,
    Objective,
    Project,
    Repository,
    Run,
    SystemSetting,
    Task,
)
from mission_control.infrastructure.git.inspector import RepositoryInspector
from mission_control.infrastructure.providers.gateway_client import (
    ProviderExecutionError,
    parse_gateway_events,
)
from mission_control.main import app, wrap_application
from mission_control.workers.actors.executor import (
    TASK_ACTOR_TIME_LIMIT_MS,
    _execution_progress,
    _execution_prompt,
    _provider_blocker,
    _retry_prompt,
    execute_run,
)
from mission_control.workers.actors.planner import _extract_tasks, _planner_prompt


async def exercise_application_foundation() -> tuple[int, dict[str, str], int]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        liveness_response = await client.get("/api/v1/health/live")

    try:
        await require_local_admin(None)
    except HTTPException as error:
        protected_status = error.status_code
    else:
        protected_status = 200

    return liveness_response.status_code, liveness_response.json(), protected_status


def test_application_foundation() -> None:
    liveness_status, liveness_body, protected_status = asyncio.run(
        exercise_application_foundation()
    )

    assert liveness_status == 200
    assert liveness_body == {"status": "operational"}
    assert protected_status == 401


@pytest.mark.asyncio
async def test_unhandled_errors_retain_cors_and_request_id_headers() -> None:
    application = FastAPI()

    @application.get("/boom")
    async def boom() -> None:
        raise RuntimeError("boom")

    wrapped = wrap_application(application)
    async with AsyncClient(
        transport=ASGITransport(app=wrapped, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.get(
            "/boom",
            headers={
                "Origin": "http://localhost:3000",
                "X-Request-ID": "test-request-id",
            },
        )

    assert response.status_code == 500
    assert response.headers["Access-Control-Allow-Origin"] == "http://localhost:3000"
    assert response.headers["X-Request-ID"] == "test-request-id"


@pytest.mark.asyncio
async def test_loopback_dashboard_origin_is_allowed() -> None:
    application = FastAPI()
    wrapped = wrap_application(
        application,
        ["http://localhost:3000", "http://127.0.0.1:3000"],
    )
    async with AsyncClient(
        transport=ASGITransport(app=wrapped),
        base_url="http://test",
    ) as client:
        response = await client.options(
            "/api/v1/agents",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:3000"


def _auth_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "development",
        "auto_admin_login": True,
        "local_admin_token": "a-real-generated-token",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[arg-type]


def test_local_session_returns_token_for_local_development(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth, "get_settings", lambda: _auth_settings())

    session = asyncio.run(auth.local_session())

    assert session.token == "a-real-generated-token"


@pytest.mark.parametrize(
    "overrides",
    [
        {"auto_admin_login": False},
        {"environment": "production"},
        {"local_admin_token": "replace-with-a-long-random-token"},
    ],
)
def test_local_session_is_unavailable_outside_local_development(
    monkeypatch: pytest.MonkeyPatch, overrides: dict[str, object]
) -> None:
    monkeypatch.setattr(auth, "get_settings", lambda: _auth_settings(**overrides))

    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.local_session())

    assert error.value.status_code == 404


def test_default_agent_profiles_cover_every_workflow_role() -> None:
    roles = [profile["role"] for profile in DEFAULT_AGENT_PROFILES]
    names = [profile["name"] for profile in DEFAULT_AGENT_PROFILES]

    assert roles == ["planner", "developer", "qa", "reviewer"]
    assert len(set(names)) == len(names)
    assert all(profile["instructions"].strip() for profile in DEFAULT_AGENT_PROFILES)


def test_agent_counts_consumes_sqlalchemy_tuple_results_explicitly() -> None:
    agent_id = uuid.uuid4()

    class TupleResult:
        def __init__(self, rows: list[tuple[uuid.UUID, int]]) -> None:
            self.rows = rows

        def keys(self) -> list[str]:
            return ["agent_id", "count"]

        def __iter__(self) -> Iterator[tuple[uuid.UUID, int]]:
            return iter(self.rows)

    assignment_result = MagicMock()
    assignment_result.tuples.return_value = TupleResult([(agent_id, 2)])
    invocation_result = MagicMock()
    invocation_result.tuples.return_value = TupleResult([(agent_id, 3)])
    session = AsyncMock()
    session.execute.side_effect = [assignment_result, invocation_result]

    assignments, invocations = asyncio.run(agent_counts(session, [agent_id]))

    assert assignments == {agent_id: 2}
    assert invocations == {agent_id: 3}


def _git(repo: Path, *args: str) -> str:
    identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"]
    completed = subprocess.run(
        ["git", "-C", str(repo), *identity, *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def test_commit_diff_returns_the_checkpoint_patch(tmp_path: Path) -> None:
    repo = tmp_path / "demo"
    repo.mkdir()
    _git(repo, "init", "--initial-branch", "main")
    _git(repo, "commit", "--allow-empty", "-m", "initial")
    (repo / "app.py").write_text("print('hello')\n")
    _git(repo, "add", "--all")
    _git(repo, "commit", "-m", "Task 1: add app")
    sha = _git(repo, "rev-parse", "HEAD")
    inspector = RepositoryInspector(Settings(_env_file=None, repository_root=str(tmp_path)))

    diff = asyncio.run(inspector.commit_diff(repo, sha))

    assert "Task 1: add app" in diff
    assert "app.py" in diff
    assert "+print('hello')" in diff


def test_commit_diff_rejects_invalid_commit_references(tmp_path: Path) -> None:
    repo = tmp_path / "demo"
    repo.mkdir()
    inspector = RepositoryInspector(Settings(_env_file=None, repository_root=str(tmp_path)))

    with pytest.raises(ValueError, match="valid SHA"):
        asyncio.run(inspector.commit_diff(repo, "HEAD~1"))


def test_repository_inspection_treats_untracked_files_as_dirty(tmp_path: Path) -> None:
    repo = tmp_path / "demo"
    repo.mkdir()
    _git(repo, "init", "--initial-branch", "main")
    _git(repo, "commit", "--allow-empty", "-m", "initial")
    (repo / "untracked.txt").write_text("pending\n")
    inspector = RepositoryInspector(Settings(_env_file=None, repository_root=str(tmp_path)))

    inspection = asyncio.run(inspector.inspect(repo))

    assert inspection.clean is False


def test_repository_archive_contains_only_tracked_files(tmp_path: Path) -> None:
    repo = tmp_path / "demo"
    repo.mkdir()
    _git(repo, "init", "--initial-branch", "main")
    (repo / "app.py").write_text("print('hello')\n")
    _git(repo, "add", "--all")
    _git(repo, "commit", "-m", "add app")
    (repo / "untracked.txt").write_text("pending\n")
    sha = _git(repo, "rev-parse", "HEAD")
    inspector = RepositoryInspector(Settings(_env_file=None, repository_root=str(tmp_path)))
    service = CatalogService(AsyncMock(), inspector)
    record = Repository(
        project_id=uuid.uuid4(), name="Demo App!", path=str(repo), default_branch="main"
    )

    archive = asyncio.run(service.archive_repository(record))

    with zipfile.ZipFile(io.BytesIO(archive.data)) as bundle:
        names = bundle.namelist()
    assert archive.filename == f"demo-app-{sha[:7]}.zip"
    assert "app.py" in names
    assert "untracked.txt" not in names


def test_repository_archive_rejects_paths_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    inspector = RepositoryInspector(Settings(_env_file=None, repository_root=str(root)))

    with pytest.raises(ValueError, match="outside the configured repository root"):
        asyncio.run(inspector.archive(outside))


def test_legacy_unused_workflow_settings_are_discarded() -> None:
    stored = SystemSetting(
        key="workflow_settings",
        value=json.dumps(
            {
                "execution_provider": "claude",
                "execution_model": "legacy",
                "max_concurrent_agents": 9,
                "allow_repository_writes": True,
            }
        ),
    )
    session = AsyncMock()
    session.get.return_value = stored

    workflow = asyncio.run(get_workflow_settings(session))

    assert workflow["allow_repository_writes"] is True
    assert "execution_provider" not in workflow
    assert "execution_model" not in workflow
    assert "max_concurrent_agents" not in workflow


def test_execution_is_refused_when_repository_writes_are_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    objective_id = uuid.uuid4()
    run = Run(
        id=uuid.uuid4(),
        objective_id=objective_id,
        status="completed",
        current_step="planned",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    objective = Objective(
        id=objective_id,
        project_id=uuid.uuid4(),
        title="Protected mission",
        status="planned",
    )
    session = AsyncMock()
    session.scalar.return_value = run
    session.get.return_value = objective

    async def disabled_settings(_: object) -> dict[str, object]:
        return {"allow_repository_writes": False}

    monkeypatch.setattr(runs, "get_workflow_settings", disabled_settings)

    with pytest.raises(HTTPException, match="Repository writes are disabled") as error:
        asyncio.run(
            runs.start_execution(
                run.id,
                ExecutionRequest(),
                "admin",
                session,
            )
        )

    assert error.value.status_code == 409


def test_execution_approval_is_created_before_repository_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = uuid.uuid4()
    objective_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    repository_id = uuid.uuid4()
    run = Run(
        id=uuid.uuid4(),
        objective_id=objective_id,
        status="completed",
        current_step="planned",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    objective = Objective(
        id=objective_id,
        project_id=project_id,
        title="Approval mission",
        status="planned",
    )
    project = Project(id=project_id, name="Approval project", status="active")
    agent = Agent(
        id=agent_id,
        name="Implementer",
        role="developer",
        provider="codex",
        enabled=True,
    )
    task = Task(
        id=uuid.uuid4(),
        objective_id=objective_id,
        run_id=run.id,
        title="Implement safely",
        status="planned",
        agent_role="developer",
        assigned_agent_id=agent_id,
    )
    repository = Repository(
        id=repository_id,
        project_id=project_id,
        name="approval-project",
        path="/repositories/approval-project",
        default_branch="main",
    )
    session = AsyncMock()
    session.add = MagicMock()
    session.scalar.side_effect = [run, None]
    session.get.side_effect = [objective, project, repository]
    session.scalars.side_effect = [[task], [agent]]
    task_count_rows = MagicMock()
    task_count_rows.all.return_value = [(run.id, 1)]
    session.execute.side_effect = [task_count_rows, [(run.id, "pending")]]

    async def approval_settings(_: object) -> dict[str, object]:
        return {
            "allow_repository_writes": True,
            "require_plan_approval": False,
            "require_execution_approval": True,
        }

    async def no_event(*_: object, **__: object) -> None:
        return None

    monkeypatch.setattr(runs, "get_workflow_settings", approval_settings)
    monkeypatch.setattr(runs, "append_run_event", no_event)

    response = asyncio.run(
        runs.start_execution(
            run.id,
            ExecutionRequest(repository_id=repository_id),
            "admin",
            session,
        )
    )

    assert response.status == "awaiting_execution_approval"
    assert objective.status == "awaiting_execution_approval"
    added = session.add.call_args.args[0]
    assert isinstance(added, Approval)
    assert added.kind == "execution"
    assert added.status == "pending"


def test_stale_execution_resume_requeues_only_the_interrupted_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    old = datetime(2026, 7, 18, 10, 0, tzinfo=UTC)
    objective_id = uuid.uuid4()
    run = Run(
        id=uuid.uuid4(),
        objective_id=objective_id,
        repository_id=uuid.uuid4(),
        status="executing",
        current_step="Review",
        created_at=old,
        updated_at=old,
    )
    objective = Objective(
        id=objective_id,
        project_id=uuid.uuid4(),
        title="Recover mission",
        status="executing",
    )
    task = Task(
        id=uuid.uuid4(),
        objective_id=objective_id,
        run_id=run.id,
        title="Review",
        status="in_progress",
        agent_role="reviewer",
    )
    invocation = AgentInvocation(
        id=uuid.uuid4(),
        agent_id=uuid.uuid4(),
        run_id=run.id,
        task_id=task.id,
        purpose="task_execution",
        status="running",
        created_at=old,
        updated_at=old,
    )
    session = AsyncMock()
    session.scalar.return_value = run
    session.get.return_value = objective
    session.scalars.side_effect = [[invocation], [task]]

    async def no_event(*_: object, **__: object) -> None:
        return None

    send = MagicMock()
    monkeypatch.setattr(runs, "append_run_event", no_event)
    monkeypatch.setattr(
        "mission_control.workers.actors.executor.execute_run.send", send
    )

    response = asyncio.run(runs.resume_execution(run.id, "admin", session))

    assert response.recovered_tasks == 1
    assert run.status == "queued_for_execution"
    assert run.current_step == "execution_resuming"
    assert task.status == "planned"
    assert invocation.status == "failed"
    assert objective.status == "executing"
    send.assert_called_once_with(str(run.id))


def test_recent_execution_cannot_be_resumed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    run = Run(
        id=uuid.uuid4(),
        objective_id=uuid.uuid4(),
        repository_id=uuid.uuid4(),
        status="executing",
        current_step="Working",
        created_at=now,
        updated_at=now,
    )
    objective = Objective(
        id=run.objective_id,
        project_id=uuid.uuid4(),
        title="Active mission",
        status="executing",
    )
    session = AsyncMock()
    session.scalar.return_value = run
    session.get.return_value = objective
    session.scalars.return_value = []
    send = MagicMock()
    monkeypatch.setattr(
        "mission_control.workers.actors.executor.execute_run.send", send
    )

    with pytest.raises(HTTPException, match="recent worker activity") as error:
        asyncio.run(runs.resume_execution(run.id, "admin", session))

    assert error.value.status_code == 409
    send.assert_not_called()


def test_stale_queued_execution_can_be_republished(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    old = datetime(2026, 7, 18, 10, 0, tzinfo=UTC)
    run = Run(
        id=uuid.uuid4(),
        objective_id=uuid.uuid4(),
        repository_id=uuid.uuid4(),
        status="queued_for_execution",
        current_step="execution_queued",
        created_at=old,
        updated_at=old,
    )
    objective = Objective(
        id=run.objective_id,
        project_id=uuid.uuid4(),
        title="Queued mission",
        status="executing",
    )
    session = AsyncMock()
    session.scalar.return_value = run
    session.get.return_value = objective
    session.scalars.return_value = []

    async def no_event(*_: object, **__: object) -> None:
        return None

    send = MagicMock()
    monkeypatch.setattr(runs, "append_run_event", no_event)
    monkeypatch.setattr(
        "mission_control.workers.actors.executor.execute_run.send", send
    )

    response = asyncio.run(runs.resume_execution(run.id, "admin", session))

    assert response.status == "queued_for_execution"
    assert response.recovered_tasks == 0
    send.assert_called_once_with(str(run.id))


def test_queue_redelivery_failure_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    old = datetime(2026, 7, 18, 10, 0, tzinfo=UTC)
    run = Run(
        id=uuid.uuid4(),
        objective_id=uuid.uuid4(),
        repository_id=uuid.uuid4(),
        status="queued_for_execution",
        current_step="execution_queued",
        created_at=old,
        updated_at=old,
    )
    objective = Objective(
        id=run.objective_id,
        project_id=uuid.uuid4(),
        title="Undelivered mission",
        status="executing",
    )
    session = AsyncMock()
    session.scalar.return_value = run
    session.get.return_value = objective
    session.scalars.return_value = []

    async def no_event(*_: object, **__: object) -> None:
        return None

    monkeypatch.setattr(runs, "append_run_event", no_event)
    monkeypatch.setattr(
        "mission_control.workers.actors.executor.execute_run.send",
        MagicMock(side_effect=RuntimeError("redis unavailable")),
    )

    with pytest.raises(HTTPException, match="Unable to queue") as error:
        asyncio.run(runs.resume_execution(run.id, "admin", session))

    assert error.value.status_code == 503
    session.commit.assert_awaited()


def test_resumed_execution_skips_completed_tasks() -> None:
    completed = Task(
        objective_id=uuid.uuid4(),
        title="Already checkpointed",
        status="completed",
        agent_role="developer",
    )
    interrupted = Task(
        objective_id=completed.objective_id,
        title="Interrupted review",
        status="planned",
        agent_role="reviewer",
    )

    completed_titles, remaining_tasks = _execution_progress([completed, interrupted])

    assert completed_titles == ["Already checkpointed"]
    assert remaining_tasks == [interrupted]


def test_failed_task_with_checkpoint_can_be_reverted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    objective_id = uuid.uuid4()
    run = Run(
        id=uuid.uuid4(),
        objective_id=objective_id,
        repository_id=uuid.uuid4(),
        status="failed",
        current_step="execution_failed",
    )
    task = Task(
        id=uuid.uuid4(),
        objective_id=objective_id,
        run_id=run.id,
        title="Broken step",
        status="failed",
        agent_role="developer",
        checkpoint_sha="a" * 40,
    )
    repository = Repository(id=run.repository_id, name="demo", path="/repos/demo")
    session = AsyncMock()
    session.get.side_effect = [task, run, repository]

    async def no_event(*_: object, **__: object) -> None:
        return None

    client = MagicMock()
    client.git_revert = AsyncMock(return_value="b" * 40)
    monkeypatch.setattr(tasks_api, "append_run_event", no_event)
    monkeypatch.setattr(tasks_api, "provider_workspace", lambda _: "/workspaces/demo")
    monkeypatch.setattr(tasks_api, "ProviderGatewayClient", lambda: client)

    response = asyncio.run(tasks_api.revert_task(task.id, "admin", session))

    assert task.status == "reverted"
    assert response.status == "reverted"
    client.git_revert.assert_awaited_once_with("/workspaces/demo", "a" * 40)


def test_only_completed_or_failed_tasks_can_be_reverted() -> None:
    task = Task(
        id=uuid.uuid4(),
        objective_id=uuid.uuid4(),
        title="Pending step",
        status="planned",
        agent_role="developer",
    )
    session = AsyncMock()
    session.get.return_value = task

    with pytest.raises(HTTPException, match="completed or failed") as error:
        asyncio.run(tasks_api.revert_task(task.id, "admin", session))

    assert error.value.status_code == 409


def test_execution_actor_is_scoped_to_one_long_provider_task() -> None:
    assert execute_run.options["max_retries"] == 3
    assert execute_run.options["time_limit"] == TASK_ACTOR_TIME_LIMIT_MS
    assert TASK_ACTOR_TIME_LIMIT_MS > 2 * 30 * 60 * 1000


def test_planner_prompt_includes_persistent_instructions() -> None:
    project = Project(name="Payments", memory="Use cents for all monetary values.")
    objective = Objective(
        project_id=project.id,
        title="Add refunds",
        description="Support partial refunds.",
    )

    prompt = _planner_prompt(objective, project, "All changed behavior needs tests.")

    assert "All changed behavior needs tests." in prompt
    assert "Use cents for all monetary values." in prompt
    assert "Project memory overrides global coding standards" in prompt
    assert "Add refunds" in prompt


def test_planner_prompt_includes_agent_instructions() -> None:
    project = Project(name="Storefront", memory="")
    objective = Objective(project_id=project.id, title="Improve search", description=None)

    prompt = _planner_prompt(objective, project, "", "Prefer reversible implementation steps.")

    assert "PLANNER AGENT INSTRUCTIONS" in prompt
    assert "Prefer reversible implementation steps." in prompt


def test_prompt_context_is_normalized_and_bounded() -> None:
    value = "first rule   \n\n\n\n" + ("middle " * 2_000) + "\nlatest rule"

    compacted = compact_prompt_text(value, 1_000)

    assert len(compacted) <= 1_000
    assert compacted.startswith("first rule")
    assert compacted.endswith("latest rule")
    assert TRUNCATION_MARKER.strip() in compacted
    assert "\n\n\n" not in compacted


def test_completed_task_context_keeps_only_recent_titles() -> None:
    completed = compact_completed_tasks([f"Task {index}" for index in range(20)])

    assert "Earlier completed tasks omitted" in completed
    assert "Task 0" not in completed
    assert "Task 8" in completed
    assert "Task 19" in completed


def test_gateway_events_reconstruct_provider_output() -> None:
    body = "\n".join(
        [
            "event: started",
            'data: {"provider":"codex"}',
            "",
            "event: stdout",
            'data: {"data":"first\\n"}',
            "",
            "event: stderr",
            'data: {"data":"warning\\n"}',
            "",
            "event: stdout",
            'data: {"data":"second\\n"}',
            "",
            "event: completed",
            'data: {"exitCode":0,"timedOut":false,"durationMs":42}',
            "",
        ]
    )

    result = parse_gateway_events(body)

    assert result.stdout == "first\nsecond\n"
    assert result.stderr == "warning\n"
    assert result.exit_code == 0
    assert result.duration_ms == 42
    assert result.timed_out is False


def test_gateway_events_require_completion() -> None:
    body = 'event: stdout\ndata: {"data":"partial"}\n\n'

    try:
        parse_gateway_events(body)
    except ProviderExecutionError as error:
        assert "completion event" in str(error)
    else:
        raise AssertionError("Expected an incomplete gateway response to fail")


def test_planner_extracts_tasks_from_nested_provider_event() -> None:
    provider_output = (
        '{"type":"item.completed","item":{"type":"agent_message",'
        '"text":"{\\"tasks\\":[{\\"title\\":\\"Build endpoint\\",'
        '\\"description\\":\\"Add the API route.\\",'
        '\\"agent_role\\":\\"developer\\"}]}"}}'
    )

    tasks = _extract_tasks(provider_output)

    assert tasks == [
        {
            "title": "Build endpoint",
            "description": "Add the API route.",
            "agent_role": "developer",
        }
    ]


def test_planner_rejects_empty_task_payload() -> None:
    assert _extract_tasks('{"tasks":[]}') == []


def test_execution_prompt_requires_workspace_changes_and_checks() -> None:
    project = Project(name="Storefront", memory="Use PostgreSQL.")
    objective = Objective(
        project_id=project.id,
        title="Create products CRUD",
        description="Build the approved product workflow.",
    )
    task = Task(
        objective_id=objective.id,
        title="Build product views",
        description="Add accessible Blade forms.",
        agent_role="developer",
    )
    agent = Agent(
        name="Implementer",
        role="developer",
        provider="codex",
        instructions="Keep controllers thin.",
    )

    prompt = _execution_prompt(
        objective=objective,
        project=project,
        task=task,
        agent=agent,
        coding_standards="Test all changed behavior.",
        completed_tasks=["Create the data layer"],
    )

    assert "Implement the assigned task directly in the current workspace" in prompt
    assert "Do not merely describe changes" in prompt
    assert "Use PostgreSQL." in prompt
    assert "Keep controllers thin." in prompt
    assert "Create the data layer" in prompt
    assert "Build product views" in prompt


def test_retry_prompt_feeds_the_failure_back_to_the_agent() -> None:
    prompt = _retry_prompt("Original task prompt", "Tests failed: 2 assertions in test_app.py")

    assert prompt.startswith("Original task prompt")
    assert "PREVIOUS ATTEMPT FEEDBACK" in prompt
    assert "Tests failed: 2 assertions in test_app.py" in prompt
    assert "fix it" in prompt


def test_provider_blocker_detects_sandbox_failure() -> None:
    output = "\n".join(
        [
            '{"type":"item.completed","item":{"type":"command_execution",'
            '"aggregated_output":"bwrap: No permissions to create a new namespace\\n",'
            '"exit_code":1}}',
            '{"type":"item.completed","item":{"type":"agent_message",'
            '"text":"Blocked by the execution environment. No files were changed."}}',
        ]
    )

    assert _provider_blocker(output) == (
        "Blocked by the execution environment. No files were changed."
    )


def test_provider_blocker_allows_recovered_command_failure() -> None:
    output = "\n".join(
        [
            '{"type":"item.completed","item":{"type":"command_execution",'
            '"aggregated_output":"tests initially failed","exit_code":1}}',
            '{"type":"item.completed","item":{"type":"agent_message",'
            '"text":"Implemented the change and all tests now pass."}}',
        ]
    )

    assert _provider_blocker(output) is None


def test_provider_login_rejects_unknown_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    from mission_control.api.v1 import providers

    client = MagicMock()
    monkeypatch.setattr(providers, "ProviderGatewayClient", lambda: client)

    with pytest.raises(HTTPException) as error:
        asyncio.run(providers.start_provider_login("notreal", "admin"))

    assert error.value.status_code == 404
    client.login_start.assert_not_called()


def test_provider_login_passes_the_gateway_response_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mission_control.api.v1 import providers

    client = MagicMock()
    client.login_start = AsyncMock(
        return_value=(409, {"provider": "codex", "status": "awaiting_browser"})
    )
    client.login_submit_code = AsyncMock(return_value=(200, {"status": "verifying"}))
    client.login_cancel = AsyncMock(return_value=(200, {"status": "cancelled"}))
    monkeypatch.setattr(providers, "ProviderGatewayClient", lambda: client)

    started = asyncio.run(providers.start_provider_login("codex", "admin"))
    assert started.status_code == 409
    assert json.loads(started.body)["status"] == "awaiting_browser"

    submitted = asyncio.run(
        providers.submit_provider_login_code(
            "claude", providers.LoginCodeRequest(code="pasted-code"), "admin"
        )
    )
    assert submitted.status_code == 200
    client.login_submit_code.assert_awaited_once_with("claude", "pasted-code")

    cancelled = asyncio.run(providers.cancel_provider_login("codex", "admin"))
    assert cancelled.status_code == 200


def test_provider_login_reports_gateway_unavailability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mission_control.api.v1 import providers

    client = MagicMock()
    client.login_status = AsyncMock(side_effect=ConnectionError("gateway is down"))
    monkeypatch.setattr(providers, "ProviderGatewayClient", lambda: client)

    with pytest.raises(HTTPException) as error:
        asyncio.run(providers.provider_login_status("codex", "admin"))

    assert error.value.status_code == 503
