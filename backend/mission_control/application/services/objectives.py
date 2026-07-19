from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.attachments import (
    remove_objective_attachment_files,
)
from mission_control.application.services.job_dispatch import enqueue_job
from mission_control.application.services.run_events import append_run_event
from mission_control.infrastructure.database.models import Objective, Project, Run


class ObjectiveService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(self, limit: int = 50, offset: int = 0) -> list[Objective]:
        result = await self.session.scalars(
            select(Objective).order_by(Objective.created_at.desc()).offset(offset).limit(limit)
        )
        return list(result)

    async def create(self, project_id: uuid.UUID, title: str, description: str | None) -> Objective:
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        if project.status != "active":
            raise ValueError("Objectives can only be created for active projects")
        objective = Objective(
            project_id=project_id,
            title=title.strip(),
            description=description.strip() if description else None,
            status="draft",
        )
        self.session.add(objective)
        await self.session.commit()
        await self.session.refresh(objective)
        return objective

    async def update(
        self,
        objective_id: uuid.UUID,
        *,
        title: str | None = None,
        description: str | None = None,
        description_is_set: bool = False,
    ) -> Objective:
        objective = await self.session.get(Objective, objective_id)
        if objective is None:
            raise LookupError("Objective not found")
        if objective.status not in {"draft", "failed", "rejected"}:
            raise ValueError(
                "Only draft, failed, or rejected objectives can be edited"
            )
        if title is not None:
            objective.title = title.strip()
        if description_is_set:
            objective.description = description.strip() if description else None
        await self.session.commit()
        await self.session.refresh(objective)
        return objective

    async def delete(self, objective_id: uuid.UUID) -> None:
        objective = await self.session.get(Objective, objective_id)
        if objective is None:
            raise LookupError("Objective not found")
        if objective.status in {
            "planning",
            "awaiting_approval",
            "awaiting_execution_approval",
            "executing",
        }:
            raise ValueError("Cannot delete an objective while workflow work is in progress")
        await self.session.delete(objective)
        await self.session.commit()
        await remove_objective_attachment_files(objective_id)

    async def start_planning(self, objective_id: uuid.UUID) -> Run:
        objective = await self.session.scalar(
            select(Objective)
            .where(Objective.id == objective_id)
            .with_for_update()
        )
        if objective is None:
            raise LookupError("Objective not found")
        if objective.status not in {"draft", "failed", "rejected"}:
            raise ValueError("Objective is not ready for planning")
        project = await self.session.get(Project, objective.project_id)
        if project is None:
            raise LookupError("Project not found")
        if project.status != "active":
            raise ValueError("Archived projects cannot start new planning runs")
        objective.status = "planning"
        run = Run(objective_id=objective.id, status="planning", current_step="planner")
        self.session.add(run)
        await self.session.flush()
        await append_run_event(
            self.session,
            run.id,
            "run.created",
            {"objective_id": str(objective.id), "objective_title": objective.title},
        )
        enqueue_job(self.session, kind="plan_objective", entity_id=run.id)
        await self.session.commit()
        await self.session.refresh(run)
        return run
