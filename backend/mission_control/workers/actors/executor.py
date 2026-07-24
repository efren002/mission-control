
from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import re
import time
import uuid
from contextlib import suppress
from datetime import UTC, datetime

import dramatiq
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.attachments import (
    list_provider_attachment_paths,
)
from mission_control.application.services.prompt_budget import (
    compact_completed_tasks,
    compact_prompt_text,
)
from mission_control.application.services.provider_routing import (
    can_assign_role,
    provider_kind,
    provider_routes,
)
from mission_control.application.services.run_events import append_run_event
from mission_control.application.services.runtime_detection import detect_commands
from mission_control.application.services.settings import get_workflow_settings
from mission_control.infrastructure.database.models import (
    Agent,
    AgentInvocation,
    Approval,
    ConflictResolutionAttempt,
    Objective,
    Project,
    Repository,
    Run,
    SystemSetting,
    Task,
    VerificationCriterion,
    VerificationEvidence,
)
from mission_control.infrastructure.database.session import async_session_factory
from mission_control.infrastructure.providers.gateway_client import (
    ProviderExecutionError,
    ProviderGatewayClient,
    ProviderResult,
    RuntimeGatewayClient,
    TaskIntegrationConflict,
    local_worktree_path,
    provider_workspace,
)
from mission_control.infrastructure.queue.broker import broker as broker

HEARTBEAT_SECONDS = 5
# One actor handles one task with at most two 30-minute provider attempts.
TASK_ACTOR_TIME_LIMIT_MS = 65 * 60 * 1000
VERIFICATION_TIMEOUT_SECONDS = 15 * 60
VERIFICATION_ACTOR_TIME_LIMIT_MS = 50 * 60 * 1000
VERIFICATION_OUTPUT_CHARS = 12_000
RESOLUTION_ACTOR_TIME_LIMIT_MS = 50 * 60 * 1000
logger = logging.getLogger(__name__)


async def _provider_kind_map() -> dict[str, object]:
    """Fetch the live provider -> {kind, ...} map from the gateway.

    Returns an empty dict on any failure so callers fall back to the legacy
    cli-only default rather than blocking execution.
    """
    try:
        payload = await ProviderGatewayClient().providers()
    except Exception:
        return {}
    providers = payload.get("providers", {})
    return providers if isinstance(providers, dict) else {}


DEVELOPER_HTTP_ERROR = (
    "Developer tasks require a CLI provider (codex or claude); "
    "HTTP providers cannot edit the git worktree."
)


def _preserve_worktree(run: Run) -> None:
    if run.worktree_status == "active":
        run.worktree_status = "preserved"


def _preserve_task_worktree(task: Task) -> None:
    if task.worktree_status == "active":
        task.worktree_status = "preserved"


def _ready_tasks(tasks: list[Task]) -> list[Task]:
    completed_positions = {
        task.position for task in tasks if task.status == "completed"
    }
    return [
        task
        for task in tasks
        if task.status in {"planned", "queued"}
        and set(task.depends_on_positions or []).issubset(completed_positions)
    ]


def _normalize_predicted_path(path: str) -> str:
    return path.strip().lstrip("./").strip("/")


def _predicted_files(task: Task) -> set[str]:
    return {
        _normalize_predicted_path(path)
        for path in (task.predicted_files or [])
        if isinstance(path, str) and _normalize_predicted_path(path)
    }


def _paths_overlap(left: str, right: str) -> bool:
    if left == right:
        return True
    # Glob patterns match either direction (e.g. "src/**" vs "src/api.py").
    if fnmatch.fnmatch(right, left) or fnmatch.fnmatch(left, right):
        return True
    # Directory containment (e.g. "src" contains "src/api.py").
    return right.startswith(f"{left}/") or left.startswith(f"{right}/")


def _tasks_touch_shared_files(left: Task, right: Task) -> bool:
    """Whether two tasks are predicted to modify overlapping files.

    Overlap requires positive evidence: both tasks must declare predicted files
    and at least one pair must intersect. When either task leaves its files
    unknown we cannot prove a conflict, so we keep the existing parallel behavior
    and rely on merge-time conflict detection as the safety net.
    """
    left_files = _predicted_files(left)
    right_files = _predicted_files(right)
    if not left_files or not right_files:
        return False
    return any(
        _paths_overlap(left_path, right_path)
        for left_path in left_files
        for right_path in right_files
    )


def _claimable_tasks(ready: list[Task], active: list[Task]) -> list[Task]:
    """Ready tasks that do not overlap any in-progress task's predicted files.

    This is the pre-execution sequential fallback: a dependency-ready task whose
    predicted files collide with an already-running task is deferred until that
    task integrates, instead of racing it to a merge conflict.
    """
    return [
        task
        for task in ready
        if not any(_tasks_touch_shared_files(task, running) for running in active)
    ]


async def _integrate_task_worktree(
    session: AsyncSession,
    run: Run,
    task: Task,
) -> str | None:
    if (
        not run.worktree_path
        or task.worktree_status != "active"
        or not task.worktree_path
        or not task.worktree_branch
        or not task.baseline_sha
    ):
        _preserve_task_worktree(task)
        detail = "The task worktree metadata is incomplete or no longer active"
        await append_run_event(
            session,
            run.id,
            "task.integration_failed",
            {"task_id": str(task.id), "detail": detail},
        )
        return detail
    try:
        result = await ProviderGatewayClient().git_integrate_task_worktree(
            run.worktree_path,
            task.worktree_path,
            task.worktree_branch,
            task.baseline_sha,
        )
    except Exception as error:
        task.worktree_status = "preserved"
        detail = str(error)[:2000]
        if isinstance(error, TaskIntegrationConflict):
            task.conflict_files = error.conflict_files
            task.conflict_detail = detail
            task.conflict_detected_at = datetime.now(UTC)
        await append_run_event(
            session,
            run.id,
            "task.integration_failed",
            {
                "task_id": str(task.id),
                "branch": task.worktree_branch,
                "baseline_sha": task.baseline_sha,
                "detail": detail,
            },
        )
        return detail
    task.integration_sha = result.integration_sha
    task.worktree_status = "integrated" if result.cleaned else "cleanup_pending"
    await append_run_event(
        session,
        run.id,
        "task.integrated",
        {
            "task_id": str(task.id),
            "branch": task.worktree_branch,
            "integration_sha": result.integration_sha,
            "cleaned": result.cleaned,
            **({"cleanup_error": result.cleanup_error} if result.cleanup_error else {}),
        },
    )
    return None


async def _integrate_run_worktree(
    session: AsyncSession,
    run: Run,
    repository: Repository,
) -> str | None:
    """Integrate a verified run, returning an error when it must be preserved."""
    if run.worktree_status is None:
        # Runs created before worktree isolation keep their legacy completion path.
        return None
    if (
        run.worktree_status != "active"
        or not run.worktree_path
        or not run.worktree_branch
        or not run.baseline_sha
    ):
        _preserve_worktree(run)
        detail = "The mission worktree metadata is incomplete or no longer active"
        await append_run_event(
            session,
            run.id,
            "worktree.integration_failed",
            {"detail": detail},
        )
        return detail
    try:
        result = await ProviderGatewayClient().git_integrate_worktree(
            provider_workspace(repository.path),
            run.worktree_path,
            run.worktree_branch,
            run.baseline_sha,
        )
    except Exception as error:
        run.worktree_status = "preserved"
        detail = str(error)[:2000]
        await append_run_event(
            session,
            run.id,
            "worktree.integration_failed",
            {
                "branch": run.worktree_branch,
                "baseline_sha": run.baseline_sha,
                "detail": detail,
            },
        )
        return detail
    run.integration_sha = result.integration_sha
    run.worktree_status = "integrated" if result.cleaned else "cleanup_pending"
    await append_run_event(
        session,
        run.id,
        "worktree.integrated",
        {
            "branch": run.worktree_branch,
            "baseline_sha": run.baseline_sha,
            "integration_sha": result.integration_sha,
            "cleaned": result.cleaned,
            **({"cleanup_error": result.cleanup_error} if result.cleanup_error else {}),
        },
    )
    return None


def _apply_provider_result(
    invocation: AgentInvocation, result: ProviderResult | None
) -> None:
    if result is None:
        return
    invocation.input_tokens = result.input_tokens
    invocation.cached_input_tokens = result.cached_input_tokens
    invocation.output_tokens = result.output_tokens
    invocation.total_tokens = result.total_tokens


def _retry_prompt(prompt: str, feedback: str) -> str:
    return (
        f"{prompt}\n\nPREVIOUS ATTEMPT FEEDBACK:\n"
        f"The previous attempt at this task failed with:\n{feedback[:2000]}\n"
        "Diagnose the cause, fix it, and complete the task in this attempt."
    )


def _execution_progress(tasks: list[Task]) -> tuple[list[str], list[Task]]:
    completed_titles = [task.title for task in tasks if task.status == "completed"]
    remaining_tasks = [
        task for task in tasks if task.status in {"planned", "queued", "in_progress"}
    ]
    return completed_titles, remaining_tasks


def _reference_images_section(image_paths: list[str]) -> str:
    """Prompt section pointing the agent at user-attached image files."""
    if not image_paths:
        return ""
    listing = "\n".join(f"- {path}" for path in image_paths)
    return (
        "\n\nREFERENCE IMAGES:\n"
        "The user attached these images as context (for example an error screenshot or a "
        "UI design to match). Open and view each file before implementing, and treat what "
        "they show as requirements:\n"
        f"{listing}"
    )


def _execution_prompt(
    *,
    objective: Objective,
    project: Project,
    task: Task,
    agent: Agent,
    coding_standards: str,
    completed_tasks: list[str],
    image_paths: list[str] | None = None,
) -> str:
    completed = compact_completed_tasks(completed_tasks)
    return (
        f"You are the {agent.role} agent working inside the registered project repository. "
        "Implement the assigned task directly in the current workspace. Inspect the existing "
        "code before editing, preserve project conventions, and run the relevant checks. "
        "Do not merely describe changes: make the required file changes. Do not create a Git "
        "commit. If a project installer requires an empty target, install into a temporary "
        "directory inside the workspace and move its contents into the repository without "
        "replacing the existing .git directory. If the task is a review, fix any issues you "
        "find that are within scope. "
        "Finish with a concise summary of changed files and checks run."
        f"\n\nGLOBAL CODING STANDARDS:\n{compact_prompt_text(coding_standards, 6_000)}"
        f"\n\nPROJECT MEMORY ({project.name}):\n{compact_prompt_text(project.memory, 8_000)}"
        f"\n\nAGENT INSTRUCTIONS ({agent.name}):\n{compact_prompt_text(agent.instructions, 5_000)}"
        f"{_reference_images_section(image_paths or [])}"
        f"\n\nOBJECTIVE:\n{objective.title}"
        f"\nDescription: {compact_prompt_text(objective.description, 5_000)}"
        f"\n\nCOMPLETED TASKS:\n{completed}"
        f"\n\nASSIGNED TASK:\n{task.title}"
        f"\n{compact_prompt_text(task.description or 'No additional description', 8_000)}"
    )


def _verification_prompt(
    *,
    objective: Objective,
    project: Project,
    reviewer: Agent,
    criteria: list[VerificationCriterion],
    completed_tasks: list[str],
    test_evidence: VerificationEvidence,
) -> str:
    criteria_json = json.dumps(
        [
            {"criterion_id": str(item.id), "description": item.description}
            for item in criteria
        ],
        indent=2,
    )
    return (
        "You are the independent reviewer for a completed implementation. Inspect the final "
        "repository and use the deterministic test evidence supplied below. You may run additional "
        "read-only checks when useful. Do not edit files. Judge only the acceptance criteria "
        "below. A criterion passes only when repository evidence or check output demonstrates "
        "it; an implementation agent's claim is not evidence. "
        'Return ONLY JSON in the form {"criteria":[{"criterion_id":"...",'
        '"status":"passed|failed","evidence":"specific files, behavior, or check output"}],'
        '"summary":"..."}. Return exactly one result for every criterion.'
        f"\n\nPROJECT MEMORY ({project.name}):\n{compact_prompt_text(project.memory, 8_000)}"
        f"\n\nREVIEWER INSTRUCTIONS ({reviewer.name}):\n"
        f"{compact_prompt_text(reviewer.instructions, 5_000)}"
        f"\n\nOBJECTIVE:\n{objective.title}"
        f"\nDescription: {compact_prompt_text(objective.description, 5_000)}"
        f"\n\nCOMPLETED TASKS:\n{compact_completed_tasks(completed_tasks)}"
        f"\n\nDETERMINISTIC TEST EVIDENCE:\n"
        f"Status: {test_evidence.status}\n"
        f"Command: {test_evidence.command or 'No configured or detected test command'}\n"
        f"Exit code: {test_evidence.exit_code if test_evidence.exit_code is not None else 'n/a'}\n"
        f"Error: {test_evidence.error or 'none'}\n"
        f"Output:\n{compact_prompt_text(test_evidence.output_excerpt, 8_000)}"
        f"\n\nACCEPTANCE CRITERIA:\n{criteria_json}"
    )


def _json_candidates(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [
            candidate
            for child in value.values()
            for candidate in _json_candidates(child)
        ]
    if isinstance(value, list):
        return [candidate for child in value for candidate in _json_candidates(child)]
    return []


def _extract_verification(output: str) -> tuple[dict[str, tuple[str, str]], str] | None:
    candidates = [output]
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        candidates.extend(_json_candidates(event))
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            match = re.search(
                r'\{\s*"criteria"\s*:\s*\[.*\]\s*,\s*"summary"\s*:\s*".*?"\s*\}',
                candidate,
                re.DOTALL,
            )
            if not match:
                continue
            try:
                value = json.loads(match.group())
            except json.JSONDecodeError:
                continue
        if not isinstance(value, dict) or not isinstance(value.get("criteria"), list):
            continue
        results: dict[str, tuple[str, str]] = {}
        for item in value["criteria"]:
            if not isinstance(item, dict):
                continue
            criterion_id = item.get("criterion_id")
            criterion_status = item.get("status")
            evidence = item.get("evidence")
            if (
                isinstance(criterion_id, str)
                and criterion_status in {"passed", "failed"}
                and isinstance(evidence, str)
                and evidence.strip()
            ):
                results[criterion_id] = (criterion_status, evidence.strip()[:8000])
        summary = value.get("summary")
        return results, summary.strip()[:4000] if isinstance(summary, str) else ""
    return None


def _deterministic_gate_passed(evidence: VerificationEvidence | None) -> bool:
    return bool(evidence and evidence.status in {"passed", "skipped"})


async def _verification_test_heartbeat(
    run_id: uuid.UUID, evidence_id: uuid.UUID
) -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        try:
            async with async_session_factory() as session:
                run = await session.get(Run, run_id)
                evidence = await session.get(VerificationEvidence, evidence_id)
                if (
                    run is None
                    or evidence is None
                    or run.status != "executing"
                    or run.current_step != "verification_tests"
                    or evidence.status != "running"
                ):
                    return
                now = datetime.now(UTC)
                run.updated_at = now
                evidence.updated_at = now
                await session.commit()
        except Exception:
            logger.warning("verification_test_heartbeat_failed", exc_info=True)


async def _verify_run(run_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
        if (
            run is None
            or run.status != "executing"
            or run.current_step != "verification_queued"
        ):
            return
        objective = await session.get(Objective, run.objective_id)
        if objective is None:
            return
        project = await session.get(Project, objective.project_id)
        repository = (
            await session.get(Repository, run.repository_id) if run.repository_id else None
        )
        criteria = list(
            await session.scalars(
                select(VerificationCriterion)
                .where(VerificationCriterion.run_id == run.id)
                .order_by(VerificationCriterion.position)
            )
        )
        completed_tasks = list(
            await session.scalars(
                select(Task.title)
                .where(Task.run_id == run.id, Task.status == "completed")
                .order_by(Task.position)
            )
        )
        if not criteria:
            # Runs planned before the verification migration retain their legacy behavior.
            if repository is None:
                run.status = "failed"
                run.current_step = "integration_failed"
                objective.status = "failed"
                _preserve_worktree(run)
                await append_run_event(
                    session,
                    run.id,
                    "worktree.integration_failed",
                    {"detail": "The mission repository is unavailable"},
                )
                await session.commit()
                return
            integration_error = await _integrate_run_worktree(
                session, run, repository
            )
            if integration_error is not None:
                run.status = "failed"
                run.current_step = "integration_failed"
                objective.status = "failed"
                await session.commit()
                return
            run.status = "completed"
            run.current_step = "executed"
            objective.status = "completed"
            await append_run_event(
                session,
                run.id,
                "execution.completed",
                {"task_count": len(completed_tasks), "verification": "not_required"},
            )
            await session.commit()
            return
        if project is None or repository is None:
            run.status = "failed"
            run.current_step = "verification_failed"
            objective.status = "failed"
            _preserve_worktree(run)
            await append_run_event(
                session,
                run.id,
                "verification.failed",
                {"detail": "The project or repository is unavailable for verification"},
            )
            await session.commit()
            return
        workspace = (
            run.worktree_path
            if run.worktree_status in {"active", "preserved"} and run.worktree_path
            else provider_workspace(repository.path)
        )
        configured_command = (
            project.test_command.strip()
            if project.test_command and project.test_command.strip()
            else None
        )
        detection_path = (
            local_worktree_path(workspace)
            if run.worktree_status in {"active", "preserved"}
            else repository.path
        )
        test_command = configured_command or detect_commands(detection_path).test_command
        test_evidence = await session.scalar(
            select(VerificationEvidence).where(
                VerificationEvidence.run_id == run.id,
                VerificationEvidence.kind == "test",
            )
        )
        if test_evidence is None:
            test_evidence = VerificationEvidence(
                run_id=run.id,
                kind="test",
                status="running" if test_command else "skipped",
                command=test_command,
                started_at=datetime.now(UTC) if test_command else None,
                finished_at=None if test_command else datetime.now(UTC),
                error=None if test_command else "No configured or detected test command",
            )
            session.add(test_evidence)
        elif test_evidence.status == "running":
            test_evidence.command = test_command
            test_evidence.started_at = datetime.now(UTC) if test_command else None
            test_evidence.finished_at = None if test_command else datetime.now(UTC)
            test_evidence.status = "running" if test_command else "skipped"
            test_evidence.error = (
                None if test_command else "No configured or detected test command"
            )
        run.current_step = "verification_tests" if test_command else "verification_review"
        await append_run_event(
            session,
            run.id,
            "verification.tests_started" if test_command else "verification.tests_skipped",
            {"command": test_command or "", "reason": test_evidence.error or ""},
        )
        await session.commit()
        evidence_id = test_evidence.id
        should_run_tests = test_command is not None and test_evidence.status == "running"

    if should_run_tests and test_command is not None:
        last_flush = 0.0

        async def stream_test_output(tail: str) -> None:
            nonlocal last_flush
            now = time.monotonic()
            if now - last_flush < 2.0:
                return
            last_flush = now
            async with async_session_factory() as session:
                evidence = await session.get(VerificationEvidence, evidence_id)
                live_run = await session.get(Run, run_id)
                if evidence is not None and evidence.status == "running":
                    evidence.output_excerpt = tail[-VERIFICATION_OUTPUT_CHARS:]
                if live_run is not None and live_run.status == "executing":
                    live_run.updated_at = datetime.now(UTC)
                await session.commit()

        status = "error"
        exit_code: int | None = None
        output_excerpt: str | None = None
        test_error: str | None = None
        heartbeat = asyncio.create_task(
            _verification_test_heartbeat(run_id, evidence_id)
        )
        try:
            test_result = await RuntimeGatewayClient().run_command(
                workspace,
                test_command,
                timeout_seconds=VERIFICATION_TIMEOUT_SECONDS,
                on_output=stream_test_output,
                sandbox_id=str(run_id),
            )
        except Exception as error:
            test_error = str(error)[:4000]
        else:
            exit_code = test_result.exit_code
            output_excerpt = (
                f"{test_result.stdout}{test_result.stderr}"[-VERIFICATION_OUTPUT_CHARS:]
                or None
            )
            if test_result.timed_out:
                test_error = (
                    f"The command timed out after {VERIFICATION_TIMEOUT_SECONDS} seconds"
                )
            elif test_result.exit_code == 0:
                status = "passed"
            else:
                status = "failed"
        finally:
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat
        async with async_session_factory() as session:
            evidence = await session.get(VerificationEvidence, evidence_id)
            run = await session.get(Run, run_id)
            if evidence is None or run is None or run.status != "executing":
                return
            evidence.status = status
            evidence.exit_code = exit_code
            evidence.error = test_error
            evidence.finished_at = datetime.now(UTC)
            if output_excerpt is not None:
                evidence.output_excerpt = output_excerpt
            run.current_step = "verification_review"
            await append_run_event(
                session,
                run.id,
                "verification.tests_completed",
                {
                    "status": evidence.status,
                    "exit_code": evidence.exit_code,
                    "command": evidence.command or "",
                },
            )
            await session.commit()

    async with async_session_factory() as session:
        run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
        if run is None or run.status != "executing":
            return
        objective = await session.get(Objective, run.objective_id)
        project = await session.get(Project, objective.project_id) if objective else None
        criteria = list(
            await session.scalars(
                select(VerificationCriterion)
                .where(VerificationCriterion.run_id == run.id)
                .order_by(VerificationCriterion.position)
            )
        )
        completed_tasks = list(
            await session.scalars(
                select(Task.title)
                .where(Task.run_id == run.id, Task.status == "completed")
                .order_by(Task.position)
            )
        )
        test_evidence = await session.get(VerificationEvidence, evidence_id)
        reviewer = await session.scalar(
            select(Agent)
            .where(Agent.role == "reviewer", Agent.enabled.is_(True))
            .order_by(Agent.created_at)
            .limit(1)
        )
        if objective is None or project is None or reviewer is None or test_evidence is None:
            run.status = "failed"
            run.current_step = "verification_failed"
            _preserve_worktree(run)
            if objective is not None:
                objective.status = "failed"
            await append_run_event(
                session,
                run.id,
                "verification.failed",
                {
                    "detail": (
                        "The objective, project, deterministic evidence, or enabled reviewer "
                        "is unavailable"
                    )
                },
            )
            await session.commit()
            return
        workflow = await get_workflow_settings(session)
        prompt = _verification_prompt(
            objective=objective,
            project=project,
            reviewer=reviewer,
            criteria=criteria,
            completed_tasks=completed_tasks,
            test_evidence=test_evidence,
        )
        run.current_step = "verification_review"
        await append_run_event(
            session,
            run.id,
            "verification.started",
            {"criterion_count": len(criteria), "reviewer": reviewer.name},
        )
        await session.commit()
        reviewer_id = reviewer.id
        routes = provider_routes(
            reviewer.provider,
            reviewer.model,
            fallback_enabled=bool(workflow["enable_provider_fallback"]),
        )
        timeout_seconds = int(workflow["provider_timeout_seconds"])
        retain_output = bool(workflow["retain_invocation_output"])

    output = ""
    parsed: tuple[dict[str, tuple[str, str]], str] | None = None
    provider_result: ProviderResult | None = None
    failure: str | None = None
    invocation_id: uuid.UUID
    started_at = time.monotonic()
    for route_index, route in enumerate(routes):
        async with async_session_factory() as session:
            route_run = await session.get(Run, run_id)
            if (
                route_run is None
                or route_run.status != "executing"
                or route_run.current_step != "verification_review"
            ):
                return
            invocation = AgentInvocation(
                agent_id=reviewer_id,
                run_id=run_id,
                purpose="acceptance_verification",
                status="running",
                provider=route.provider,
                model=route.model,
                attempt=route.attempt,
                fallback_from_provider=route.fallback_from_provider,
                routing_reason=route.reason,
                input_excerpt=prompt[-4000:] if retain_output else None,
            )
            session.add(invocation)
            await session.commit()
            invocation_id = invocation.id

        output = ""
        parsed = None
        provider_result = None
        failure = None
        started_at = time.monotonic()
        heartbeat = asyncio.create_task(_heartbeat(invocation_id, run_id))
        try:
            provider_result = await ProviderGatewayClient().execute_result(
                route.provider,
                prompt,
                workspace=workspace,
                model=route.model,
                timeout_seconds=timeout_seconds,
                access_mode="read-only",
                usage_label=f"Verification · {objective.title}"[:160],
                sandbox_id=str(run_id),
            )
            output = provider_result.output
            parsed = _extract_verification(output)
            if parsed is None:
                failure = "Reviewer returned no valid structured verification result"
        except Exception as error:
            failure = str(error)
            error_result = getattr(error, "result", None)
            if isinstance(error_result, ProviderResult):
                provider_result = error_result
        finally:
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat

        if failure is None and parsed is not None:
            break
        if route_index + 1 >= len(routes):
            break
        fallback = routes[route_index + 1]
        async with async_session_factory() as session:
            failed_invocation = await session.get(AgentInvocation, invocation_id)
            route_run = await session.get(Run, run_id)
            if failed_invocation is None or route_run is None:
                return
            failed_invocation.status = "failed"
            _apply_provider_result(failed_invocation, provider_result)
            failed_invocation.duration_ms = int(
                (time.monotonic() - started_at) * 1000
            )
            failed_invocation.error = (failure or "Verification failed")[:4000]
            if retain_output and output:
                failed_invocation.output_excerpt = output[-4000:]
            await append_run_event(
                session,
                route_run.id,
                "provider.fallback",
                {
                    "purpose": "acceptance_verification",
                    "from_provider": route.provider,
                    "to_provider": fallback.provider,
                    "reason": (failure or "Invalid structured verification")[:500],
                },
            )
            await session.commit()

    async with async_session_factory() as session:
        run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
        objective = await session.get(Objective, run.objective_id) if run else None
        stored_invocation = await session.get(AgentInvocation, invocation_id)
        criteria = list(
            await session.scalars(
                select(VerificationCriterion)
                .where(VerificationCriterion.run_id == run_id)
                .order_by(VerificationCriterion.position)
            )
        )
        if (
            run is None
            or objective is None
            or stored_invocation is None
            or run.status != "executing"
            or run.current_step != "verification_review"
            or stored_invocation.status != "running"
        ):
            return
        stored_invocation.duration_ms = int((time.monotonic() - started_at) * 1000)
        _apply_provider_result(stored_invocation, provider_result)
        if retain_output and output:
            stored_invocation.output_excerpt = output[-4000:]
        now = datetime.now(UTC)
        if failure is not None or parsed is None:
            stored_invocation.status = "failed"
            stored_invocation.error = (failure or "Verification failed")[:4000]
            run.status = "failed"
            run.current_step = "verification_failed"
            objective.status = "failed"
            _preserve_worktree(run)
            if provider_result is not None and provider_result.rate_limited:
                await append_run_event(
                    session,
                    run.id,
                    "provider.rate_limited",
                    {
                        "purpose": "acceptance_verification",
                        "provider": route.provider,
                        "detail": failure or "Verification failed",
                    },
                )
            await append_run_event(
                session,
                run.id,
                "verification.failed",
                {"detail": failure or "Verification failed"},
            )
            await session.commit()
            return

        results, summary = parsed
        expected_ids = {str(item.id) for item in criteria}
        test_evidence = await session.get(VerificationEvidence, evidence_id)
        complete_result = set(results) == expected_ids
        deterministic_passed = _deterministic_gate_passed(test_evidence)
        all_passed = complete_result and deterministic_passed
        for criterion in criteria:
            criterion_result = results.get(str(criterion.id))
            if criterion_result is None:
                criterion.status = "failed"
                criterion.evidence = "The reviewer did not return a result for this criterion."
                all_passed = False
            else:
                criterion.status, criterion.evidence = criterion_result
                all_passed = all_passed and criterion.status == "passed"
            criterion.verifier_agent_id = stored_invocation.agent_id
            criterion.verified_at = now
        stored_invocation.status = "completed" if all_passed else "failed"
        if not all_passed:
            stored_invocation.error = (
                (
                    f"Deterministic project tests ended with status "
                    f"{test_evidence.status}. {summary}"
                )
                if test_evidence and test_evidence.status not in {"passed", "skipped"}
                else summary or "One or more acceptance criteria failed"
            )[:4000]
        if all_passed:
            repository = (
                await session.get(Repository, run.repository_id)
                if run.repository_id
                else None
            )
            integration_error = (
                await _integrate_run_worktree(session, run, repository)
                if repository is not None
                else "The mission repository is unavailable"
            )
            if integration_error is not None:
                _preserve_worktree(run)
                run.status = "failed"
                run.current_step = "integration_failed"
                objective.status = "failed"
                if repository is None:
                    await append_run_event(
                        session,
                        run.id,
                        "worktree.integration_failed",
                        {"detail": integration_error},
                    )
                await session.commit()
                return
            run.status = "completed"
            run.current_step = "verified"
            objective.status = "completed"
            await append_run_event(
                session,
                run.id,
                "verification.completed",
                {"criterion_count": len(criteria), "summary": summary},
            )
            await append_run_event(
                session,
                run.id,
                "execution.completed",
                {"task_count": len(completed_tasks), "verified": True},
            )
        else:
            run.status = "failed"
            run.current_step = "verification_failed"
            objective.status = "failed"
            _preserve_worktree(run)
            await append_run_event(
                session,
                run.id,
                "verification.failed",
                {
                    "failed_count": sum(item.status == "failed" for item in criteria),
                    "test_status": test_evidence.status if test_evidence else "error",
                    "summary": summary,
                },
            )
        await session.commit()


async def _checkpoint(workspace: str, message: str) -> tuple[str | None, str | None]:
    """Commit the workspace state and return ``(commit_sha, error)``."""
    try:
        return await ProviderGatewayClient().git_checkpoint(workspace, message), None
    except Exception as error:
        return None, str(error)[:2000]


def _provider_blocker(output: str) -> str | None:
    """Return the provider's final blocker report when execution could not proceed."""
    messages: list[str] = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = event.get("item") if isinstance(event, dict) else None
        if (
            isinstance(item, dict)
            and item.get("type") == "agent_message"
            and isinstance(item.get("text"), str)
        ):
            messages.append(item["text"].strip())

    final_message = messages[-1] if messages else ""
    normalized_output = output.lower()
    normalized_final = final_message.lower()
    known_runtime_failure = (
        "bwrap: no permissions to create a new namespace" in normalized_output
    )
    explicit_blocker = normalized_final.startswith(("blocked", "unable to proceed"))
    if not known_runtime_failure and not explicit_blocker:
        return None
    return final_message or "Provider reported that execution was blocked"


def _conflict_resolution_prompt(
    *,
    objective: Objective,
    project: Project,
    task: Task,
    agent: Agent,
    conflict_files: list[str],
    instructions: str,
) -> str:
    files = "\n".join(f"- {item}" for item in conflict_files) or "- Inspect Git status"
    return (
        f"You are the designated {agent.role} resolving a Git merge conflict inside an "
        "isolated, preserved task worktree. The current mission branch has already been "
        "merged with --no-commit, so the workspace contains the real conflict state. "
        "Resolve every conflict deliberately, preserving both the task's intent and valid "
        "mission changes. Inspect Git status and the surrounding code, remove all conflict "
        "markers, run relevant focused checks, and leave the workspace ready to commit. "
        "Do not run git merge, git rebase, git reset, git checkout, or git commit. Do not "
        "edit any other workspace. Finish with a concise explanation of each resolution and "
        "the checks you ran."
        f"\n\nPROJECT MEMORY:\n{compact_prompt_text(project.memory, 8_000)}"
        f"\n\nAGENT INSTRUCTIONS:\n{compact_prompt_text(agent.instructions, 5_000)}"
        f"\n\nOBJECTIVE:\n{objective.title}\n"
        f"{compact_prompt_text(objective.description or '', 5_000)}"
        f"\n\nTASK:\n{task.title}\n"
        f"{compact_prompt_text(task.description or '', 8_000)}"
        f"\n\nCONFLICT FILES:\n{files}"
        f"\n\nOPERATOR GUIDANCE:\n"
        f"{compact_prompt_text(instructions or 'No additional guidance.', 8_000)}"
    )


async def _fail_run(
    run: Run,
    objective: Objective,
    failed_task: Task,
    detail: str,
    checkpoint_sha: str | None = None,
    *,
    rate_limited: bool = False,
    rate_limit_provider: str | None = None,
) -> None:
    async with async_session_factory() as session:
        stored_run = await session.get(Run, run.id)
        stored_objective = await session.get(Objective, objective.id)
        stored_task = await session.get(Task, failed_task.id)
        if stored_run is None or stored_objective is None or stored_task is None:
            return
        running_invocations = list(
            await session.scalars(
                select(AgentInvocation).where(
                    AgentInvocation.task_id == stored_task.id,
                    AgentInvocation.status == "running",
                )
            )
        )
        for invocation in running_invocations:
            invocation.status = "failed"
            invocation.error = detail[:4000]
        stored_task.status = "failed"
        _preserve_task_worktree(stored_task)
        if checkpoint_sha is not None:
            stored_task.checkpoint_sha = checkpoint_sha
        remaining = list(
            await session.scalars(
                select(Task).where(
                    Task.run_id == stored_run.id,
                    Task.status.in_(("planned", "queued", "in_progress")),
                    Task.id != stored_task.id,
                )
            )
        )
        for task in remaining:
            task.status = "blocked"
            _preserve_task_worktree(task)
        stored_run.status = "failed"
        stored_run.current_step = "execution_failed"
        _preserve_worktree(stored_run)
        stored_objective.status = "failed"
        if rate_limited:
            await append_run_event(
                session,
                stored_run.id,
                "provider.rate_limited",
                {
                    "purpose": "task_execution",
                    "task_id": str(stored_task.id),
                    "provider": rate_limit_provider,
                    "detail": detail[:2000],
                },
            )
        await append_run_event(
            session,
            stored_run.id,
            "execution.failed",
            {
                "task_id": str(stored_task.id),
                "detail": detail[:2000],
                **({"checkpoint_sha": checkpoint_sha} if checkpoint_sha else {}),
            },
        )
        await session.commit()


async def _heartbeat(invocation_id: uuid.UUID, run_id: uuid.UUID) -> None:
    """Keep a silent provider invocation distinguishable from a dead worker."""
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        try:
            async with async_session_factory() as session:
                invocation = await session.get(AgentInvocation, invocation_id)
                run = await session.get(Run, run_id)
                if (
                    invocation is None
                    or run is None
                    or invocation.status != "running"
                    or run.status != "executing"
                ):
                    return
                now = datetime.now(UTC)
                invocation.updated_at = now
                run.updated_at = now
                await session.commit()
        except Exception:
            # A transient database interruption should not abort the provider
            # task. The next heartbeat retries, while the API itself will also
            # be unavailable and cannot incorrectly resume during the outage.
            logger.warning("execution_heartbeat_failed", exc_info=True)


async def _owns_task(
    session: AsyncSession,
    *,
    run_id: uuid.UUID,
    task_id: uuid.UUID,
    invocation_id: uuid.UUID,
) -> bool:
    """Return whether this actor still owns the task after a possible recovery."""
    run = await session.get(Run, run_id)
    task = await session.get(Task, task_id)
    invocation = await session.get(AgentInvocation, invocation_id)
    return bool(
        run is not None
        and task is not None
        and invocation is not None
        and run.status == "executing"
        and task.status == "in_progress"
        and invocation.status == "running"
    )


async def _execute(run_id: uuid.UUID) -> None:
    needs_worktree = False
    should_fan_out = False
    async with async_session_factory() as session:
        run = await session.scalar(
            select(Run).where(Run.id == run_id).with_for_update()
        )
        if run is None or run.status not in {"queued_for_execution", "executing"}:
            return
        objective = await session.get(Objective, run.objective_id)
        repository = await session.get(Repository, run.repository_id) if run.repository_id else None
        if objective is None or repository is None:
            return
        project = await session.get(Project, objective.project_id)
        if project is None:
            return
        standards = await session.get(SystemSetting, "coding_standards")
        workflow = await get_workflow_settings(session)
        tasks = list(
            await session.scalars(
                select(Task).where(Task.run_id == run.id).order_by(Task.position)
            )
        )
        _, remaining_tasks = _execution_progress(tasks)
        if not remaining_tasks:
            run.current_step = "verification_queued"
            await append_run_event(
                session,
                run.id,
                "verification.queued",
                {"criterion_source": "approved_plan"},
            )
            await session.commit()
            verify_run.send(str(run.id))
            return
        if not workflow["allow_repository_writes"]:
            first_task = remaining_tasks[0]
            if first_task is not None:
                first_task.status = "failed"
                for remaining_task in remaining_tasks[1:]:
                    if remaining_task.status in {"planned", "queued"}:
                        remaining_task.status = "blocked"
            run.status = "failed"
            run.current_step = "execution_failed"
            if objective is not None:
                objective.status = "failed"
            _preserve_worktree(run)
            await append_run_event(
                session,
                run.id,
                "execution.failed",
                {
                    **(
                        {"task_id": str(first_task.id)}
                        if first_task is not None
                        else {}
                    ),
                    "detail": "Repository writes were disabled before execution started",
                },
            )
            await session.commit()
            return
        if run.status == "queued_for_execution":
            should_fan_out = True
            needs_worktree = run.worktree_path is None
            run.status = "executing"
            run.current_step = (
                "execution_initializing" if needs_worktree else "execution"
            )
            objective.status = "executing"
            for queued_task in remaining_tasks:
                if queued_task.status == "planned":
                    queued_task.status = "queued"
            await append_run_event(
                session,
                run.id,
                "execution.started",
                {
                    "repository_id": str(repository.id),
                    "task_count": len(tasks),
                    "resumed": not needs_worktree,
                },
            )
            await session.commit()
        elif run.current_step == "execution_initializing":
            # Another copy of this message cannot claim work while the initial
            # actor is establishing the repository baseline.
            return
        source_workspace = provider_workspace(repository.path)
        workspace = (
            run.worktree_path
            if run.worktree_status in {"active", "preserved"} and run.worktree_path
            else source_workspace
        )
        standards_value = standards.value if standards else ""
        project_id = project.id
        objective_id = objective.id

    if needs_worktree:
        # Capture existing source edits once, then branch every mission change
        # into a linked worktree whose lifecycle is recorded on the run.
        _, baseline_error = await _checkpoint(
            source_workspace, "Checkpoint before mission execution"
        )
        if baseline_error is not None:
            await _fail_run(
                run,
                objective,
                remaining_tasks[0],
                f"Unable to create the pre-execution checkpoint: {baseline_error}",
            )
            return
        try:
            worktree = await ProviderGatewayClient().git_create_worktree(
                source_workspace, str(run_id)
            )
        except Exception as error:
            await _fail_run(
                run,
                objective,
                remaining_tasks[0],
                f"Unable to create the isolated mission worktree: {str(error)[:2000]}",
            )
            return
        async with async_session_factory() as session:
            stored_run = await session.get(Run, run_id)
            if stored_run is None or stored_run.status != "executing":
                return
            stored_run.current_step = "execution"
            stored_run.worktree_path = worktree.worktree
            stored_run.worktree_branch = worktree.branch
            stored_run.worktree_status = "active"
            stored_run.baseline_sha = worktree.baseline_sha
            await append_run_event(
                session,
                run_id,
                "worktree.created",
                {
                    "branch": worktree.branch,
                    "baseline_sha": worktree.baseline_sha,
                    "recovered": worktree.recovered,
                },
            )
            await session.commit()
        workspace = worktree.worktree

    if should_fan_out:
        for _ in range(max(0, int(workflow["max_parallel_tasks"]) - 1)):
            execute_run.send(str(run_id))

    # Each idempotent message claims one dependency-ready task. Multiple
    # messages may run concurrently, bounded by the configured parallel limit.
    async with async_session_factory() as session:
        run = await session.scalar(
            select(Run).where(Run.id == run_id).with_for_update()
        )
        if run is None or run.status != "executing":
            return
        objective = await session.get(Objective, objective_id)
        project = await session.get(Project, project_id)
        tasks = list(
            await session.scalars(
                select(Task).where(Task.run_id == run.id).order_by(Task.position)
            )
        )
        completed_titles, remaining_tasks = _execution_progress(tasks)
        if not remaining_tasks:
            run.current_step = "verification_queued"
            await append_run_event(
                session,
                run.id,
                "verification.queued",
                {"criterion_source": "approved_plan"},
            )
            await session.commit()
            verify_run.send(str(run.id))
            return
        in_progress_count = sum(
            task.status == "in_progress" for task in tasks
        )
        if in_progress_count >= int(workflow["max_parallel_tasks"]):
            return
        ready_tasks = _ready_tasks(tasks)
        active_tasks = [task for task in tasks if task.status == "in_progress"]
        if ready_tasks and active_tasks:
            claimable = _claimable_tasks(ready_tasks, active_tasks)
            if not claimable:
                # Every ready task overlaps an in-progress task; defer them and
                # let the next completion re-publish once the collision clears.
                deferred = ready_tasks[0]
                await append_run_event(
                    session,
                    run.id,
                    "task.serialized_for_overlap",
                    {
                        "task_id": str(deferred.id),
                        "title": deferred.title,
                        "detail": (
                            "Predicted files overlap a running task; execution is "
                            "serialized to avoid a merge conflict"
                        ),
                    },
                )
                await session.commit()
                return
            ready_tasks = claimable
        if not ready_tasks:
            if in_progress_count:
                return
            run.status = "failed"
            run.current_step = "execution_failed"
            if objective is not None:
                objective.status = "failed"
            _preserve_worktree(run)
            for remaining_task in remaining_tasks:
                remaining_task.status = "blocked"
            await append_run_event(
                session,
                run.id,
                "execution.failed",
                {"detail": "Task dependencies contain a cycle or missing prerequisite"},
            )
            await session.commit()
            return
        task = ready_tasks[0]
        agent = (
            await session.get(Agent, task.assigned_agent_id)
            if task.assigned_agent_id
            else None
        )
        if objective is None or project is None or agent is None:
            task.status = "failed"
            run.status = "failed"
            run.current_step = "execution_failed"
            _preserve_worktree(run)
            if objective is not None:
                objective.status = "failed"
            for remaining_task in remaining_tasks[1:]:
                remaining_task.status = "blocked"
            await append_run_event(
                session,
                run.id,
                "execution.failed",
                {
                    "task_id": str(task.id),
                    "detail": "Assigned agent or project is unavailable",
                },
            )
            await session.commit()
            return
        if not agent.enabled or agent.role != task.agent_role:
            task.status = "failed"
            run.status = "failed"
            run.current_step = "execution_failed"
            objective.status = "failed"
            _preserve_worktree(run)
            for remaining_task in remaining_tasks[1:]:
                remaining_task.status = "blocked"
            await append_run_event(
                session,
                run.id,
                "execution.failed",
                {
                    "task_id": str(task.id),
                    "detail": "Assigned agent is missing, disabled, or ineligible",
                },
            )
            await session.commit()
            return
        prompt = _execution_prompt(
            objective=objective,
            project=project,
            task=task,
            agent=agent,
            coding_standards=standards_value,
            completed_tasks=completed_titles,
            image_paths=await list_provider_attachment_paths(session, objective.id),
        )
        # Load-bearing guard against DB drift: a developer agent backed by an
        # HTTP provider cannot checkpoint file edits, so refuse before creating
        # the worktree rather than failing mid-execution.
        providers = await _provider_kind_map()
        if not can_assign_role(provider_kind(providers, agent.provider), agent.role):
            await _fail_run(run, objective, task, DEVELOPER_HTTP_ERROR)
            return
        routes = provider_routes(
            agent.provider,
            agent.model,
            fallback_enabled=bool(workflow["enable_provider_fallback"]),
            provider_map=providers,
        )
        primary_route = routes[0]
        invocation = AgentInvocation(
            agent_id=agent.id,
            run_id=run.id,
            task_id=task.id,
            purpose="task_execution",
            status="running",
            provider=primary_route.provider,
            model=primary_route.model,
            attempt=primary_route.attempt,
            fallback_from_provider=primary_route.fallback_from_provider,
            routing_reason=primary_route.reason,
            input_excerpt=prompt[-4000:] if bool(workflow["retain_invocation_output"]) else None,
        )
        task.status = "in_progress"
        run.current_step = (
            f"{in_progress_count + 1} parallel task"
            f"{'s' if in_progress_count else ''} running"
        )
        session.add(invocation)
        await append_run_event(
            session,
            run.id,
            "task.started",
            {
                "task_id": str(task.id),
                "title": task.title,
                "agent": agent.name,
                "attempt": 1,
                "provider": primary_route.provider,
            },
        )
        await session.commit()
        invocation_id = invocation.id
        task_id = task.id
        task_title = task.title
        agent_id = agent.id
        agent_provider = primary_route.provider
        agent_model = primary_route.model
        fallback_route = routes[1] if len(routes) > 1 else None
        mission_workspace = run.worktree_path
        task_workspace = (
            task.worktree_path if task.worktree_status == "active" else None
        )

    if not mission_workspace:
        await _fail_run(
            run,
            objective,
            task,
            "The isolated mission workspace is unavailable",
        )
        return
    if task_workspace is None:
        try:
            created_task_worktree = (
                await ProviderGatewayClient().git_create_task_worktree(
                    mission_workspace, str(task_id)
                )
            )
        except Exception as error:
            await _fail_run(
                run,
                objective,
                task,
                f"Unable to create the isolated task worktree: {str(error)[:2000]}",
            )
            return
        async with async_session_factory() as session:
            stored_run = await session.get(Run, run_id)
            stored_task = await session.get(Task, task_id)
            if stored_run is None or stored_task is None:
                return
            stored_task.worktree_path = created_task_worktree.worktree
            stored_task.worktree_branch = created_task_worktree.branch
            still_owned = (
                stored_run.status == "executing"
                and stored_task.status == "in_progress"
            )
            stored_task.worktree_status = "active" if still_owned else "preserved"
            stored_task.baseline_sha = created_task_worktree.baseline_sha
            await append_run_event(
                session,
                run_id,
                "task.worktree_created",
                {
                    "task_id": str(task_id),
                    "branch": created_task_worktree.branch,
                    "baseline_sha": created_task_worktree.baseline_sha,
                    "recovered": created_task_worktree.recovered,
                    "preserved": not still_owned,
                },
            )
            await session.commit()
            if not still_owned:
                return
        workspace = created_task_worktree.worktree
    else:
        workspace = task_workspace

    retain_output = bool(workflow["retain_invocation_output"])
    feedback: str | None = None
    for attempt in (1, 2):
        last_flush = 0.0
        if attempt == 2:
            async with async_session_factory() as session:
                run = await session.get(Run, run_id)
                retry_task = await session.get(Task, task_id)
                retry_invocation = await session.get(AgentInvocation, invocation_id)
                if run is None or retry_task is None or retry_invocation is None:
                    return
                if not await _owns_task(
                    session,
                    run_id=run_id,
                    task_id=task_id,
                    invocation_id=invocation_id,
                ):
                    return
                prompt = _retry_prompt(prompt, feedback or "Previous attempt failed")
                if retain_output:
                    retry_invocation.input_excerpt = prompt[-4000:]
                await append_run_event(
                    session,
                    run.id,
                    "task.retrying",
                    {
                        "task_id": str(task.id),
                        "title": retry_task.title,
                        "agent": agent.name,
                        "attempt": attempt,
                        "provider": agent_provider,
                        "previous_error": (feedback or "")[:500],
                    },
                )
                await session.commit()

        async def stream_output(
            tail: str, lease_invocation_id: uuid.UUID = invocation_id
        ) -> None:
            nonlocal last_flush
            now = time.monotonic()
            if now - last_flush < 2.0:
                return
            last_flush = now
            async with async_session_factory() as session:
                if not await _owns_task(
                    session,
                    run_id=run_id,
                    task_id=task_id,
                    invocation_id=lease_invocation_id,
                ):
                    raise RuntimeError("Execution lease was lost")
                live = await session.get(AgentInvocation, lease_invocation_id)
                if live is not None and retain_output:
                    live.output_excerpt = tail
                await session.commit()

        output = ""
        started_at = time.monotonic()
        failure: str | None = None
        provider_failure = False
        provider_result = None
        heartbeat = asyncio.create_task(_heartbeat(invocation_id, run_id))
        try:
            provider_result = await ProviderGatewayClient().execute_result(
                agent_provider,
                prompt,
                workspace=workspace,
                model=agent_model,
                timeout_seconds=int(workflow["provider_timeout_seconds"]),
                access_mode="workspace-write",
                usage_label=f"Task · {task_title}"[:160],
                on_output=stream_output,
                sandbox_id=str(run_id),
            )
            output = provider_result.output
        except Exception as error:
            failure = str(error)
            provider_failure = True
            error_result = getattr(error, "result", None)
            if isinstance(error_result, ProviderResult):
                provider_result = error_result
        else:
            failure = _provider_blocker(output)
        finally:
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat

        async with async_session_factory() as session:
            if not await _owns_task(
                session,
                run_id=run_id,
                task_id=task_id,
                invocation_id=invocation_id,
            ):
                return

        if failure is not None:
            if attempt == 1:
                feedback = failure
                use_fallback = provider_failure and fallback_route is not None
                if provider_failure and fallback_route is not None:
                    next_provider = fallback_route.provider
                    next_model = fallback_route.model
                else:
                    next_provider = agent_provider
                    next_model = agent_model
                async with async_session_factory() as session:
                    if not await _owns_task(
                        session,
                        run_id=run_id,
                        task_id=task_id,
                        invocation_id=invocation_id,
                    ):
                        return
                    failed_invocation = await session.get(
                        AgentInvocation, invocation_id
                    )
                    route_run = await session.get(Run, run_id)
                    if failed_invocation is None or route_run is None:
                        return
                    failed_invocation.status = "failed"
                    _apply_provider_result(failed_invocation, provider_result)
                    failed_invocation.duration_ms = int(
                        (time.monotonic() - started_at) * 1000
                    )
                    failed_invocation.error = failure[:4000]
                    if retain_output and output:
                        failed_invocation.output_excerpt = output[-4000:]
                    retry_invocation = AgentInvocation(
                        agent_id=agent_id,
                        run_id=run_id,
                        task_id=task_id,
                        purpose="task_execution",
                        status="running",
                        provider=next_provider,
                        model=next_model,
                        attempt=2,
                        fallback_from_provider=(
                            agent_provider if use_fallback else None
                        ),
                        routing_reason=(
                            "primary_provider_failed"
                            if use_fallback
                            else "task_retry"
                        ),
                        input_excerpt=prompt[-4000:] if retain_output else None,
                    )
                    session.add(retry_invocation)
                    if use_fallback:
                        await append_run_event(
                            session,
                            route_run.id,
                            "provider.fallback",
                            {
                                "purpose": "task_execution",
                                "task_id": str(task_id),
                                "from_provider": agent_provider,
                                "to_provider": next_provider,
                                "reason": failure[:500],
                            },
                        )
                    await session.commit()
                    invocation_id = retry_invocation.id
                agent_provider = next_provider
                agent_model = next_model
                continue
            # Commit whatever the failed attempts left behind so the partial
            # work stays reviewable and revertable instead of leaking into the
            # next mission's baseline checkpoint.
            failure_sha, failure_checkpoint_error = await _checkpoint(
                workspace,
                f"Task {len(completed_titles) + 1} (failed): {task_title}"[:200],
            )
            if failure_checkpoint_error is not None:
                failure = (
                    f"{failure}\n\nThe task's partial changes could not be "
                    f"checkpointed: {failure_checkpoint_error}"
                )
            async with async_session_factory() as session:
                failed_invocation = await session.get(AgentInvocation, invocation_id)
                if failed_invocation is not None:
                    _apply_provider_result(failed_invocation, provider_result)
                    failed_invocation.status = "failed"
                    failed_invocation.duration_ms = int(
                        (time.monotonic() - started_at) * 1000
                    )
                    failed_invocation.error = failure[:4000]
                    if retain_output and output:
                        failed_invocation.output_excerpt = output[-4000:]
                    await session.commit()
                failed_run = await session.get(Run, run_id)
                failed_objective = await session.get(Objective, objective_id)
                failed_task = await session.get(Task, task_id)
            if failed_run and failed_objective and failed_task:
                await _fail_run(
                    failed_run,
                    failed_objective,
                    failed_task,
                    failure,
                    failure_sha,
                    rate_limited=bool(provider_result and provider_result.rate_limited),
                    rate_limit_provider=agent_provider,
                )
            return

        checkpoint_message = f"Task {len(completed_titles) + 1}: {task_title}"[:200]
        checkpoint_sha, checkpoint_error = await _checkpoint(workspace, checkpoint_message)
        if checkpoint_error is not None:
            detail = f"Unable to checkpoint task changes: {checkpoint_error}"
            async with async_session_factory() as session:
                failed_invocation = await session.get(AgentInvocation, invocation_id)
                if failed_invocation is not None:
                    _apply_provider_result(failed_invocation, provider_result)
                    failed_invocation.status = "failed"
                    failed_invocation.duration_ms = int(
                        (time.monotonic() - started_at) * 1000
                    )
                    failed_invocation.error = detail[:4000]
                    if retain_output:
                        failed_invocation.output_excerpt = output[-4000:]
                    await session.commit()
                failed_run = await session.get(Run, run_id)
                failed_objective = await session.get(Objective, objective_id)
                failed_task = await session.get(Task, task_id)
            if failed_run and failed_objective and failed_task:
                await _fail_run(failed_run, failed_objective, failed_task, detail)
            return

        has_more = False
        async with async_session_factory() as session:
            stored_invocation = await session.get(AgentInvocation, invocation_id)
            stored_run = await session.scalar(
                select(Run).where(Run.id == run_id).with_for_update()
            )
            stored_task = await session.get(Task, task_id)
            if (
                stored_invocation is None
                or stored_run is None
                or stored_task is None
                or stored_invocation.status != "running"
                or stored_task.status != "in_progress"
                or stored_run.status != "executing"
            ):
                return
            integration_error = await _integrate_task_worktree(
                session, stored_run, stored_task
            )
            if integration_error is not None:
                stored_invocation.status = "failed"
                _apply_provider_result(stored_invocation, provider_result)
                stored_invocation.duration_ms = int(
                    (time.monotonic() - started_at) * 1000
                )
                stored_invocation.error = integration_error[:4000]
                if retain_output:
                    stored_invocation.output_excerpt = output[-4000:]
                stored_task.status = "failed"
                stored_task.checkpoint_sha = checkpoint_sha
                _preserve_task_worktree(stored_task)
                stored_run.status = "failed"
                stored_run.current_step = "task_integration_failed"
                _preserve_worktree(stored_run)
                stored_objective = await session.get(
                    Objective, stored_run.objective_id
                )
                if stored_objective is not None:
                    stored_objective.status = "failed"
                other_tasks = list(
                    await session.scalars(
                        select(Task).where(
                            Task.run_id == run_id,
                            Task.id != stored_task.id,
                            Task.status.in_(("planned", "queued", "in_progress")),
                        )
                    )
                )
                for other_task in other_tasks:
                    other_task.status = "blocked"
                    _preserve_task_worktree(other_task)
                running_invocations = list(
                    await session.scalars(
                        select(AgentInvocation).where(
                            AgentInvocation.run_id == run_id,
                            AgentInvocation.status == "running",
                            AgentInvocation.id != stored_invocation.id,
                        )
                    )
                )
                for running_invocation in running_invocations:
                    running_invocation.status = "failed"
                    running_invocation.error = (
                        "Execution stopped because a parallel task merge conflicted"
                    )
                if stored_task.conflict_files:
                    existing_approval = await session.scalar(
                        select(Approval.id).where(
                            Approval.run_id == stored_run.id,
                            Approval.kind == "task_integration",
                            Approval.status == "pending",
                        )
                    )
                    if existing_approval is None:
                        session.add(
                            Approval(
                                run_id=stored_run.id,
                                task_id=stored_task.id,
                                kind="task_integration",
                                status="pending",
                            )
                        )
                await append_run_event(
                    session,
                    stored_run.id,
                    "execution.failed",
                    {
                        "task_id": str(stored_task.id),
                        "detail": integration_error,
                        "checkpoint_sha": checkpoint_sha,
                    },
                )
                await session.commit()
                return
            stored_invocation.status = "completed"
            _apply_provider_result(stored_invocation, provider_result)
            stored_invocation.duration_ms = int((time.monotonic() - started_at) * 1000)
            if retain_output:
                stored_invocation.output_excerpt = output[-4000:]
            stored_task.status = "completed"
            stored_task.checkpoint_sha = checkpoint_sha
            await append_run_event(
                session,
                stored_run.id,
                "task.completed",
                {
                    "task_id": str(stored_task.id),
                    "title": stored_task.title,
                    "checkpoint_sha": checkpoint_sha,
                },
            )
            has_more = bool(
                await session.scalar(
                    select(Task.id)
                    .where(
                        Task.run_id == run_id,
                        Task.status.in_(("planned", "queued", "in_progress")),
                    )
                    .limit(1)
                )
            )
            if not has_more:
                stored_run.current_step = "verification_queued"
                await append_run_event(
                    session,
                    stored_run.id,
                    "verification.queued",
                    {"criterion_source": "approved_plan"},
                )
            await session.commit()
        if has_more:
            # Over-publication is safe because row locking and the parallel
            # limit make extra messages no-ops.
            for _ in range(int(workflow["max_parallel_tasks"])):
                execute_run.send(str(run_id))
        else:
            verify_run.send(str(run_id))
        return


async def _resolution_heartbeat(
    attempt_id: uuid.UUID,
    invocation_id: uuid.UUID,
) -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        try:
            async with async_session_factory() as session:
                attempt = await session.get(ConflictResolutionAttempt, attempt_id)
                invocation = await session.get(AgentInvocation, invocation_id)
                if (
                    attempt is None
                    or invocation is None
                    or attempt.status != "running"
                    or invocation.status != "running"
                ):
                    return
                now = datetime.now(UTC)
                attempt.updated_at = now
                invocation.updated_at = now
                await session.commit()
        except Exception:
            logger.warning("conflict_resolution_heartbeat_failed", exc_info=True)


async def _fail_resolution(
    attempt_id: uuid.UUID,
    detail: str,
    *,
    invocation_id: uuid.UUID | None = None,
    provider_result: ProviderResult | None = None,
    output: str = "",
    retain_output: bool = False,
) -> None:
    async with async_session_factory() as session:
        attempt = await session.get(ConflictResolutionAttempt, attempt_id)
        if attempt is None or attempt.status not in {"queued", "running"}:
            return
        attempt.status = "failed"
        attempt.error = detail[:4000]
        attempt.finished_at = datetime.now(UTC)
        if invocation_id:
            invocation = await session.get(AgentInvocation, invocation_id)
            if invocation is not None and invocation.status == "running":
                invocation.status = "failed"
                invocation.error = detail[:4000]
                _apply_provider_result(invocation, provider_result)
                if retain_output and output:
                    invocation.output_excerpt = output[-4000:]
        await append_run_event(
            session,
            attempt.run_id,
            "task.conflict_resolution_failed",
            {
                "task_id": str(attempt.task_id),
                "attempt_id": str(attempt.id),
                "detail": detail[:2000],
                "test_status": attempt.test_status,
            },
        )
        await session.commit()


async def _resolve_task_conflict(attempt_id: uuid.UUID) -> None:
    async with async_session_factory() as session:
        attempt = await session.scalar(
            select(ConflictResolutionAttempt)
            .where(ConflictResolutionAttempt.id == attempt_id)
            .with_for_update()
        )
        if attempt is None or attempt.status != "queued":
            return
        task = await session.get(Task, attempt.task_id)
        run = await session.get(Run, attempt.run_id)
        agent = await session.get(Agent, attempt.agent_id)
        objective = await session.get(Objective, run.objective_id) if run else None
        project = await session.get(Project, objective.project_id) if objective else None
        if (
            task is None
            or run is None
            or agent is None
            or objective is None
            or project is None
            or run.status != "failed"
            or run.current_step != "task_integration_failed"
            or not run.worktree_path
            or task.status != "failed"
            or task.worktree_status != "preserved"
            or not task.worktree_path
            or not task.worktree_branch
            or not task.baseline_sha
            or not task.conflict_files
            or not agent.enabled
            or agent.role not in {"developer", "qa", "reviewer"}
        ):
            attempt.status = "failed"
            attempt.error = "The preserved conflict or selected agent is no longer eligible"
            attempt.finished_at = datetime.now(UTC)
            await session.commit()
            return
        workflow = await get_workflow_settings(session)
        if not workflow["allow_repository_writes"]:
            attempt.status = "failed"
            attempt.error = "Repository writes are disabled in workflow settings"
            attempt.finished_at = datetime.now(UTC)
            await session.commit()
            return
        attempt.status = "running"
        attempt.started_at = datetime.now(UTC)
        await session.commit()
        workspace = task.worktree_path
        source_workspace = run.worktree_path
        branch = task.worktree_branch
        baseline_sha = task.baseline_sha
        original_conflicts = list(task.conflict_files)
        instructions = attempt.instructions
        agent_id = agent.id
        agent_provider = agent.provider
        agent_model = agent.model
        task_title = task.title

    # Conflict resolution also mutates the worktree, so the same developer +
    # HTTP-provider constraint applies.
    conflict_providers = await _provider_kind_map()
    if not can_assign_role(provider_kind(conflict_providers, agent_provider), agent.role):
        raise RuntimeError(DEVELOPER_HTTP_ERROR)

    try:
        prepared = await ProviderGatewayClient().git_prepare_task_resolution(
            source_workspace,
            workspace,
            branch,
            baseline_sha,
        )
    except Exception as error:
        await _fail_resolution(
            attempt_id, f"Unable to prepare the preserved merge: {error}"
        )
        return

    async with async_session_factory() as session:
        attempt = await session.get(ConflictResolutionAttempt, attempt_id)
        task = await session.get(Task, attempt.task_id) if attempt else None
        run = await session.get(Run, attempt.run_id) if attempt else None
        agent = await session.get(Agent, agent_id)
        objective = await session.get(Objective, run.objective_id) if run else None
        project = await session.get(Project, objective.project_id) if objective else None
        if (
            attempt is None
            or attempt.status != "running"
            or task is None
            or run is None
            or agent is None
            or objective is None
            or project is None
        ):
            return
        attempt.source_head = prepared.source_head
        attempt.branch_before_sha = prepared.branch_head
        attempt.conflict_files = prepared.conflict_files or original_conflicts
        prompt = _conflict_resolution_prompt(
            objective=objective,
            project=project,
            task=task,
            agent=agent,
            conflict_files=attempt.conflict_files,
            instructions=instructions,
        )
        invocation = AgentInvocation(
            agent_id=agent.id,
            run_id=run.id,
            task_id=task.id,
            purpose="conflict_resolution",
            status="running",
            provider=agent_provider,
            model=agent_model,
            attempt=1,
            routing_reason="operator_selected_conflict_resolver",
            input_excerpt=(
                prompt[-4000:]
                if bool(workflow["retain_invocation_output"])
                else None
            ),
        )
        session.add(invocation)
        await session.flush()
        attempt.invocation_id = invocation.id
        await append_run_event(
            session,
            run.id,
            "task.conflict_resolution_started",
            {
                "task_id": str(task.id),
                "attempt_id": str(attempt.id),
                "agent": agent.name,
                "provider": agent_provider,
                "source_head": prepared.source_head,
                "conflict_files": attempt.conflict_files,
                "recovered": prepared.recovered,
            },
        )
        await session.commit()
        invocation_id = invocation.id

    output = ""
    provider_result: ProviderResult | None = None
    last_flush = 0.0
    retain_output = bool(workflow["retain_invocation_output"])

    async def stream_output(tail: str) -> None:
        nonlocal last_flush
        now = time.monotonic()
        if now - last_flush < 2.0:
            return
        last_flush = now
        async with async_session_factory() as session:
            attempt = await session.get(ConflictResolutionAttempt, attempt_id)
            invocation = await session.get(AgentInvocation, invocation_id)
            if (
                attempt is None
                or invocation is None
                or attempt.status != "running"
                or invocation.status != "running"
            ):
                raise RuntimeError("Conflict resolution lease was lost")
            if retain_output:
                invocation.output_excerpt = tail
            await session.commit()

    heartbeat = asyncio.create_task(
        _resolution_heartbeat(attempt_id, invocation_id)
    )
    try:
        provider_result = await ProviderGatewayClient().execute_result(
            agent_provider,
            prompt,
            workspace=workspace,
            model=agent_model,
            timeout_seconds=int(workflow["provider_timeout_seconds"]),
            access_mode="workspace-write",
            usage_label=f"Conflict resolution · {task_title}"[:160],
            on_output=stream_output,
            sandbox_id=str(attempt_id),
        )
        output = provider_result.output
        blocker = _provider_blocker(output)
        if blocker:
            raise ProviderExecutionError(blocker, result=provider_result)
    except Exception as error:
        error_result = getattr(error, "result", None)
        if isinstance(error_result, ProviderResult):
            provider_result = error_result
        await _fail_resolution(
            attempt_id,
            f"Conflict resolver failed: {error}",
            invocation_id=invocation_id,
            provider_result=provider_result,
            output=output,
            retain_output=retain_output,
        )
        return
    finally:
        heartbeat.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat

    try:
        detected = detect_commands(local_worktree_path(workspace))
        test_command = project.test_command or detected.test_command
    except (OSError, ValueError) as error:
        await _fail_resolution(
            attempt_id,
            f"Unable to determine the conflict verification command: {error}",
            invocation_id=invocation_id,
            provider_result=provider_result,
            output=output,
            retain_output=retain_output,
        )
        return

    test_result = None
    if test_command:
        async with async_session_factory() as session:
            attempt = await session.get(ConflictResolutionAttempt, attempt_id)
            if attempt is None or attempt.status != "running":
                return
            attempt.test_command = test_command
            attempt.test_status = "running"
            await session.commit()
        try:
            test_result = await ProviderGatewayClient().run_command(
                workspace,
                test_command,
                timeout_seconds=VERIFICATION_TIMEOUT_SECONDS,
                sandbox_id=str(attempt_id),
            )
        except Exception as error:
            async with async_session_factory() as session:
                attempt = await session.get(ConflictResolutionAttempt, attempt_id)
                if attempt is not None and attempt.status == "running":
                    attempt.test_status = "error"
                    attempt.test_output_excerpt = str(error)[:12000]
                    await session.commit()
            await _fail_resolution(
                attempt_id,
                f"Conflict verification could not run: {error}",
                invocation_id=invocation_id,
                provider_result=provider_result,
                output=output,
                retain_output=retain_output,
            )
            return
        test_output = f"{test_result.stdout}\n{test_result.stderr}".strip()[-12000:]
        async with async_session_factory() as session:
            attempt = await session.get(ConflictResolutionAttempt, attempt_id)
            if attempt is None or attempt.status != "running":
                return
            attempt.test_exit_code = test_result.exit_code
            attempt.test_output_excerpt = test_output
            attempt.test_status = (
                "passed"
                if test_result.exit_code == 0 and not test_result.timed_out
                else "failed"
            )
            await session.commit()
        if test_result.exit_code != 0 or test_result.timed_out:
            await _fail_resolution(
                attempt_id,
                (
                    "Conflict verification timed out"
                    if test_result.timed_out
                    else f"Conflict verification failed with exit code {test_result.exit_code}"
                ),
                invocation_id=invocation_id,
                provider_result=provider_result,
                output=output,
                retain_output=retain_output,
            )
            return
    else:
        async with async_session_factory() as session:
            attempt = await session.get(ConflictResolutionAttempt, attempt_id)
            if attempt is None or attempt.status != "running":
                return
            attempt.test_status = "skipped"
            attempt.test_output_excerpt = (
                "No configured or detected project test command was available."
            )
            await session.commit()

    resolution_sha, checkpoint_error = await _checkpoint(
        workspace,
        f"Resolve task conflict: {task_title}"[:200],
    )
    if checkpoint_error or not resolution_sha:
        await _fail_resolution(
            attempt_id,
            (
                f"Resolved merge could not be checkpointed: {checkpoint_error}"
                if checkpoint_error
                else "Resolved merge produced no checkpoint"
            ),
            invocation_id=invocation_id,
            provider_result=provider_result,
            output=output,
            retain_output=retain_output,
        )
        return

    async with async_session_factory() as session:
        attempt = await session.get(ConflictResolutionAttempt, attempt_id)
        stored_invocation = await session.get(AgentInvocation, invocation_id)
        if attempt is None or attempt.status != "running":
            return
        attempt.status = "passed"
        attempt.resolution_sha = resolution_sha
        attempt.finished_at = datetime.now(UTC)
        attempt.error = None
        if stored_invocation is not None and stored_invocation.status == "running":
            stored_invocation.status = "completed"
            _apply_provider_result(stored_invocation, provider_result)
            if retain_output:
                stored_invocation.output_excerpt = output[-4000:]
        await append_run_event(
            session,
            attempt.run_id,
            "task.conflict_resolution_passed",
            {
                "task_id": str(attempt.task_id),
                "attempt_id": str(attempt.id),
                "resolution_sha": resolution_sha,
                "test_command": attempt.test_command or "",
                "test_status": attempt.test_status,
            },
        )
        await session.commit()


@dramatiq.actor(
    max_retries=2,
    min_backoff=2000,
    time_limit=RESOLUTION_ACTOR_TIME_LIMIT_MS,
)
def resolve_task_conflict_attempt(attempt_id: str) -> None:
    asyncio.run(_resolve_task_conflict(uuid.UUID(attempt_id)))


@dramatiq.actor(max_retries=3, min_backoff=1000, time_limit=TASK_ACTOR_TIME_LIMIT_MS)
def execute_run(run_id: str) -> None:
    asyncio.run(_execute(uuid.UUID(run_id)))


@dramatiq.actor(
    max_retries=2,
    min_backoff=2000,
    time_limit=VERIFICATION_ACTOR_TIME_LIMIT_MS,
)
def verify_run(run_id: str) -> None:
    asyncio.run(_verify_run(uuid.UUID(run_id)))
