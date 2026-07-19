from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.job_dispatch import enqueue_job
from mission_control.application.services.runtime_detection import (
    DetectedCommands,
    detect_commands,
)
from mission_control.infrastructure.database.models import CommandRun, Project, Repository
from mission_control.infrastructure.providers.gateway_client import (
    ProviderGatewayClient,
    provider_workspace,
)


@dataclass(frozen=True, slots=True)
class RuntimeSnapshot:
    project: Project
    repository: Repository | None
    detected: DetectedCommands
    effective_test_command: str | None
    effective_app_command: str | None
    test_run: CommandRun | None
    app: dict[str, Any] | None
    gateway_error: str | None


class ProjectRuntimeService:
    def __init__(
        self,
        session: AsyncSession,
        gateway: ProviderGatewayClient | None = None,
    ) -> None:
        self.session = session
        self.gateway = gateway or ProviderGatewayClient()

    async def snapshot(
        self,
        project_id: uuid.UUID,
        repository_id: uuid.UUID | None = None,
    ) -> RuntimeSnapshot:
        project = await self._project(project_id)
        repository = await self._repository(project_id, repository_id)
        detected = (
            detect_commands(repository.path)
            if repository is not None
            else DetectedCommands(None, None)
        )
        app: dict[str, Any] | None = None
        gateway_error: str | None = None
        if repository is not None:
            try:
                workspace = provider_workspace(repository.path)
                app = next(
                    (
                        item
                        for item in await self.gateway.app_list()
                        if item.get("workspace") == workspace
                    ),
                    None,
                )
            except Exception as error:
                gateway_error = str(error)[:1000]
        test_run = await self.session.scalar(
            select(CommandRun)
            .where(
                CommandRun.project_id == project_id,
                *(
                    (CommandRun.repository_id == repository.id,)
                    if repository is not None
                    else ()
                ),
            )
            .order_by(CommandRun.created_at.desc())
            .limit(1)
        )
        return RuntimeSnapshot(
            project=project,
            repository=repository,
            detected=detected,
            effective_test_command=self._configured_or_detected(
                project.test_command, detected.test_command
            ),
            effective_app_command=self._configured_or_detected(
                project.app_command, detected.app_command
            ),
            test_run=test_run,
            app=app,
            gateway_error=gateway_error,
        )

    async def update_commands(
        self,
        project_id: uuid.UUID,
        *,
        test_command: str | None,
        app_command: str | None,
    ) -> Project:
        project = await self._project(project_id)
        project.test_command = self._normalize_command(test_command)
        project.app_command = self._normalize_command(app_command)
        await self.session.commit()
        await self.session.refresh(project)
        return project

    async def queue_tests(
        self,
        project_id: uuid.UUID,
        repository_id: uuid.UUID | None = None,
    ) -> CommandRun:
        snapshot = await self.snapshot(project_id, repository_id)
        if snapshot.repository is None:
            raise ValueError("Register a repository before running tests")
        if snapshot.effective_test_command is None:
            raise ValueError("Configure a test command before running tests")
        active = await self.session.scalar(
            select(CommandRun.id)
            .where(
                CommandRun.project_id == project_id,
                CommandRun.repository_id == snapshot.repository.id,
                CommandRun.status.in_(("queued", "running")),
            )
            .limit(1)
        )
        if active is not None:
            raise RuntimeError("Tests are already running for this repository")
        command_run = CommandRun(
            project_id=project_id,
            repository_id=snapshot.repository.id,
            kind="test",
            command=snapshot.effective_test_command,
            status="queued",
        )
        self.session.add(command_run)
        await self.session.flush()
        enqueue_job(
            self.session,
            kind="run_project_tests",
            entity_id=command_run.id,
        )
        try:
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            raise RuntimeError("Tests are already running for this repository") from error
        await self.session.refresh(command_run)
        return command_run

    async def start_app(
        self,
        project_id: uuid.UUID,
        repository_id: uuid.UUID | None = None,
    ) -> dict[str, Any]:
        snapshot = await self.snapshot(project_id, repository_id)
        if snapshot.repository is None:
            raise ValueError("Register a repository before starting the app")
        if snapshot.effective_app_command is None:
            raise ValueError("Configure an app command before starting the app")
        return await self.gateway.app_start(
            provider_workspace(snapshot.repository.path),
            snapshot.effective_app_command,
        )

    async def stop_app(
        self,
        project_id: uuid.UUID,
        repository_id: uuid.UUID | None = None,
    ) -> dict[str, Any]:
        repository = await self._repository(project_id, repository_id)
        if repository is None:
            raise ValueError("Register a repository before stopping the app")
        return await self.gateway.app_stop(provider_workspace(repository.path))

    async def _project(self, project_id: uuid.UUID) -> Project:
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        return project

    async def _repository(
        self,
        project_id: uuid.UUID,
        repository_id: uuid.UUID | None,
    ) -> Repository | None:
        if repository_id is not None:
            repository = await self.session.get(Repository, repository_id)
            if repository is None or repository.project_id != project_id:
                raise LookupError("Repository not found for this project")
            return repository
        return cast(
            Repository | None,
            await self.session.scalar(
                select(Repository)
                .where(Repository.project_id == project_id)
                .order_by(Repository.created_at)
                .limit(1)
            ),
        )

    @staticmethod
    def _normalize_command(command: str | None) -> str | None:
        normalized = command.strip() if command is not None else ""
        return normalized or None

    @staticmethod
    def _configured_or_detected(configured: str | None, detected: str | None) -> str | None:
        return configured.strip() if configured and configured.strip() else detected
