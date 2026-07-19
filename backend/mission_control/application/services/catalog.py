from __future__ import annotations

import asyncio
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.infrastructure.database.models import (
    Objective,
    Project,
    Repository,
    Run,
    SystemSetting,
)
from mission_control.infrastructure.git.inspector import RepositoryInspection, RepositoryInspector


@dataclass(frozen=True, slots=True)
class RegisteredRepository:
    repository: Repository
    inspection: RepositoryInspection


@dataclass(frozen=True, slots=True)
class RepositoryArchive:
    filename: str
    data: bytes


class CatalogService:
    CODING_STANDARDS_KEY = "coding_standards"

    def __init__(self, session: AsyncSession, inspector: RepositoryInspector | None = None) -> None:
        self.session = session
        self.inspector = inspector or RepositoryInspector()

    async def list_projects(self, limit: int = 50, offset: int = 0) -> list[Project]:
        result = await self.session.scalars(
            select(Project).order_by(Project.name).offset(offset).limit(limit)
        )
        return list(result)

    async def create_project(self, name: str) -> Project:
        project = Project(name=name.strip(), status="active")
        self.session.add(project)
        await self.session.commit()
        await self.session.refresh(project)
        return project

    async def update_project(self, project_id: uuid.UUID, name: str) -> Project:
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        project.name = name.strip()
        await self.session.commit()
        await self.session.refresh(project)
        return project

    async def delete_project(self, project_id: uuid.UUID) -> None:
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        active_work = await self.session.scalar(
            select(func.count())
            .select_from(Objective)
            .where(
                Objective.project_id == project_id,
                Objective.status.in_(
                    (
                        "planning",
                        "awaiting_approval",
                        "awaiting_execution_approval",
                        "executing",
                    )
                ),
            )
        )
        if active_work:
            raise ValueError("Cannot delete a project while one of its workflows is active")
        await self.session.delete(project)
        await self.session.commit()

    async def update_project_memory(self, project_id: uuid.UUID, memory: str) -> Project:
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        project.memory = memory.strip()
        await self.session.commit()
        await self.session.refresh(project)
        return project

    async def get_coding_standards(self) -> str:
        setting = await self.session.get(SystemSetting, self.CODING_STANDARDS_KEY)
        return setting.value if setting else ""

    async def update_coding_standards(self, value: str) -> str:
        setting = await self.session.get(SystemSetting, self.CODING_STANDARDS_KEY)
        if setting is None:
            setting = SystemSetting(key=self.CODING_STANDARDS_KEY, value=value.strip())
            self.session.add(setting)
        else:
            setting.value = value.strip()
        await self.session.commit()
        return setting.value

    async def list_repositories(self, limit: int = 50, offset: int = 0) -> list[Repository]:
        result = await self.session.scalars(
            select(Repository).order_by(Repository.name).offset(offset).limit(limit)
        )
        return list(result)

    def repository_host_path(self, repository: Repository) -> str | None:
        return self.inspector.host_path(repository.path)

    async def register_repository(
        self, project_id: uuid.UUID, relative_path: str
    ) -> RegisteredRepository:
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        inspection = await self.inspector.inspect_relative(relative_path)
        repository = Repository(
            project_id=project.id,
            name=Path(inspection.path).name,
            path=inspection.path,
            default_branch=inspection.branch,
        )
        self.session.add(repository)
        try:
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            raise ValueError("Repository could not be registered") from error
        await self.session.refresh(repository)
        return RegisteredRepository(repository=repository, inspection=inspection)

    async def create_repository(
        self, project_id: uuid.UUID, name: str, *, commit: bool = True
    ) -> RegisteredRepository:
        project = await self.session.get(Project, project_id)
        if project is None:
            raise LookupError("Project not found")
        slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
        if not slug:
            raise ValueError("Repository name must contain letters or numbers")
        root = self.inspector.root
        target = root / slug
        if target.exists():
            raise ValueError("A repository directory with this name already exists")
        target.mkdir(mode=0o775)
        try:
            os.chown(target, -1, root.stat().st_gid)
            target.chmod(0o2775)
            await self._git_init(target)
            inspection = await self.inspector.inspect(target)
            repository = Repository(
                project_id=project.id,
                name=name.strip(),
                path=inspection.path,
                default_branch=inspection.branch,
            )
            self.session.add(repository)
            if commit:
                await self.session.commit()
            else:
                await self.session.flush()
            await self.session.refresh(repository)
            return RegisteredRepository(repository=repository, inspection=inspection)
        except Exception:
            if target.exists():
                shutil.rmtree(target)
            raise

    @staticmethod
    async def _git_init(target: Path) -> None:
        commands = [
            # --shared=group keeps .git group-writable so the provider
            # gateway (a different uid sharing the repository group) can
            # create locks and objects during checkpoints.
            ("init", "--initial-branch", "main", "--shared=group"),
            (
                "-c",
                "user.name=Mission Control",
                "-c",
                "user.email=mission-control@local",
                "commit",
                "--allow-empty",
                "-m",
                "Initialize repository",
            ),
        ]
        for args in commands:
            process = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                str(target),
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            if process.returncode != 0:
                detail = stderr.decode().strip() or stdout.decode().strip()
                raise ValueError(detail or "Unable to initialize Git repository")

    async def inspect_repository(self, repository: Repository) -> RepositoryInspection:
        return await self.inspector.inspect(Path(repository.path))

    async def archive_repository(self, repository: Repository) -> RepositoryArchive:
        path = Path(repository.path)
        inspection = await self.inspector.inspect(path)
        data = await self.inspector.archive(path)
        slug = re.sub(r"[^a-z0-9]+", "-", repository.name.strip().lower()).strip("-")
        filename = f"{slug or 'repository'}-{inspection.commit_sha[:7]}.zip"
        return RepositoryArchive(filename=filename, data=data)

    async def get_repository(self, repository_id: uuid.UUID) -> Repository:
        repository = await self.session.get(Repository, repository_id)
        if repository is None:
            raise LookupError("Repository not found")
        return repository

    async def update_repository(
        self,
        repository_id: uuid.UUID,
        *,
        name: str | None = None,
        default_branch: str | None = None,
    ) -> Repository:
        repository = await self.get_repository(repository_id)
        if name is not None:
            repository.name = name.strip()
        if default_branch is not None:
            repository.default_branch = default_branch.strip()
        await self.session.commit()
        await self.session.refresh(repository)
        return repository

    async def delete_repository(self, repository_id: uuid.UUID) -> None:
        repository = await self.get_repository(repository_id)
        active_run = await self.session.scalar(
            select(Run.id).where(
                Run.repository_id == repository.id,
                Run.status.in_(
                    ("awaiting_execution_approval", "queued_for_execution", "executing")
                ),
            )
        )
        if active_run is not None:
            raise ValueError("Cannot unregister a repository while execution is active")
        await self.session.delete(repository)
        await self.session.commit()
