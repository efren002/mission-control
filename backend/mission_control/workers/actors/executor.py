from __future__ import annotations

import asyncio
import json
import logging
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
from mission_control.application.services.run_events import append_run_event
from mission_control.application.services.settings import get_workflow_settings
from mission_control.infrastructure.database.models import (
    Agent,
    AgentInvocation,
    Objective,
    Project,
    Repository,
    Run,
    SystemSetting,
    Task,
)
from mission_control.infrastructure.database.session import async_session_factory
from mission_control.infrastructure.providers.gateway_client import (
    ProviderGatewayClient,
    provider_workspace,
)
from mission_control.infrastructure.queue.broker import broker as broker

HEARTBEAT_SECONDS = 5
# One actor handles one task with at most two 30-minute provider attempts.
TASK_ACTOR_TIME_LIMIT_MS = 65 * 60 * 1000
logger = logging.getLogger(__name__)


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


async def _fail_run(run: Run, objective: Objective, failed_task: Task, detail: str) -> None:
    async with async_session_factory() as session:
        stored_run = await session.get(Run, run.id)
        stored_objective = await session.get(Objective, objective.id)
        stored_task = await session.get(Task, failed_task.id)
        if stored_run is None or stored_objective is None or stored_task is None:
            return
        stored_task.status = "failed"
        remaining = list(
            await session.scalars(
                select(Task).where(
                    Task.run_id == stored_run.id,
                    Task.status.in_(("planned", "queued")),
                )
            )
        )
        for task in remaining:
            task.status = "blocked"
        stored_run.status = "failed"
        stored_run.current_step = "execution_failed"
        stored_objective.status = "failed"
        await append_run_event(
            session,
            stored_run.id,
            "execution.failed",
            {"task_id": str(stored_task.id), "detail": detail[:2000]},
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
    needs_baseline = False
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
                select(Task).where(Task.run_id == run.id).order_by(Task.created_at)
            )
        )
        _, remaining_tasks = _execution_progress(tasks)
        if not remaining_tasks:
            run.status = "completed"
            run.current_step = "executed"
            objective.status = "completed"
            await append_run_event(
                session,
                run.id,
                "execution.completed",
                {"task_count": len(tasks)},
            )
            await session.commit()
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
            objective.status = "failed"
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
            needs_baseline = run.current_step != "execution_resuming"
            run.status = "executing"
            run.current_step = "execution_initializing" if needs_baseline else "execution"
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
                    "resumed": not needs_baseline,
                },
            )
            await session.commit()
        elif run.current_step == "execution_initializing":
            # Another copy of this message cannot claim work while the initial
            # actor is establishing the repository baseline.
            return
        workspace = provider_workspace(repository.path)
        standards_value = standards.value if standards else ""
        project_id = project.id
        objective_id = objective.id

    if needs_baseline:
        # Only a brand-new execution gets a baseline. On recovery, pending
        # workspace edits belong to the interrupted task and must remain part
        # of that task's eventual checkpoint/undo boundary.
        baseline_sha, baseline_error = await _checkpoint(
            workspace, "Checkpoint before mission execution"
        )
        if baseline_error is not None:
            await _fail_run(
                run,
                objective,
                remaining_tasks[0],
                f"Unable to create the pre-execution checkpoint: {baseline_error}",
            )
            return
        async with async_session_factory() as session:
            stored_run = await session.get(Run, run_id)
            if stored_run is None or stored_run.status != "executing":
                return
            stored_run.current_step = "execution"
            if baseline_sha is not None:
                await append_run_event(
                    session, run_id, "execution.checkpoint", {"commit_sha": baseline_sha}
                )
            await session.commit()

    # Claim exactly one task. A mission progresses through one durable queue
    # message per task, keeping every actor below its own time limit.
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
                select(Task).where(Task.run_id == run.id).order_by(Task.created_at)
            )
        )
        if any(task.status == "in_progress" for task in tasks):
            return
        completed_titles, remaining_tasks = _execution_progress(tasks)
        if not remaining_tasks:
            run.status = "completed"
            run.current_step = "executed"
            if objective is not None:
                objective.status = "completed"
            await append_run_event(
                session,
                run.id,
                "execution.completed",
                {"task_count": len(completed_titles)},
            )
            await session.commit()
            return
        task = remaining_tasks[0]
        agent = (
            await session.get(Agent, task.assigned_agent_id)
            if task.assigned_agent_id
            else None
        )
        if objective is None or project is None or agent is None:
            task.status = "failed"
            run.status = "failed"
            run.current_step = "execution_failed"
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
        invocation = AgentInvocation(
            agent_id=agent.id,
            run_id=run.id,
            task_id=task.id,
            purpose="task_execution",
            status="running",
            input_excerpt=prompt[-4000:] if bool(workflow["retain_invocation_output"]) else None,
        )
        task.status = "in_progress"
        run.current_step = task.title[:100]
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
            },
        )
        await session.commit()
        invocation_id = invocation.id
        task_id = task.id
        task_title = task.title
        agent_provider = agent.provider
        agent_model = agent.model

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
                await append_run_event(
                    session,
                    run.id,
                    "task.retrying",
                    {
                        "task_id": str(task.id),
                        "title": retry_task.title,
                        "agent": agent.name,
                        "attempt": attempt,
                        "previous_error": (feedback or "")[:500],
                    },
                )
                await session.commit()

        async def stream_output(tail: str) -> None:
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
                    invocation_id=invocation_id,
                ):
                    raise RuntimeError("Execution lease was lost")
                live = await session.get(AgentInvocation, invocation_id)
                if live is not None:
                    live.output_excerpt = tail
                    await session.commit()

        output = ""
        started_at = time.monotonic()
        failure: str | None = None
        heartbeat = asyncio.create_task(_heartbeat(invocation_id, run_id))
        try:
            output = await ProviderGatewayClient().execute(
                agent_provider,
                prompt,
                workspace=workspace,
                model=agent_model,
                timeout_seconds=int(workflow["provider_timeout_seconds"]),
                access_mode="workspace-write",
                usage_label=f"Task · {task_title}"[:160],
                on_output=stream_output if retain_output else None,
            )
        except Exception as error:
            failure = str(error)
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
                continue
            async with async_session_factory() as session:
                failed_invocation = await session.get(AgentInvocation, invocation_id)
                if failed_invocation is not None:
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
                await _fail_run(failed_run, failed_objective, failed_task, failure)
            return

        checkpoint_message = f"Task {len(completed_titles) + 1}: {task_title}"[:200]
        checkpoint_sha, checkpoint_error = await _checkpoint(workspace, checkpoint_message)
        if checkpoint_error is not None:
            detail = f"Unable to checkpoint task changes: {checkpoint_error}"
            async with async_session_factory() as session:
                failed_invocation = await session.get(AgentInvocation, invocation_id)
                if failed_invocation is not None:
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
            stored_invocation.status = "completed"
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
                        Task.status.in_(("planned", "queued")),
                    )
                    .limit(1)
                )
            )
            if not has_more:
                objective = await session.get(Objective, objective_id)
                stored_run.status = "completed"
                stored_run.current_step = "executed"
                if objective is not None:
                    objective.status = "completed"
                await append_run_event(
                    session,
                    stored_run.id,
                    "execution.completed",
                    {"task_count": len(completed_titles) + 1},
                )
            await session.commit()
        if has_more:
            # If publication fails, Dramatiq retries this actor. The retry sees
            # the completed task and safely claims the next queued task.
            execute_run.send(str(run_id))
        return


@dramatiq.actor(max_retries=3, min_backoff=1000, time_limit=TASK_ACTOR_TIME_LIMIT_MS)
def execute_run(run_id: str) -> None:
    asyncio.run(_execute(uuid.UUID(run_id)))
