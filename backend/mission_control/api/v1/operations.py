from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.detectors import DETECTOR_KINDS
from mission_control.application.services.job_dispatch import dispatch_pending_jobs
from mission_control.application.services.maintenance import MaintenanceService
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.session import get_session

router = APIRouter(prefix="/operations", tags=["operations"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]


class ScheduleCreate(BaseModel):
    project_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    detector_kind: str
    interval_seconds: int = Field(ge=60, le=2_592_000)
    config: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class ScheduleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    interval_seconds: int | None = Field(default=None, ge=60, le=2_592_000)
    config: dict[str, Any] | None = None
    enabled: bool | None = None


class ScheduleResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID | None
    name: str
    detector_kind: str
    interval_seconds: int
    enabled: bool
    config: dict[str, Any]
    last_run_at: datetime | None
    next_run_at: datetime | None
    last_status: str | None
    last_finding_count: int | None

    model_config = {"from_attributes": True}


class FindingResponse(BaseModel):
    id: uuid.UUID
    schedule_id: uuid.UUID | None
    project_id: uuid.UUID
    repository_id: uuid.UUID | None
    detector_kind: str
    severity: str
    title: str
    detail: str | None
    evidence: dict[str, Any]
    proposed_objective: dict[str, Any] | None
    status: str
    objective_id: uuid.UUID | None
    created_at: datetime
    resolved_at: datetime | None

    model_config = {"from_attributes": True}


class MaintenanceRunResponse(BaseModel):
    id: uuid.UUID
    schedule_id: uuid.UUID | None
    detector_kind: str
    project_id: uuid.UUID | None
    status: str
    findings_created: int
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class OverviewResponse(BaseModel):
    proposed_findings: int
    proposed_by_severity: dict[str, int]
    enabled_schedules: int


class ApproveResponse(BaseModel):
    objective_id: uuid.UUID
    finding_id: uuid.UUID


@router.get("/detector-kinds", response_model=list[str])
async def list_detector_kinds(_: Admin) -> list[str]:
    return list(DETECTOR_KINDS)


@router.get("/overview", response_model=OverviewResponse)
async def overview(_: Admin, session: Session) -> OverviewResponse:
    return OverviewResponse(**await MaintenanceService(session).overview())


# ----- schedules -----------------------------------------------------------
@router.get("/schedules", response_model=list[ScheduleResponse])
async def list_schedules(_: Admin, session: Session) -> list[ScheduleResponse]:
    schedules = await MaintenanceService(session).list_schedules()
    return [ScheduleResponse.model_validate(item) for item in schedules]


@router.post("/schedules", response_model=ScheduleResponse, status_code=status.HTTP_201_CREATED)
async def create_schedule(
    payload: ScheduleCreate, _: Admin, session: Session
) -> ScheduleResponse:
    try:
        schedule = await MaintenanceService(session).create_schedule(
            project_id=payload.project_id,
            name=payload.name,
            detector_kind=payload.detector_kind,
            interval_seconds=payload.interval_seconds,
            config=payload.config,
            enabled=payload.enabled,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return ScheduleResponse.model_validate(schedule)


@router.patch("/schedules/{schedule_id}", response_model=ScheduleResponse)
async def update_schedule(
    schedule_id: uuid.UUID, payload: ScheduleUpdate, _: Admin, session: Session
) -> ScheduleResponse:
    if not payload.model_fields_set:
        raise HTTPException(status_code=422, detail="At least one field is required")
    try:
        schedule = await MaintenanceService(session).update_schedule(
            schedule_id,
            name=payload.name,
            interval_seconds=payload.interval_seconds,
            config=payload.config,
            enabled=payload.enabled,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return ScheduleResponse.model_validate(schedule)


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(schedule_id: uuid.UUID, _: Admin, session: Session) -> Response:
    try:
        await MaintenanceService(session).delete_schedule(schedule_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/schedules/{schedule_id}/run-now",
    response_model=MaintenanceRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def run_schedule_now(
    schedule_id: uuid.UUID, _: Admin, session: Session
) -> MaintenanceRunResponse:
    try:
        run = await MaintenanceService(session).run_now(schedule_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await dispatch_pending_jobs()
    return MaintenanceRunResponse.model_validate(run)


# ----- findings ------------------------------------------------------------
@router.get("/findings", response_model=list[FindingResponse])
async def list_findings(
    _: Admin,
    session: Session,
    finding_status: str | None = Query(default=None, alias="status"),
    project_id: uuid.UUID | None = None,
    detector_kind: str | None = None,
    limit: int = Query(100, ge=1, le=200),
) -> list[FindingResponse]:
    findings = await MaintenanceService(session).list_findings(
        status=finding_status,
        project_id=project_id,
        detector_kind=detector_kind,
        limit=limit,
    )
    return [FindingResponse.model_validate(item) for item in findings]


@router.get("/findings/{finding_id}", response_model=FindingResponse)
async def get_finding(finding_id: uuid.UUID, _: Admin, session: Session) -> FindingResponse:
    finding = await MaintenanceService(session).get_finding(finding_id)
    if finding is None:
        raise HTTPException(status_code=404, detail="Finding not found")
    return FindingResponse.model_validate(finding)


@router.post(
    "/findings/{finding_id}/approve",
    response_model=ApproveResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def approve_finding(
    finding_id: uuid.UUID, _: Admin, session: Session
) -> ApproveResponse:
    try:
        objective = await MaintenanceService(session).approve_finding(finding_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await dispatch_pending_jobs()
    return ApproveResponse(objective_id=objective.id, finding_id=finding_id)


@router.post("/findings/{finding_id}/dismiss", response_model=FindingResponse)
async def dismiss_finding(
    finding_id: uuid.UUID, _: Admin, session: Session
) -> FindingResponse:
    try:
        finding = await MaintenanceService(session).dismiss_finding(finding_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return FindingResponse.model_validate(finding)


# ----- runs ----------------------------------------------------------------
@router.get("/runs", response_model=list[MaintenanceRunResponse])
async def list_runs(
    _: Admin, session: Session, limit: int = Query(50, ge=1, le=100)
) -> list[MaintenanceRunResponse]:
    runs = await MaintenanceService(session).list_runs(limit=limit)
    return [MaintenanceRunResponse.model_validate(item) for item in runs]
