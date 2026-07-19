from fastapi import APIRouter

from mission_control.api.v1.agents import router as agents_router
from mission_control.api.v1.approvals import router as approvals_router
from mission_control.api.v1.auth import router as auth_router
from mission_control.api.v1.catalog import router as catalog_router
from mission_control.api.v1.health import router as health_router
from mission_control.api.v1.objectives import router as objectives_router
from mission_control.api.v1.project_runtime import router as project_runtime_router
from mission_control.api.v1.providers import router as providers_router
from mission_control.api.v1.runs import router as runs_router
from mission_control.api.v1.settings import router as settings_router
from mission_control.api.v1.system import router as system_router
from mission_control.api.v1.tasks import router as tasks_router
from mission_control.api.websocket.events import router as events_router

api_router = APIRouter()
api_router.include_router(agents_router)
api_router.include_router(approvals_router)
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(catalog_router)
api_router.include_router(objectives_router)
api_router.include_router(providers_router)
api_router.include_router(project_runtime_router)
api_router.include_router(runs_router)
api_router.include_router(settings_router)
api_router.include_router(system_router)
api_router.include_router(tasks_router)
api_router.include_router(events_router)
