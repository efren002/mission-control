from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.application.services.catalog import CatalogService
from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import Repository
from mission_control.infrastructure.database.session import get_session

router = APIRouter(tags=["catalog"])
Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[str, Depends(require_local_admin)]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectResponse(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    memory: str
    test_command: str | None
    app_command: str | None

    model_config = {"from_attributes": True}


class RepositoryCreate(BaseModel):
    project_id: uuid.UUID
    relative_path: str = Field(min_length=1, max_length=1000)


class NewRepositoryCreate(BaseModel):
    project_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)


class RepositoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    default_branch: str | None = Field(default=None, min_length=1, max_length=200)


class MemoryUpdate(BaseModel):
    value: str = Field(default="", max_length=50000)


class CodingStandardsResponse(BaseModel):
    value: str


class RepositoryResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    path: str
    host_path: str | None = None
    default_branch: str

    model_config = {"from_attributes": True}


class RepositoryDetail(RepositoryResponse):
    branch: str
    commit_sha: str
    clean: bool
    technology: list[str]


def _repository_response(service: CatalogService, repository: Repository) -> RepositoryResponse:
    response = RepositoryResponse.model_validate(repository)
    return response.model_copy(update={"host_path": service.repository_host_path(repository)})


@router.get("/projects", response_model=list[ProjectResponse])
async def list_projects(
    _: Admin,
    session: Session,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> list[ProjectResponse]:
    return [
        ProjectResponse.model_validate(item)
        for item in await CatalogService(session).list_projects(limit, offset)
    ]


@router.post("/projects", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(payload: ProjectCreate, _: Admin, session: Session) -> ProjectResponse:
    return ProjectResponse.model_validate(
        await CatalogService(session).create_project(payload.name)
    )


@router.put("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: uuid.UUID, payload: ProjectUpdate, _: Admin, session: Session
) -> ProjectResponse:
    try:
        project = await CatalogService(session).update_project(project_id, payload.name)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return ProjectResponse.model_validate(project)


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: uuid.UUID, _: Admin, session: Session) -> Response:
    try:
        await CatalogService(session).delete_project(project_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/projects/{project_id}/memory", response_model=ProjectResponse)
async def update_project_memory(
    project_id: uuid.UUID, payload: MemoryUpdate, _: Admin, session: Session
) -> ProjectResponse:
    try:
        project = await CatalogService(session).update_project_memory(project_id, payload.value)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return ProjectResponse.model_validate(project)


@router.get("/settings/coding-standards", response_model=CodingStandardsResponse)
async def get_coding_standards(_: Admin, session: Session) -> CodingStandardsResponse:
    return CodingStandardsResponse(value=await CatalogService(session).get_coding_standards())


@router.put("/settings/coding-standards", response_model=CodingStandardsResponse)
async def update_coding_standards(
    payload: MemoryUpdate, _: Admin, session: Session
) -> CodingStandardsResponse:
    value = await CatalogService(session).update_coding_standards(payload.value)
    return CodingStandardsResponse(value=value)


@router.get("/repositories", response_model=list[RepositoryResponse])
async def list_repositories(
    _: Admin,
    session: Session,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> list[RepositoryResponse]:
    service = CatalogService(session)
    return [
        _repository_response(service, item)
        for item in await service.list_repositories(limit, offset)
    ]


@router.post("/repositories", response_model=RepositoryDetail, status_code=status.HTTP_201_CREATED)
async def register_repository(
    payload: RepositoryCreate, _: Admin, session: Session
) -> RepositoryDetail:
    service = CatalogService(session)
    try:
        registered = await service.register_repository(payload.project_id, payload.relative_path)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    inspection = registered.inspection
    return RepositoryDetail(
        **_repository_response(service, registered.repository).model_dump(),
        branch=inspection.branch,
        commit_sha=inspection.commit_sha,
        clean=inspection.clean,
        technology=list(inspection.technology),
    )


@router.post(
    "/repositories/new",
    response_model=RepositoryDetail,
    status_code=status.HTTP_201_CREATED,
)
async def create_repository(
    payload: NewRepositoryCreate, _: Admin, session: Session
) -> RepositoryDetail:
    service = CatalogService(session)
    try:
        created = await service.create_repository(payload.project_id, payload.name)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    inspection = created.inspection
    return RepositoryDetail(
        **_repository_response(service, created.repository).model_dump(),
        branch=inspection.branch,
        commit_sha=inspection.commit_sha,
        clean=inspection.clean,
        technology=list(inspection.technology),
    )


@router.get("/repositories/{repository_id}", response_model=RepositoryDetail)
async def inspect_repository(
    repository_id: uuid.UUID, _: Admin, session: Session
) -> RepositoryDetail:
    service = CatalogService(session)
    try:
        repository = await service.get_repository(repository_id)
        inspection = await service.inspect_repository(repository)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return RepositoryDetail(
        **_repository_response(service, repository).model_dump(),
        branch=inspection.branch,
        commit_sha=inspection.commit_sha,
        clean=inspection.clean,
        technology=list(inspection.technology),
    )


@router.get("/repositories/{repository_id}/archive")
async def download_repository_archive(
    repository_id: uuid.UUID, _: Admin, session: Session
) -> Response:
    service = CatalogService(session)
    try:
        repository = await service.get_repository(repository_id)
        archive = await service.archive_repository(repository)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return Response(
        content=archive.data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{archive.filename}"'},
    )


@router.put("/repositories/{repository_id}", response_model=RepositoryResponse)
async def update_repository(
    repository_id: uuid.UUID,
    payload: RepositoryUpdate,
    _: Admin,
    session: Session,
) -> RepositoryResponse:
    if payload.name is None and payload.default_branch is None:
        raise HTTPException(status_code=422, detail="At least one field is required")
    try:
        repository = await CatalogService(session).update_repository(
            repository_id,
            name=payload.name,
            default_branch=payload.default_branch,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return _repository_response(CatalogService(session), repository)


@router.delete("/repositories/{repository_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_repository(repository_id: uuid.UUID, _: Admin, session: Session) -> Response:
    try:
        await CatalogService(session).delete_repository(repository_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)
