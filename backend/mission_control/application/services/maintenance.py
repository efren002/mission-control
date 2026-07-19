from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.detectors import DETECTOR_KINDS, FindingDraft
from mission_control.application.services.job_dispatch import enqueue_job
from mission_control.application.services.objectives import ObjectiveService
from mission_control.infrastructure.database.models import (
    AgentInvocation,
    MaintenanceFinding,
    MaintenanceRun,
    MaintenanceSchedule,
    Objective,
    Project,
    Repository,
)

OPEN_FINDING_STATUSES = ("proposed", "converting")
MIN_INTERVAL_SECONDS = 60


class MaintenanceService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ----- schedules -------------------------------------------------------
    async def list_schedules(self) -> list[MaintenanceSchedule]:
        result = await self.session.scalars(
            select(MaintenanceSchedule).order_by(MaintenanceSchedule.created_at.desc())
        )
        return list(result)

    async def create_schedule(
        self,
        *,
        project_id: uuid.UUID,
        name: str,
        detector_kind: str,
        interval_seconds: int,
        config: dict[str, Any] | None = None,
        enabled: bool = True,
    ) -> MaintenanceSchedule:
        if detector_kind not in DETECTOR_KINDS:
            raise ValueError(f"Unknown detector kind: {detector_kind}")
        if interval_seconds < MIN_INTERVAL_SECONDS:
            raise ValueError("Interval must be at least 60 seconds")
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        schedule = MaintenanceSchedule(
            project_id=project_id,
            name=name.strip(),
            detector_kind=detector_kind,
            interval_seconds=interval_seconds,
            config=config or {},
            enabled=enabled,
            # New schedules become due immediately so the operator sees results.
            next_run_at=datetime.now(UTC) if enabled else None,
        )
        self.session.add(schedule)
        await self.session.commit()
        await self.session.refresh(schedule)
        return schedule

    async def update_schedule(
        self,
        schedule_id: uuid.UUID,
        *,
        name: str | None = None,
        interval_seconds: int | None = None,
        config: dict[str, Any] | None = None,
        enabled: bool | None = None,
    ) -> MaintenanceSchedule:
        schedule = await self.session.get(MaintenanceSchedule, schedule_id)
        if schedule is None:
            raise LookupError("Schedule not found")
        if name is not None:
            schedule.name = name.strip()
        if interval_seconds is not None:
            if interval_seconds < MIN_INTERVAL_SECONDS:
                raise ValueError("Interval must be at least 60 seconds")
            schedule.interval_seconds = interval_seconds
        if config is not None:
            schedule.config = config
        if enabled is not None:
            schedule.enabled = enabled
            if enabled and schedule.next_run_at is None:
                schedule.next_run_at = datetime.now(UTC)
        await self.session.commit()
        await self.session.refresh(schedule)
        return schedule

    async def delete_schedule(self, schedule_id: uuid.UUID) -> None:
        schedule = await self.session.get(MaintenanceSchedule, schedule_id)
        if schedule is None:
            raise LookupError("Schedule not found")
        await self.session.delete(schedule)
        await self.session.commit()

    async def trigger_schedule(self, schedule: MaintenanceSchedule) -> MaintenanceRun | None:
        """Create a maintenance run and enqueue detector work through the outbox.

        Returns None when a run for this schedule is already active, so the unique
        active-run guarantee is preserved without raising.
        """
        active = await self.session.scalar(
            select(MaintenanceRun.id).where(
                MaintenanceRun.schedule_id == schedule.id,
                MaintenanceRun.status == "running",
            )
        )
        if active is not None:
            return None
        run = MaintenanceRun(
            schedule_id=schedule.id,
            detector_kind=schedule.detector_kind,
            project_id=schedule.project_id,
            status="running",
            started_at=datetime.now(UTC),
        )
        self.session.add(run)
        await self.session.flush()
        enqueue_job(self.session, kind="run_maintenance_detector", entity_id=run.id)
        return run

    async def run_now(self, schedule_id: uuid.UUID) -> MaintenanceRun:
        schedule = await self.session.get(MaintenanceSchedule, schedule_id)
        if schedule is None:
            raise LookupError("Schedule not found")
        run = await self.trigger_schedule(schedule)
        if run is None:
            raise ValueError("A run for this schedule is already in progress")
        await self.session.commit()
        await self.session.refresh(run)
        return run

    # ----- findings --------------------------------------------------------
    async def persist_findings(
        self,
        schedule: MaintenanceSchedule,
        drafts: list[FindingDraft],
    ) -> int:
        """Store new findings, skipping any that already have an open duplicate."""
        created = 0
        for draft in drafts:
            existing = await self.session.scalar(
                select(MaintenanceFinding.id).where(
                    MaintenanceFinding.project_id == schedule.project_id,
                    MaintenanceFinding.detector_kind == draft.detector_kind,
                    MaintenanceFinding.dedupe_key == draft.dedupe_key,
                    MaintenanceFinding.status.in_(OPEN_FINDING_STATUSES),
                )
            )
            if existing is not None:
                continue
            finding = MaintenanceFinding(
                schedule_id=schedule.id,
                project_id=schedule.project_id,
                repository_id=draft.repository_id,
                detector_kind=draft.detector_kind,
                severity=draft.severity,
                title=draft.title,
                detail=draft.detail,
                evidence=draft.evidence,
                proposed_objective=draft.proposed_objective,
                dedupe_key=draft.dedupe_key,
                status="proposed",
            )
            self.session.add(finding)
            await self.session.flush()
            if draft.invocation_ids:
                await self.session.execute(
                    update(AgentInvocation)
                    .where(AgentInvocation.id.in_(draft.invocation_ids))
                    .values(finding_id=finding.id)
                )
            created += 1
        return created

    async def list_findings(
        self,
        *,
        status: str | None = None,
        project_id: uuid.UUID | None = None,
        detector_kind: str | None = None,
        limit: int = 100,
    ) -> list[MaintenanceFinding]:
        query = select(MaintenanceFinding).order_by(MaintenanceFinding.created_at.desc())
        if status is not None:
            query = query.where(MaintenanceFinding.status == status)
        if project_id is not None:
            query = query.where(MaintenanceFinding.project_id == project_id)
        if detector_kind is not None:
            query = query.where(MaintenanceFinding.detector_kind == detector_kind)
        result = await self.session.scalars(query.limit(limit))
        return list(result)

    async def get_finding(self, finding_id: uuid.UUID) -> MaintenanceFinding | None:
        return await self.session.get(MaintenanceFinding, finding_id)

    async def approve_finding(self, finding_id: uuid.UUID) -> Objective:
        """Turn a proposed finding into an objective and start planning.

        Nothing executes here beyond entering the normal, human-gated planning
        pipeline; approving a finding is the operator's consent to act on it.
        """
        finding = await self.session.scalar(
            select(MaintenanceFinding)
            .where(MaintenanceFinding.id == finding_id)
            .with_for_update()
        )
        if finding is None:
            raise LookupError("Finding not found")
        if finding.status != "proposed":
            raise ValueError("Only proposed findings can be approved")
        proposal = finding.proposed_objective
        if not isinstance(proposal, dict) or not proposal.get("title"):
            raise ValueError("This finding has no proposed objective to act on")
        finding.status = "converting"
        await self.session.commit()

        title = str(proposal.get("title"))
        description = self._objective_description(proposal, finding)
        objectives = ObjectiveService(self.session)
        objective = await objectives.create(finding.project_id, title, description)
        await objectives.start_planning(objective.id)

        finding.status = "converted"
        finding.objective_id = objective.id
        finding.resolved_at = datetime.now(UTC)
        await self.session.commit()
        await self.session.refresh(objective)
        return objective

    async def dismiss_finding(self, finding_id: uuid.UUID) -> MaintenanceFinding:
        finding = await self.session.get(MaintenanceFinding, finding_id)
        if finding is None:
            raise LookupError("Finding not found")
        if finding.status not in {"proposed", "converting"}:
            raise ValueError("Only open findings can be dismissed")
        finding.status = "dismissed"
        finding.resolved_at = datetime.now(UTC)
        await self.session.commit()
        await self.session.refresh(finding)
        return finding

    def _objective_description(
        self, proposal: dict[str, Any], finding: MaintenanceFinding
    ) -> str:
        parts = [str(proposal.get("description") or finding.detail or finding.title)]
        test_hint = proposal.get("test_hint")
        if isinstance(test_hint, str) and test_hint.strip():
            parts.append(f"\nVerification: {test_hint.strip()}")
        parts.append(
            f"\n(Proposed automatically by the {finding.detector_kind} maintenance check.)"
        )
        return "\n".join(parts)

    # ----- runs / overview -------------------------------------------------
    async def list_runs(self, *, limit: int = 50) -> list[MaintenanceRun]:
        result = await self.session.scalars(
            select(MaintenanceRun).order_by(MaintenanceRun.created_at.desc()).limit(limit)
        )
        return list(result)

    async def overview(self) -> dict[str, Any]:
        proposed = await self.session.scalar(
            select(func.count())
            .select_from(MaintenanceFinding)
            .where(MaintenanceFinding.status == "proposed")
        )
        by_severity_rows = await self.session.execute(
            select(MaintenanceFinding.severity, func.count())
            .where(MaintenanceFinding.status == "proposed")
            .group_by(MaintenanceFinding.severity)
        )
        enabled_schedules = await self.session.scalar(
            select(func.count())
            .select_from(MaintenanceSchedule)
            .where(MaintenanceSchedule.enabled.is_(True))
        )
        return {
            "proposed_findings": int(proposed or 0),
            "proposed_by_severity": {
                severity: int(count) for severity, count in by_severity_rows.all()
            },
            "enabled_schedules": int(enabled_schedules or 0),
        }

    async def repositories_for(self, project_id: uuid.UUID | None) -> list[Repository]:
        if project_id is None:
            return []
        result = await self.session.scalars(
            select(Repository).where(Repository.project_id == project_id)
        )
        return list(result)
