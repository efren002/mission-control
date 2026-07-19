from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.catalog import CatalogService
from mission_control.application.services.run_events import append_run_event
from mission_control.application.services.settings import get_workflow_settings
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import (
    Agent,
    AgentInvocation,
    Approval,
    Objective,
    Project,
    Repository,
    Run,
    RunEvent,
    Task,
    VerificationCriterion,
    VerificationEvidence,
)
from mission_control.infrastructure.database.session import get_session

router = APIRouter(prefix="/runs", tags=["runs"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]
STALE_QUEUE_AFTER = timedelta(minutes=2)
STALE_EXECUTION_AFTER = timedelta(minutes=5)


class RunSummary(BaseModel):
    id: uuid.UUID
    objective_id: uuid.UUID
    project_id: uuid.UUID
    objective_title: str
    repository_id: uuid.UUID | None
    status: str
    current_step: str | None
    worktree_branch: str | None
    worktree_status: str | None
    baseline_sha: str | None
    integration_sha: str | None
    task_count: int
    approval_status: str | None
    created_at: datetime
    updated_at: datetime


class RunTaskResponse(BaseModel):
    id: uuid.UUID
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


class RunEventResponse(BaseModel):
    id: uuid.UUID
    sequence: int
    event_type: str
    payload: dict[str, object]
    created_at: datetime

    model_config = {"from_attributes": True}


class RunInvocationResponse(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    agent_name: str
    purpose: str
    status: str
    provider: str | None
    model: str | None
    attempt: int
    fallback_from_provider: str | None
    routing_reason: str | None
    duration_ms: int | None
    input_tokens: int | None
    cached_input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    input_excerpt: str | None
    output_excerpt: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime


class RunApprovalResponse(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID | None
    kind: str
    status: str
    decision_reason: str | None
    decided_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class VerificationCriterionResponse(BaseModel):
    id: uuid.UUID
    position: int
    description: str
    status: str
    evidence: str | None
    verifier_agent_id: uuid.UUID | None
    verified_at: datetime | None

    model_config = {"from_attributes": True}


class VerificationEvidenceResponse(BaseModel):
    id: uuid.UUID
    kind: str
    status: str
    command: str | None
    exit_code: int | None
    output_excerpt: str | None
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class RunDetail(RunSummary):
    tasks: list[RunTaskResponse]
    events: list[RunEventResponse]
    invocations: list[RunInvocationResponse]
    approvals: list[RunApprovalResponse]
    verification_criteria: list[VerificationCriterionResponse]
    verification_evidence: list[VerificationEvidenceResponse]


class ExecutionRequest(BaseModel):
    repository_id: uuid.UUID | None = None


class ResumeExecutionResponse(BaseModel):
    id: uuid.UUID
    status: str
    current_step: str | None
    recovered_tasks: int


async def _summaries(
    session: AsyncSession,
    rows: Sequence[tuple[Run, uuid.UUID, str]],
) -> list[RunSummary]:
    run_ids = [run.id for run, _, _ in rows]
    task_counts: dict[uuid.UUID, int] = {}
    approval_statuses: dict[uuid.UUID, str] = {}
    if run_ids:
        task_count_rows = (
            await session.execute(
                select(Task.run_id, func.count())
                .where(Task.run_id.in_(run_ids))
                .group_by(Task.run_id)
            )
        ).tuples()
        task_counts = {
            run_id: count
            for run_id, count in task_count_rows
            if run_id is not None
        }
        latest_first = await session.execute(
            select(Approval.run_id, Approval.status)
            .where(Approval.run_id.in_(run_ids))
            .order_by(Approval.created_at.desc())
        )
        for run_id, approval_status in latest_first:
            approval_statuses.setdefault(run_id, approval_status)
    return [
        RunSummary(
            id=run.id,
            objective_id=run.objective_id,
            project_id=project_id,
            objective_title=objective_title,
            repository_id=run.repository_id,
            status=run.status,
            current_step=run.current_step,
            worktree_branch=run.worktree_branch,
            worktree_status=run.worktree_status,
            baseline_sha=run.baseline_sha,
            integration_sha=run.integration_sha,
            task_count=task_counts.get(run.id, 0),
            approval_status=approval_statuses.get(run.id),
            created_at=run.created_at,
            updated_at=run.updated_at,
        )
        for run, project_id, objective_title in rows
    ]


async def _summary(
    session: AsyncSession,
    run: Run,
    project_id: uuid.UUID,
    objective_title: str,
) -> RunSummary:
    return (await _summaries(session, [(run, project_id, objective_title)]))[0]


@router.get("", response_model=list[RunSummary])
async def list_runs(
    _: Admin,
    session: Session,
    status: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> list[RunSummary]:
    query = (
        select(Run, Objective.project_id, Objective.title)
        .join(Objective, Objective.id == Run.objective_id)
        .order_by(Run.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    if status:
        query = query.where(Run.status == status)
    rows = (await session.execute(query)).all()
    return await _summaries(
        session, [(run, project_id, title) for run, project_id, title in rows]
    )


@router.get("/{run_id}", response_model=RunDetail)
async def get_run(run_id: uuid.UUID, _: Admin, session: Session) -> RunDetail:
    row = (
        await session.execute(
            select(Run, Objective.project_id, Objective.title)
            .join(Objective, Objective.id == Run.objective_id)
            .where(Run.id == run_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    run, project_id, objective_title = row
    summary = await _summary(session, run, project_id, objective_title)
    tasks = list(
        await session.scalars(
            select(Task).where(Task.run_id == run.id).order_by(Task.position)
        )
    )
    events = list(
        await session.scalars(
            select(RunEvent)
            .where(RunEvent.run_id == run.id)
            .order_by(RunEvent.sequence)
        )
    )
    approvals = list(
        await session.scalars(
            select(Approval)
            .where(Approval.run_id == run.id)
            .order_by(Approval.created_at)
        )
    )
    verification_criteria = list(
        await session.scalars(
            select(VerificationCriterion)
            .where(VerificationCriterion.run_id == run.id)
            .order_by(VerificationCriterion.position)
        )
    )
    verification_evidence = list(
        await session.scalars(
            select(VerificationEvidence)
            .where(VerificationEvidence.run_id == run.id)
            .order_by(VerificationEvidence.created_at)
        )
    )
    invocation_rows = (
        await session.execute(
            select(AgentInvocation, Agent.name)
            .join(Agent, Agent.id == AgentInvocation.agent_id)
            .where(AgentInvocation.run_id == run.id)
            .order_by(AgentInvocation.created_at)
        )
    ).all()
    invocations = [
        RunInvocationResponse(
            id=item.id,
            agent_id=item.agent_id,
            agent_name=agent_name,
            purpose=item.purpose,
            status=item.status,
            provider=item.provider,
            model=item.model,
            attempt=item.attempt,
            fallback_from_provider=item.fallback_from_provider,
            routing_reason=item.routing_reason,
            duration_ms=item.duration_ms,
            input_tokens=item.input_tokens,
            cached_input_tokens=item.cached_input_tokens,
            output_tokens=item.output_tokens,
            total_tokens=item.total_tokens,
            input_excerpt=item.input_excerpt,
            output_excerpt=item.output_excerpt,
            error=item.error,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )
        for item, agent_name in invocation_rows
    ]
    return RunDetail(
        **summary.model_dump(),
        tasks=[RunTaskResponse.model_validate(item) for item in tasks],
        events=[RunEventResponse.model_validate(item) for item in events],
        invocations=invocations,
        approvals=[RunApprovalResponse.model_validate(item) for item in approvals],
        verification_criteria=[
            VerificationCriterionResponse.model_validate(item)
            for item in verification_criteria
        ],
        verification_evidence=[
            VerificationEvidenceResponse.model_validate(item)
            for item in verification_evidence
        ],
    )


@router.post(
    "/{run_id}/execute",
    response_model=RunSummary,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_execution(
    run_id: uuid.UUID,
    payload: ExecutionRequest,
    _: Admin,
    session: Session,
) -> RunSummary:
    run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    objective = await session.get(Objective, run.objective_id)
    if objective is None:
        raise HTTPException(status_code=404, detail="Objective not found")
    if run.status != "completed" or run.current_step != "planned":
        raise HTTPException(status_code=409, detail="Only an approved, planned run can execute")
    workflow = await get_workflow_settings(session)
    if not workflow["allow_repository_writes"]:
        raise HTTPException(
            status_code=409,
            detail="Repository writes are disabled in workflow settings",
        )
    approved_plan = await session.scalar(
        select(Approval.id).where(
            Approval.run_id == run.id,
            Approval.kind == "plan",
            Approval.status == "approved",
        )
    )
    if workflow["require_plan_approval"] and approved_plan is None:
        raise HTTPException(status_code=409, detail="The plan must be approved before execution")
    project = await session.get(Project, objective.project_id)
    if project is None or project.status != "active":
        raise HTTPException(status_code=409, detail="Project is not active")
    tasks = list(
        await session.scalars(select(Task).where(Task.run_id == run.id).order_by(Task.position))
    )
    if not tasks:
        raise HTTPException(status_code=409, detail="Run has no tasks")
    assigned_ids = [
        task.assigned_agent_id for task in tasks if task.assigned_agent_id is not None
    ]
    agents = {
        agent.id: agent
        for agent in await session.scalars(
            select(Agent).where(Agent.id.in_(assigned_ids))
        )
    }
    invalid = [
        task.title
        for task in tasks
        if task.assigned_agent_id is None
        or task.assigned_agent_id not in agents
        or not agents[task.assigned_agent_id].enabled
        or agents[task.assigned_agent_id].role != task.agent_role
    ]
    if invalid:
        raise HTTPException(
            status_code=409,
            detail=f"Assign eligible agents before execution: {', '.join(invalid[:3])}",
        )
    has_verification_criteria = await session.scalar(
        select(VerificationCriterion.id)
        .where(VerificationCriterion.run_id == run.id)
        .limit(1)
    )
    if has_verification_criteria is not None:
        reviewer = await session.scalar(
            select(Agent.id)
            .where(Agent.role == "reviewer", Agent.enabled.is_(True))
            .order_by(Agent.created_at)
            .limit(1)
        )
        if reviewer is None:
            raise HTTPException(
                status_code=409,
                detail="Enable a reviewer agent before building this verified mission",
            )
    repository = (
        await session.get(Repository, payload.repository_id)
        if payload.repository_id
        else await session.scalar(
            select(Repository)
            .where(Repository.project_id == objective.project_id)
            .order_by(Repository.created_at)
            .limit(1)
        )
    )
    if repository is not None and repository.project_id != objective.project_id:
        raise HTTPException(status_code=409, detail="Repository belongs to a different project")
    if repository is None:
        try:
            repository = (
                await CatalogService(session).create_repository(
                    project.id, project.name, commit=False
                )
            ).repository
        except (OSError, ValueError) as error:
            raise HTTPException(
                status_code=422,
                detail=f"Unable to create the project repository: {error}",
            ) from error
    run.repository_id = repository.id
    queue_execution = not workflow["require_execution_approval"]
    if queue_execution:
        run.status = "queued_for_execution"
        run.current_step = "execution_queued"
        objective.status = "executing"
        event_type = "execution.queued"
    else:
        session.add(Approval(run_id=run.id, kind="execution", status="pending"))
        run.status = "awaiting_execution_approval"
        run.current_step = "execution_review"
        objective.status = "awaiting_execution_approval"
        event_type = "execution.approval_requested"
    await append_run_event(
        session,
        run.id,
        event_type,
        {"repository_id": str(repository.id), "repository": repository.name},
    )
    await session.commit()
    await session.refresh(run)
    if queue_execution:
        try:
            from mission_control.workers.actors.executor import execute_run

            execute_run.send(str(run.id))
        except Exception as error:
            raise HTTPException(
                status_code=503,
                detail=f"Execution was saved but the worker could not be queued: {error}",
            ) from error
    return await _summary(session, run, objective.project_id, objective.title)


@router.post(
    "/{run_id}/resume",
    response_model=ResumeExecutionResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def resume_execution(
    run_id: uuid.UUID,
    _: Admin,
    session: Session,
) -> ResumeExecutionResponse:
    run = await session.scalar(
        select(Run).where(Run.id == run_id).with_for_update()
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status not in {"executing", "queued_for_execution"}:
        raise HTTPException(
            status_code=409, detail="Only a stale executing or queued run can be resumed"
        )
    objective = await session.get(Objective, run.objective_id)
    if objective is None:
        raise HTTPException(status_code=404, detail="Objective not found")
    if run.repository_id is None:
        raise HTTPException(status_code=409, detail="Run has no execution repository")

    running_invocations = list(
        await session.scalars(
            select(AgentInvocation)
            .where(
                AgentInvocation.run_id == run.id,
                AgentInvocation.status == "running",
            )
            .with_for_update()
        )
    )
    activity_times = [run.updated_at]
    activity_times.extend(item.updated_at for item in running_invocations)
    last_activity = max(activity_times)
    stale_after = (
        STALE_QUEUE_AFTER
        if run.status == "queued_for_execution"
        else STALE_EXECUTION_AFTER
    )
    if last_activity > datetime.now(UTC) - stale_after:
        raise HTTPException(
            status_code=409,
            detail="This run still has recent worker activity; wait before resuming",
        )

    if run.status == "queued_for_execution":
        await append_run_event(
            session,
            run.id,
            "execution.requeued",
            {"reason": "Queue delivery was retried by the operator"},
        )
        await session.commit()
        try:
            from mission_control.workers.actors.executor import execute_run

            execute_run.send(str(run.id))
        except Exception as error:
            raise HTTPException(
                status_code=503,
                detail=f"Unable to queue the execution worker: {error}",
            ) from error
        return ResumeExecutionResponse(
            id=run.id,
            status=run.status,
            current_step=run.current_step,
            recovered_tasks=0,
        )

    unfinished_tasks = list(
        await session.scalars(
            select(Task)
            .where(Task.run_id == run.id, Task.status == "in_progress")
            .with_for_update()
        )
    )
    if not unfinished_tasks:
        if run.current_step not in {
            "verification",
            "verification_queued",
            "verification_tests",
            "verification_review",
        }:
            raise HTTPException(
                status_code=409, detail="No interrupted task is available to resume"
            )
        interruption = "Verification worker stopped or timed out; verification requeued."
        for invocation in running_invocations:
            invocation.status = "failed"
            invocation.error = interruption
        run.status = "queued_for_execution"
        run.current_step = "execution_resuming"
        objective.status = "executing"
        await append_run_event(
            session,
            run.id,
            "verification.requeued",
            {
                "interrupted_invocation_ids": [
                    str(invocation.id) for invocation in running_invocations
                ],
            },
        )
        await session.commit()
        try:
            from mission_control.workers.actors.executor import execute_run

            execute_run.send(str(run.id))
        except Exception as error:
            raise HTTPException(
                status_code=503,
                detail=f"Verification recovery was saved but could not be queued: {error}",
            ) from error
        return ResumeExecutionResponse(
            id=run.id,
            status=run.status,
            current_step=run.current_step,
            recovered_tasks=0,
        )

    interruption = "Execution worker stopped or timed out; task requeued for recovery."
    for invocation in running_invocations:
        invocation.status = "failed"
        invocation.error = interruption
    for task in unfinished_tasks:
        task.status = "planned"
    run.status = "queued_for_execution"
    run.current_step = "execution_resuming"
    objective.status = "executing"
    await append_run_event(
        session,
        run.id,
        "execution.resumed",
        {
            "recovered_task_ids": [str(task.id) for task in unfinished_tasks],
            "interrupted_invocation_ids": [
                str(invocation.id) for invocation in running_invocations
            ],
        },
    )
    await session.commit()

    try:
        from mission_control.workers.actors.executor import execute_run

        execute_run.send(str(run.id))
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail=f"Recovery was saved but the worker could not be queued: {error}",
        ) from error
    return ResumeExecutionResponse(
        id=run.id,
        status=run.status,
        current_step=run.current_step,
        recovered_tasks=len(unfinished_tasks),
    )
