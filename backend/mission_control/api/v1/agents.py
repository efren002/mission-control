from __future__ import annotations

import time
import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.agents import AgentService
from mission_control.application.services.settings import get_workflow_settings
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import Agent, AgentInvocation, Task
from mission_control.infrastructure.database.session import get_session
from mission_control.infrastructure.providers.gateway_client import ProviderGatewayClient

router = APIRouter(prefix="/agents", tags=["agents"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]
AgentRole = Literal["planner", "developer", "qa", "reviewer"]
Provider = Literal["codex", "claude"]


class AgentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role: AgentRole
    provider: Provider = "codex"
    model: str | None = Field(default=None, max_length=120)
    instructions: str = Field(default="", max_length=50000)
    enabled: bool = True


class AgentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    role: AgentRole | None = None
    provider: Provider | None = None
    model: str | None = Field(default=None, max_length=120)
    instructions: str | None = Field(default=None, max_length=50000)
    enabled: bool | None = None


class AgentResponse(BaseModel):
    id: uuid.UUID
    name: str
    role: str
    provider: str
    model: str | None
    instructions: str
    enabled: bool
    status: str
    provider_version: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    assignment_count: int = 0
    invocation_count: int = 0


class InvocationResponse(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    run_id: uuid.UUID | None
    task_id: uuid.UUID | None
    purpose: str
    status: str
    duration_ms: int | None
    input_excerpt: str | None
    output_excerpt: str | None
    error: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


async def provider_map() -> dict[str, object]:
    try:
        payload = await ProviderGatewayClient().providers()
    except Exception:
        return {}
    providers = payload.get("providers", {})
    return providers if isinstance(providers, dict) else {}


async def agent_counts(
    session: AsyncSession, agent_ids: Sequence[uuid.UUID]
) -> tuple[dict[uuid.UUID, int], dict[uuid.UUID, int]]:
    if not agent_ids:
        return {}, {}
    assignment_rows = (
        await session.execute(
            select(Task.assigned_agent_id, func.count())
            .where(Task.assigned_agent_id.in_(agent_ids))
            .group_by(Task.assigned_agent_id)
        )
    ).tuples()
    assignments: dict[uuid.UUID, int] = {
        agent_id: count
        for agent_id, count in assignment_rows
        if agent_id is not None
    }
    invocation_rows = (
        await session.execute(
            select(AgentInvocation.agent_id, func.count())
            .where(AgentInvocation.agent_id.in_(agent_ids))
            .group_by(AgentInvocation.agent_id)
        )
    ).tuples()
    invocations: dict[uuid.UUID, int] = dict(invocation_rows)
    return assignments, invocations


async def agent_response(
    session: AsyncSession,
    agent: Agent,
    providers: dict[str, object],
    counts: tuple[dict[uuid.UUID, int], dict[uuid.UUID, int]] | None = None,
) -> AgentResponse:
    provider = providers.get(agent.provider, {})
    provider = provider if isinstance(provider, dict) else {}
    assignments, invocations = (
        counts if counts is not None else await agent_counts(session, [agent.id])
    )
    available = provider.get("available") is True
    installed = provider.get("installed") is True
    return AgentResponse(
        id=agent.id,
        name=agent.name,
        role=agent.role,
        provider=agent.provider,
        model=agent.model,
        instructions=agent.instructions,
        enabled=agent.enabled,
        status=(
            "disabled"
            if not agent.enabled
            else ("online" if available else ("unauthenticated" if installed else "unavailable"))
        ),
        provider_version=(
            provider.get("version") if isinstance(provider.get("version"), str) else None
        ),
        capabilities=[item for item in provider.get("capabilities", []) if isinstance(item, str)],
        assignment_count=assignments.get(agent.id, 0),
        invocation_count=invocations.get(agent.id, 0),
    )


@router.get("", response_model=list[AgentResponse])
async def list_agents(_: Admin, session: Session) -> list[AgentResponse]:
    agents = await AgentService(session).list()
    providers = await provider_map()
    counts = await agent_counts(session, [agent.id for agent in agents])
    return [await agent_response(session, agent, providers, counts) for agent in agents]


@router.post("", response_model=AgentResponse, status_code=status.HTTP_201_CREATED)
async def create_agent(payload: AgentCreate, _: Admin, session: Session) -> AgentResponse:
    try:
        agent = await AgentService(session).create(**payload.model_dump())
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return await agent_response(session, agent, await provider_map())


@router.put("/{agent_id}", response_model=AgentResponse)
async def update_agent(
    agent_id: uuid.UUID, payload: AgentUpdate, _: Admin, session: Session
) -> AgentResponse:
    values = {
        key: value
        for key, value in payload.model_dump(exclude_unset=True).items()
        if value is not None or key == "model"
    }
    try:
        agent = await AgentService(session).update(agent_id, values)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return await agent_response(session, agent, await provider_map())


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(agent_id: uuid.UUID, _: Admin, session: Session) -> Response:
    try:
        await AgentService(session).delete(agent_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{agent_id}/test", response_model=InvocationResponse)
async def test_agent(agent_id: uuid.UUID, _: Admin, session: Session) -> InvocationResponse:
    try:
        agent = await AgentService(session).get(agent_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    if not agent.enabled:
        raise HTTPException(status_code=409, detail="Enable the agent before testing it")
    prompt = (
        "You are being tested by Mission Control. Confirm that you are available in one "
        f"concise sentence. Agent role: {agent.role}. Instructions: {agent.instructions}"
    )
    workflow = await get_workflow_settings(session)
    invocation = AgentInvocation(
        agent_id=agent.id,
        purpose="connectivity_test",
        status="running",
        input_excerpt=prompt[-4000:] if workflow["retain_invocation_output"] else None,
    )
    session.add(invocation)
    await session.flush()
    started_at = time.monotonic()
    try:
        output = await ProviderGatewayClient().execute(
            agent.provider,
            prompt,
            model=agent.model,
            timeout_seconds=min(int(workflow["provider_timeout_seconds"]), 120),
            usage_label=f"Connectivity test · {agent.name}"[:160],
        )
        invocation.status = "completed"
        if workflow["retain_invocation_output"]:
            invocation.output_excerpt = output[-4000:]
    except Exception as error:
        invocation.status = "failed"
        invocation.error = str(error)[:4000]
    invocation.duration_ms = int((time.monotonic() - started_at) * 1000)
    await session.commit()
    await session.refresh(invocation)
    return InvocationResponse.model_validate(invocation)


@router.get("/{agent_id}/invocations", response_model=list[InvocationResponse])
async def list_agent_invocations(
    agent_id: uuid.UUID,
    _: Admin,
    session: Session,
    limit: int = Query(50, ge=1, le=100),
) -> list[InvocationResponse]:
    try:
        items = await AgentService(session).invocations(agent_id, limit)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return [InvocationResponse.model_validate(item) for item in items]
