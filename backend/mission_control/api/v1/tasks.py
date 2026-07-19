from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.run_events import append_run_event
from mission_control.application.services.settings import get_workflow_settings
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import (
    Agent,
    ConflictResolutionAttempt,
    Repository,
    Run,
    Task,
)
from mission_control.infrastructure.database.session import get_session
from mission_control.infrastructure.git.inspector import RepositoryInspector
from mission_control.infrastructure.providers.gateway_client import (
    ProviderExecutionError,
    ProviderGatewayClient,
    provider_workspace,
)

router = APIRouter(prefix="/tasks", tags=["tasks"])

MAX_DIFF_CHARS = 200_000


class TaskResponse(BaseModel):
    id: uuid.UUID
    objective_id: uuid.UUID
    run_id: uuid.UUID | None
    position: int
    depends_on_positions: list[int]
    title: str
    description: str | None
    status: str
    agent_role: str
    assigned_agent_id: uuid.UUID | None
    checkpoint_sha: str | None
    worktree_branch: str | None
    worktree_status: str | None
    integration_sha: str | None
    conflict_files: list[str]
    conflict_detail: str | None
    conflict_detected_at: datetime | None

    model_config = {"from_attributes": True}


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    _: Annotated[str, Depends(require_local_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    objective_id: uuid.UUID | None = None,
    limit: int = Query(50, ge=1, le=100),
) -> list[TaskResponse]:
    query = select(Task).order_by(Task.created_at.desc()).limit(limit)
    if objective_id:
        query = query.where(Task.objective_id == objective_id)
    result = await session.scalars(query)
    return [TaskResponse.model_validate(item) for item in result]


class TaskDiffResponse(BaseModel):
    task_id: uuid.UUID
    commit_sha: str
    diff: str
    truncated: bool


class ConflictResolutionResponse(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    run_id: uuid.UUID
    agent_id: uuid.UUID
    agent_name: str
    invocation_id: uuid.UUID | None
    status: str
    instructions: str
    source_head: str | None
    branch_before_sha: str | None
    resolution_sha: str | None
    conflict_files: list[str]
    test_command: str | None
    test_status: str
    test_exit_code: int | None
    test_output_excerpt: str | None
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime


class TaskConflictResponse(BaseModel):
    task_id: uuid.UUID
    branch: str
    workspace: str
    source_head: str
    branch_head: str
    conflict_files: list[str]
    task_changes: str
    mission_changes: str
    diff: str
    truncated: bool
    latest_resolution: ConflictResolutionResponse | None


class ConflictResolutionRequest(BaseModel):
    agent_id: uuid.UUID
    instructions: str = Field(default="", max_length=8000)


def _resolution_response(
    attempt: ConflictResolutionAttempt,
    agent: Agent,
) -> ConflictResolutionResponse:
    return ConflictResolutionResponse(
        id=attempt.id,
        task_id=attempt.task_id,
        run_id=attempt.run_id,
        agent_id=attempt.agent_id,
        agent_name=agent.name,
        invocation_id=attempt.invocation_id,
        status=attempt.status,
        instructions=attempt.instructions,
        source_head=attempt.source_head,
        branch_before_sha=attempt.branch_before_sha,
        resolution_sha=attempt.resolution_sha,
        conflict_files=attempt.conflict_files,
        test_command=attempt.test_command,
        test_status=attempt.test_status,
        test_exit_code=attempt.test_exit_code,
        test_output_excerpt=attempt.test_output_excerpt,
        error=attempt.error,
        started_at=attempt.started_at,
        finished_at=attempt.finished_at,
        created_at=attempt.created_at,
        updated_at=attempt.updated_at,
    )


@router.get("/{task_id}/conflict", response_model=TaskConflictResponse)
async def task_conflict(
    task_id: uuid.UUID,
    _: Annotated[str, Depends(require_local_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TaskConflictResponse:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    run = await session.get(Run, task.run_id) if task.run_id else None
    if (
        run is None
        or not run.worktree_path
        or task.worktree_status != "preserved"
        or not task.worktree_path
        or not task.worktree_branch
        or not task.baseline_sha
        or not task.conflict_files
    ):
        raise HTTPException(
            status_code=409,
            detail="This task has no preserved integration conflict",
        )
    try:
        report = await ProviderGatewayClient().git_task_worktree_report(
            run.worktree_path,
            task.worktree_path,
            task.worktree_branch,
            task.baseline_sha,
        )
    except ProviderExecutionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=503, detail=f"Unable to reach the provider gateway: {error}"
        ) from error
    truncated = len(report.diff) > MAX_DIFF_CHARS
    resolution_row = (
        await session.execute(
            select(ConflictResolutionAttempt, Agent)
            .join(Agent, Agent.id == ConflictResolutionAttempt.agent_id)
            .where(ConflictResolutionAttempt.task_id == task.id)
            .order_by(ConflictResolutionAttempt.created_at.desc())
            .limit(1)
        )
    ).first()
    return TaskConflictResponse(
        task_id=task.id,
        branch=task.worktree_branch,
        workspace=task.worktree_path,
        source_head=report.source_head,
        branch_head=report.branch_head,
        conflict_files=task.conflict_files,
        task_changes=report.task_changes,
        mission_changes=report.mission_changes,
        diff=report.diff[:MAX_DIFF_CHARS],
        truncated=truncated,
        latest_resolution=(
            _resolution_response(*resolution_row) if resolution_row else None
        ),
    )


@router.post(
    "/{task_id}/conflict/resolve",
    response_model=ConflictResolutionResponse,
    status_code=202,
)
async def resolve_task_conflict(
    task_id: uuid.UUID,
    payload: ConflictResolutionRequest,
    _: Annotated[str, Depends(require_local_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ConflictResolutionResponse:
    task = await session.scalar(
        select(Task).where(Task.id == task_id).with_for_update()
    )
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    run = await session.get(Run, task.run_id) if task.run_id else None
    if (
        run is None
        or run.status != "failed"
        or run.current_step != "task_integration_failed"
        or not run.worktree_path
        or task.status != "failed"
        or task.worktree_status != "preserved"
        or not task.worktree_path
        or not task.worktree_branch
        or not task.baseline_sha
        or not task.conflict_files
    ):
        raise HTTPException(
            status_code=409,
            detail="This task has no eligible preserved integration conflict",
        )
    workflow = await get_workflow_settings(session)
    if not workflow["allow_repository_writes"]:
        raise HTTPException(
            status_code=409,
            detail="Repository writes are disabled in workflow settings",
        )
    agent = await session.get(Agent, payload.agent_id)
    if (
        agent is None
        or not agent.enabled
        or agent.role not in {"developer", "qa", "reviewer"}
    ):
        raise HTTPException(
            status_code=409,
            detail="Choose an enabled developer, QA, or reviewer agent",
        )
    active = await session.scalar(
        select(ConflictResolutionAttempt.id).where(
            ConflictResolutionAttempt.task_id == task.id,
            ConflictResolutionAttempt.status.in_(("queued", "running")),
        )
    )
    if active is not None:
        raise HTTPException(
            status_code=409,
            detail="A conflict resolution attempt is already active",
        )
    attempt = ConflictResolutionAttempt(
        task_id=task.id,
        run_id=run.id,
        agent_id=agent.id,
        status="queued",
        instructions=payload.instructions.strip(),
        conflict_files=task.conflict_files,
        test_status="pending",
    )
    session.add(attempt)
    await append_run_event(
        session,
        run.id,
        "task.conflict_resolution_queued",
        {
            "task_id": str(task.id),
            "attempt_id": str(attempt.id),
            "agent_id": str(agent.id),
            "agent": agent.name,
        },
    )
    await session.commit()
    await session.refresh(attempt)
    try:
        from mission_control.workers.actors.executor import resolve_task_conflict_attempt

        resolve_task_conflict_attempt.send(str(attempt.id))
    except Exception as error:
        attempt.status = "failed"
        attempt.error = f"Resolution was saved but the worker could not be queued: {error}"[:4000]
        attempt.finished_at = datetime.now(UTC)
        await session.commit()
        raise HTTPException(status_code=503, detail=attempt.error) from error
    return _resolution_response(attempt, agent)


@router.get("/{task_id}/diff", response_model=TaskDiffResponse)
async def task_diff(
    task_id: uuid.UUID,
    _: Annotated[str, Depends(require_local_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TaskDiffResponse:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task.checkpoint_sha:
        raise HTTPException(status_code=404, detail="No checkpoint was recorded for this task")
    run = await session.get(Run, task.run_id) if task.run_id else None
    repository = (
        await session.get(Repository, run.repository_id)
        if run and run.repository_id
        else None
    )
    if repository is None:
        raise HTTPException(
            status_code=409, detail="The task's repository is no longer registered"
        )
    try:
        diff = await RepositoryInspector().commit_diff(
            Path(repository.path), task.checkpoint_sha
        )
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    truncated = len(diff) > MAX_DIFF_CHARS
    return TaskDiffResponse(
        task_id=task.id,
        commit_sha=task.checkpoint_sha,
        diff=diff[:MAX_DIFF_CHARS],
        truncated=truncated,
    )


@router.post("/{task_id}/revert", response_model=TaskResponse)
async def revert_task(
    task_id: uuid.UUID,
    _: Annotated[str, Depends(require_local_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TaskResponse:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status not in {"completed", "failed"}:
        raise HTTPException(
            status_code=409, detail="Only completed or failed tasks can be reverted"
        )
    if not task.checkpoint_sha:
        raise HTTPException(status_code=409, detail="No checkpoint was recorded for this task")
    run = await session.get(Run, task.run_id) if task.run_id else None
    if run is None:
        raise HTTPException(status_code=409, detail="The task is not linked to a run")
    if run.status not in {"completed", "failed"}:
        raise HTTPException(
            status_code=409, detail="Wait for the run to finish before reverting tasks"
        )
    repository = (
        await session.get(Repository, run.repository_id) if run.repository_id else None
    )
    if repository is None:
        raise HTTPException(
            status_code=409, detail="The task's repository is no longer registered"
        )
    try:
        workspace = (
            task.worktree_path
            if task.worktree_status in {"active", "preserved"}
            and task.worktree_path
            else run.worktree_path
            if run.worktree_status in {"active", "preserved"} and run.worktree_path
            else provider_workspace(repository.path)
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    try:
        revert_sha = await ProviderGatewayClient().git_revert(workspace, task.checkpoint_sha)
    except ProviderExecutionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=503, detail=f"Unable to reach the provider gateway: {error}"
        ) from error
    task.status = "reverted"
    await append_run_event(
        session,
        run.id,
        "task.reverted",
        {
            "task_id": str(task.id),
            "commit_sha": task.checkpoint_sha,
            "revert_sha": revert_sha,
        },
    )
    await session.commit()
    await session.refresh(task)
    return TaskResponse.model_validate(task)


class TaskAssignment(BaseModel):
    agent_id: uuid.UUID | None


@router.put("/{task_id}/assignment", response_model=TaskResponse)
async def assign_task(
    task_id: uuid.UUID,
    payload: TaskAssignment,
    _: Annotated[str, Depends(require_local_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TaskResponse:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status != "planned":
        raise HTTPException(
            status_code=409,
            detail="Only planned tasks can be reassigned",
        )
    if payload.agent_id is not None:
        agent = await session.get(Agent, payload.agent_id)
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        if not agent.enabled:
            raise HTTPException(status_code=409, detail="Disabled agents cannot receive tasks")
        if agent.role != task.agent_role:
            raise HTTPException(
                status_code=409,
                detail=f"This task requires a {task.agent_role} agent",
            )
    task.assigned_agent_id = payload.agent_id
    await session.commit()
    await session.refresh(task)
    return TaskResponse.model_validate(task)
