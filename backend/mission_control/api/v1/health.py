from typing import Annotated, Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.core.config import get_settings
from mission_control.infrastructure.database.session import get_session
from mission_control.infrastructure.providers.gateway_client import (
    ProviderGatewayClient,
    RuntimeGatewayClient,
)

router = APIRouter(prefix="/health", tags=["health"])


class ComponentHealth(BaseModel):
    status: Literal["operational", "unavailable"]


class HealthResponse(BaseModel):
    status: Literal["operational", "degraded"]
    service: str
    components: dict[str, ComponentHealth]


@router.get("/live", status_code=status.HTTP_200_OK)
async def liveness() -> dict[str, str]:
    return {"status": "operational"}


@router.get("", response_model=HealthResponse)
async def health(session: Annotated[AsyncSession, Depends(get_session)]) -> HealthResponse:
    components: dict[str, ComponentHealth] = {}
    try:
        await session.execute(text("SELECT 1"))
        components["postgres"] = ComponentHealth(status="operational")
    except Exception:
        components["postgres"] = ComponentHealth(status="unavailable")

    redis = Redis.from_url(get_settings().redis_url)
    try:
        await redis.ping()
        components["redis"] = ComponentHealth(status="operational")
    except Exception:
        components["redis"] = ComponentHealth(status="unavailable")
    finally:
        await redis.aclose()

    gateway = await ProviderGatewayClient().health()
    components["provider_gateway"] = ComponentHealth(
        status="operational" if gateway.get("status") == "operational" else "unavailable"
    )
    runtime_gateway = await RuntimeGatewayClient().health()
    components["runtime_gateway"] = ComponentHealth(
        status=(
            "operational"
            if runtime_gateway.get("status") == "operational"
            else "unavailable"
        )
    )

    overall = (
        "operational"
        if all(component.status == "operational" for component in components.values())
        else "degraded"
    )
    return HealthResponse(
        status=overall,
        service=get_settings().app_name,
        components=components,
    )
