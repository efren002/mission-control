from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.run_events import append_run_event
from mission_control.application.services.settings import get_workflow_settings
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import Approval, Objective, Run, Task
from mission_control.infrastructure.database.session import get_session

router = APIRouter(prefix="/approvals", tags=["approvals"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]


class ApprovalResponse(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    objective_id: uuid.UUID
    objective_title: str
    kind: str
    status: str
    task_count: int
    decision_reason: str | None
    decided_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ApprovalDecision(BaseModel):
    decision: Literal["approve", "reject"]
    reason: str | None = Field(default=None, max_length=4000)


async def _task_counts(
    session: AsyncSession, run_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, int]:
    if not run_ids:
        return {}
    rows = (
        await session.execute(
            select(Task.run_id, func.count())
            .where(Task.run_id.in_(run_ids))
            .group_by(Task.run_id)
        )
    ).tuples()
    return {run_id: count for run_id, count in rows if run_id is not None}


def _response(
    approval: Approval,
    run: Run,
    objective: Objective,
    task_count: int,
) -> ApprovalResponse:
    return ApprovalResponse(
        id=approval.id,
        run_id=run.id,
        objective_id=objective.id,
        objective_title=objective.title,
        kind=approval.kind,
        status=approval.status,
        task_count=task_count,
        decision_reason=approval.decision_reason,
        decided_at=approval.decided_at,
        created_at=approval.created_at,
        updated_at=approval.updated_at,
    )


@router.get("", response_model=list[ApprovalResponse])
async def list_approvals(
    _: Admin,
    session: Session,
    status: str | None = None,
    limit: int = Query(50, ge=1, le=100),
) -> list[ApprovalResponse]:
    query = (
        select(Approval, Run, Objective)
        .join(Run, Run.id == Approval.run_id)
        .join(Objective, Objective.id == Run.objective_id)
        .order_by(Approval.created_at.desc())
        .limit(limit)
    )
    if status:
        query = query.where(Approval.status == status)
    rows = (await session.execute(query)).all()
    task_counts = await _task_counts(session, [run.id for _, run, _ in rows])
    return [
        _response(approval, run, objective, task_counts.get(run.id, 0))
        for approval, run, objective in rows
    ]


@router.post("/{approval_id}/decision", response_model=ApprovalResponse)
async def decide_approval(
    approval_id: uuid.UUID,
    payload: ApprovalDecision,
    _: Admin,
    session: Session,
) -> ApprovalResponse:
    approval = await session.scalar(
        select(Approval).where(Approval.id == approval_id).with_for_update()
    )
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail="Approval has already been decided")
    if approval.kind not in {"plan", "execution"}:
        raise HTTPException(status_code=409, detail="Unsupported approval kind")
    run = await session.get(Run, approval.run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    objective = await session.get(Objective, run.objective_id)
    if objective is None:
        raise HTTPException(status_code=404, detail="Objective not found")
    expected_status = (
        "awaiting_approval" if approval.kind == "plan" else "awaiting_execution_approval"
    )
    if run.status != expected_status:
        raise HTTPException(status_code=409, detail="Run is not awaiting this approval")

    reason = payload.reason.strip() if payload.reason else None
    approval.status = "approved" if payload.decision == "approve" else "rejected"
    approval.decision_reason = reason
    approval.decided_at = datetime.now(UTC)
    queue_execution = False
    if payload.decision == "approve":
        if approval.kind == "plan":
            run.status = "completed"
            run.current_step = "planned"
            objective.status = "planned"
        else:
            workflow = await get_workflow_settings(session)
            if not workflow["allow_repository_writes"]:
                raise HTTPException(
                    status_code=409,
                    detail="Repository writes are disabled in workflow settings",
                )
            run.status = "queued_for_execution"
            run.current_step = "execution_queued"
            objective.status = "executing"
            queue_execution = True
        event_type = f"{approval.kind}.approval_approved"
    else:
        if approval.kind == "plan":
            run.status = "rejected"
            run.current_step = "planner_review"
            objective.status = "rejected"
            await session.execute(
                update(Task).where(Task.run_id == run.id).values(status="rejected")
            )
        else:
            run.status = "completed"
            run.current_step = "planned"
            objective.status = "planned"
            run.repository_id = None
        event_type = f"{approval.kind}.approval_rejected"
    await append_run_event(
        session,
        run.id,
        event_type,
        {"approval_id": str(approval.id), "reason": reason or ""},
    )
    await session.commit()
    await session.refresh(approval)
    if queue_execution:
        try:
            from mission_control.workers.actors.executor import execute_run

            execute_run.send(str(run.id))
        except Exception as error:
            raise HTTPException(
                status_code=503,
                detail=f"Approval was saved but the worker could not be queued: {error}",
            ) from error
    task_counts = await _task_counts(session, [run.id])
    return _response(approval, run, objective, task_counts.get(run.id, 0))
