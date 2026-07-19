from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.run_events import append_run_event
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import Agent, Repository, Run, Task
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
    title: str
    description: str | None
    status: str
    agent_role: str
    assigned_agent_id: uuid.UUID | None
    checkpoint_sha: str | None

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
    if task.status != "completed":
        raise HTTPException(status_code=409, detail="Only completed tasks can be reverted")
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
        workspace = provider_workspace(repository.path)
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
