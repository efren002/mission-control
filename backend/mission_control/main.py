from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response

from mission_control.api.v1.router import api_router
from mission_control.application.services.agents import AgentService
from mission_control.core.config import get_settings
from mission_control.core.logging import configure_logging
from mission_control.infrastructure.database.session import async_session_factory, close_database

settings = get_settings()
configure_logging(settings.log_level)
logger = logging.getLogger(__name__)


async def seed_default_agents() -> None:
    try:
        async with async_session_factory() as session:
            created = await AgentService(session).seed_defaults()
    except Exception:
        logger.warning("default_agent_seeding_skipped", exc_info=True)
        return
    if created:
        logger.info("default_agents_seeded", extra={"count": created})


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    logger.info("mission_control_started", extra={"environment": settings.environment})
    await seed_default_agents()
    yield
    await close_database()
    logger.info("mission_control_stopped")


def create_application() -> FastAPI:
    application = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.api_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    application.include_router(api_router, prefix="/api/v1")
    return application


app = create_application()
