from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.project_runtime import (
    ProjectRuntimeService,
    RuntimeSnapshot,
)
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.session import get_session
from mission_control.infrastructure.providers.gateway_client import GatewayRequestError

router = APIRouter(prefix="/projects/{project_id}/runtime", tags=["project runtime"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]
RepositoryId = Annotated[uuid.UUID | None, Query()]


class RuntimeCommandsUpdate(BaseModel):
    test_command: str | None = Field(default=None, max_length=2000)
    app_command: str | None = Field(default=None, max_length=2000)


class CommandRunResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    repository_id: uuid.UUID | None
    kind: str
    command: str
    status: str
    exit_code: int | None
    output_excerpt: str | None
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AppRuntimeResponse(BaseModel):
    status: str
    port: int
    command: str
    started_at: str
    exit_code: int | None = None
    log_tail: str = ""
    preview_url: str


class ProjectRuntimeResponse(BaseModel):
    project_id: uuid.UUID
    repository_id: uuid.UUID | None
    configured_test_command: str | None
    configured_app_command: str | None
    detected_test_command: str | None
    detected_app_command: str | None
    effective_test_command: str | None
    effective_app_command: str | None
    test_run: CommandRunResponse | None
    app: AppRuntimeResponse | None
    gateway_error: str | None


def _app_response(payload: dict[str, Any] | None) -> AppRuntimeResponse | None:
    if payload is None:
        return None
    port = payload.get("port")
    if not isinstance(port, int):
        return None
    return AppRuntimeResponse(
        status=str(payload.get("status", "unknown")),
        port=port,
        command=str(payload.get("command", "")),
        started_at=str(payload.get("startedAt", "")),
        exit_code=payload.get("exitCode") if isinstance(payload.get("exitCode"), int) else None,
        log_tail=str(payload.get("logTail", "")),
        preview_url=f"http://localhost:{port}",
    )


def _runtime_response(snapshot: RuntimeSnapshot) -> ProjectRuntimeResponse:
    return ProjectRuntimeResponse(
        project_id=snapshot.project.id,
        repository_id=snapshot.repository.id if snapshot.repository else None,
        configured_test_command=snapshot.project.test_command,
        configured_app_command=snapshot.project.app_command,
        detected_test_command=snapshot.detected.test_command,
        detected_app_command=snapshot.detected.app_command,
        effective_test_command=snapshot.effective_test_command,
        effective_app_command=snapshot.effective_app_command,
        test_run=(
            CommandRunResponse.model_validate(snapshot.test_run) if snapshot.test_run else None
        ),
        app=_app_response(snapshot.app),
        gateway_error=snapshot.gateway_error,
    )


async def _snapshot_or_error(
    service: ProjectRuntimeService,
    project_id: uuid.UUID,
    repository_id: uuid.UUID | None,
) -> ProjectRuntimeResponse:
    try:
        return _runtime_response(await service.snapshot(project_id, repository_id))
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("", response_model=ProjectRuntimeResponse)
async def get_project_runtime(
    project_id: uuid.UUID,
    _: Admin,
    session: Session,
    repository_id: RepositoryId = None,
) -> ProjectRuntimeResponse:
    return await _snapshot_or_error(
        ProjectRuntimeService(session), project_id, repository_id
    )


@router.put("/commands", response_model=ProjectRuntimeResponse)
async def update_runtime_commands(
    project_id: uuid.UUID,
    payload: RuntimeCommandsUpdate,
    _: Admin,
    session: Session,
    repository_id: RepositoryId = None,
) -> ProjectRuntimeResponse:
    service = ProjectRuntimeService(session)
    try:
        await service.update_commands(
            project_id,
            test_command=payload.test_command,
            app_command=payload.app_command,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return await _snapshot_or_error(service, project_id, repository_id)


@router.post(
    "/tests",
    response_model=CommandRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def run_project_tests(
    project_id: uuid.UUID,
    _: Admin,
    session: Session,
    repository_id: RepositoryId = None,
) -> CommandRunResponse:
    try:
        command_run = await ProjectRuntimeService(session).queue_tests(
            project_id, repository_id
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    from mission_control.workers.actors.commands import run_project_tests as tests_actor

    tests_actor.send(str(command_run.id))
    return CommandRunResponse.model_validate(command_run)


async def _app_action(
    action: str,
    service: ProjectRuntimeService,
    project_id: uuid.UUID,
    repository_id: uuid.UUID | None,
) -> AppRuntimeResponse:
    try:
        payload = (
            await service.start_app(project_id, repository_id)
            if action == "start"
            else await service.stop_app(project_id, repository_id)
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except GatewayRequestError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Provider gateway is unavailable: {error}",
        ) from error
    response = _app_response(payload)
    if response is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Provider gateway returned an invalid app response",
        )
    return response


@router.post("/app/start", response_model=AppRuntimeResponse)
async def start_project_app(
    project_id: uuid.UUID,
    _: Admin,
    session: Session,
    repository_id: RepositoryId = None,
) -> AppRuntimeResponse:
    return await _app_action(
        "start", ProjectRuntimeService(session), project_id, repository_id
    )


@router.post("/app/stop", response_model=AppRuntimeResponse)
async def stop_project_app(
    project_id: uuid.UUID,
    _: Admin,
    session: Session,
    repository_id: RepositoryId = None,
) -> AppRuntimeResponse:
    return await _app_action(
        "stop", ProjectRuntimeService(session), project_id, repository_id
    )
