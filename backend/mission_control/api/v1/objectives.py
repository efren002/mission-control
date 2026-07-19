from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.attachments import (
    MAX_ATTACHMENT_BYTES,
    AttachmentService,
)
from mission_control.application.services.objectives import ObjectiveService
from mission_control.application.services.settings import get_workflow_settings
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import Agent
from mission_control.infrastructure.database.session import get_session
from mission_control.infrastructure.providers.gateway_client import ProviderGatewayClient

router = APIRouter(prefix="/objectives", tags=["objectives"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]


async def ensure_planner_provider_ready(session: AsyncSession) -> None:
    planner_agent = await session.scalar(
        select(Agent)
        .where(Agent.role == "planner", Agent.enabled.is_(True))
        .order_by(Agent.created_at)
        .limit(1)
    )
    workflow = await get_workflow_settings(session)
    provider = planner_agent.provider if planner_agent else str(workflow["planner_provider"])
    try:
        payload = await ProviderGatewayClient().providers()
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Unable to verify planner provider: {error}",
        ) from error
    providers = payload.get("providers")
    provider_status = providers.get(provider) if isinstance(providers, dict) else None
    if not isinstance(provider_status, dict) or provider_status.get("installed") is not True:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Planner provider {provider} is unavailable",
        )
    if provider_status.get("authenticated") is not True:
        command = (
            "docker compose run --rm --no-deps provider-gateway codex login --device-auth"
            if provider == "codex"
            else "docker compose run --rm --no-deps provider-gateway claude auth login"
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Planner provider {provider} is not authenticated. Run: {command}",
        )


class ObjectiveCreate(BaseModel):
    project_id: uuid.UUID
    title: str = Field(min_length=1, max_length=250)
    description: str | None = Field(default=None, max_length=10000)


class ObjectiveUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=250)
    description: str | None = Field(default=None, max_length=10000)


class ObjectiveResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    title: str
    description: str | None
    status: str

    model_config = {"from_attributes": True}


class AttachmentResponse(BaseModel):
    id: uuid.UUID
    objective_id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime

    model_config = {"from_attributes": True}


class RunResponse(BaseModel):
    id: uuid.UUID
    objective_id: uuid.UUID
    status: str
    current_step: str | None

    model_config = {"from_attributes": True}


@router.get("", response_model=list[ObjectiveResponse])
async def list_objectives(
    _: Admin,
    session: Session,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> list[ObjectiveResponse]:
    objectives = await ObjectiveService(session).list(limit, offset)
    return [ObjectiveResponse.model_validate(item) for item in objectives]


@router.post("", response_model=ObjectiveResponse, status_code=status.HTTP_201_CREATED)
async def create_objective(
    payload: ObjectiveCreate, _: Admin, session: Session
) -> ObjectiveResponse:
    try:
        objective = await ObjectiveService(session).create(
            payload.project_id, payload.title, payload.description
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return ObjectiveResponse.model_validate(objective)


@router.put("/{objective_id}", response_model=ObjectiveResponse)
async def update_objective(
    objective_id: uuid.UUID,
    payload: ObjectiveUpdate,
    _: Admin,
    session: Session,
) -> ObjectiveResponse:
    fields = payload.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="At least one field is required")
    try:
        objective = await ObjectiveService(session).update(
            objective_id,
            title=payload.title,
            description=payload.description,
            description_is_set="description" in fields,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return ObjectiveResponse.model_validate(objective)


@router.delete("/{objective_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_objective(objective_id: uuid.UUID, _: Admin, session: Session) -> Response:
    try:
        await ObjectiveService(session).delete(objective_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{objective_id}/attachments", response_model=list[AttachmentResponse])
async def list_attachments(
    objective_id: uuid.UUID, _: Admin, session: Session
) -> list[AttachmentResponse]:
    try:
        attachments = await AttachmentService(session).list(objective_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return [AttachmentResponse.model_validate(item) for item in attachments]


@router.post(
    "/{objective_id}/attachments",
    response_model=AttachmentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    objective_id: uuid.UUID, file: UploadFile, _: Admin, session: Session
) -> AttachmentResponse:
    data = await file.read(MAX_ATTACHMENT_BYTES + 1)
    try:
        attachment = await AttachmentService(session).create(objective_id, file.filename, data)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return AttachmentResponse.model_validate(attachment)


@router.get("/{objective_id}/attachments/{attachment_id}/content")
async def attachment_content(
    objective_id: uuid.UUID, attachment_id: uuid.UUID, _: Admin, session: Session
) -> Response:
    try:
        attachment, data = await AttachmentService(session).read_content(
            objective_id, attachment_id
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(
        content=data,
        media_type=attachment.content_type,
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.delete(
    "/{objective_id}/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_attachment(
    objective_id: uuid.UUID, attachment_id: uuid.UUID, _: Admin, session: Session
) -> Response:
    try:
        await AttachmentService(session).delete(objective_id, attachment_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{objective_id}/plan", response_model=RunResponse, status_code=status.HTTP_202_ACCEPTED
)
async def start_planning(objective_id: uuid.UUID, _: Admin, session: Session) -> RunResponse:
    await ensure_planner_provider_ready(session)
    try:
        run = await ObjectiveService(session).start_planning(objective_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    from mission_control.workers.actors.planner import plan_objective

    plan_objective.send(str(run.id))
    return RunResponse.model_validate(run)
