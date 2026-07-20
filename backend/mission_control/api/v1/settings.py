from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.settings import (
    get_workflow_settings,
    save_workflow_settings,
)
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.session import get_session

router = APIRouter(prefix="/settings", tags=["settings"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]


class WorkflowSettings(BaseModel):
    planner_provider: str = "codex"
    planner_model: str | None = Field(default=None, max_length=120)
    require_plan_approval: bool = True
    require_execution_approval: bool = True
    auto_assign_tasks: bool = True
    max_planning_tasks: int = Field(default=20, ge=1, le=50)
    max_parallel_tasks: int = Field(default=3, ge=1, le=5)
    provider_timeout_seconds: int = Field(default=1800, ge=30, le=1800)
    enable_provider_fallback: bool = True
    allow_repository_writes: bool = False
    retain_invocation_output: bool = False
    enable_continuous_operations: bool = False
    scheduler_poll_seconds: int = Field(default=30, ge=5, le=3600)


@router.get("/workflow", response_model=WorkflowSettings)
async def read_workflow_settings(_: Admin, session: Session) -> WorkflowSettings:
    return WorkflowSettings.model_validate(await get_workflow_settings(session))


@router.put("/workflow", response_model=WorkflowSettings)
async def update_workflow_settings(
    payload: WorkflowSettings, _: Admin, session: Session
) -> WorkflowSettings:
    saved = await save_workflow_settings(session, payload.model_dump())
    return WorkflowSettings.model_validate(saved)
