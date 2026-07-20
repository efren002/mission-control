from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from mission_control.core.security import require_local_admin
from mission_control.infrastructure.database.models import Agent, AgentInvocation
from mission_control.infrastructure.database.session import get_session
from mission_control.infrastructure.providers.gateway_client import ProviderGatewayClient

router = APIRouter(prefix="/providers", tags=["providers"])
Session = Annotated[AsyncSession, Depends(get_session)]

LOGIN_PROVIDERS = frozenset({"codex", "claude"})


class LoginCodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=4096)


class CustomProviderInput(BaseModel):
    """Shape mirrored from the gateway's providers.json validator.

    api_key is the plaintext provider key; the gateway encrypts it at rest and
    never returns it. Required on create, optional on update (None = keep the
    existing encrypted key).
    """

    name: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{1,38}$")
    kind: Literal["http"] = "http"
    format: Literal["openai", "anthropic"]
    base_url: str = Field(pattern=r"^https?://\S+$")
    model: str | None = None
    api_key: str | None = Field(default=None, min_length=1)
    max_tokens: int | None = Field(default=None, ge=1)


class ProviderPerformanceMetric(BaseModel):
    provider: str
    role: str | None
    invocations: int
    completed: int
    failed: int
    success_rate: float
    average_duration_ms: int | None
    fallback_attempts: int
    fallback_successes: int
    token_coverage: int
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    total_tokens: int


class ProviderPerformanceResponse(BaseModel):
    generated_at: datetime
    providers: list[ProviderPerformanceMetric]
    by_role: list[ProviderPerformanceMetric]


def _performance_metric(
    provider: str,
    role: str | None,
    rows: list[dict[str, int | str | None]],
) -> ProviderPerformanceMetric:
    invocations = sum(int(row["invocations"] or 0) for row in rows)
    completed = sum(int(row["completed"] or 0) for row in rows)
    failed = sum(int(row["failed"] or 0) for row in rows)
    duration_samples = [
        (int(row["duration_total"] or 0), int(row["duration_coverage"] or 0))
        for row in rows
    ]
    duration_total = sum(total for total, _ in duration_samples)
    duration_coverage = sum(coverage for _, coverage in duration_samples)
    return ProviderPerformanceMetric(
        provider=provider,
        role=role,
        invocations=invocations,
        completed=completed,
        failed=failed,
        success_rate=round((completed / invocations) * 100, 1) if invocations else 0,
        average_duration_ms=(
            round(duration_total / duration_coverage)
            if duration_coverage
            else None
        ),
        fallback_attempts=sum(int(row["fallback_attempts"] or 0) for row in rows),
        fallback_successes=sum(int(row["fallback_successes"] or 0) for row in rows),
        token_coverage=sum(int(row["token_coverage"] or 0) for row in rows),
        input_tokens=sum(int(row["input_tokens"] or 0) for row in rows),
        cached_input_tokens=sum(
            int(row["cached_input_tokens"] or 0) for row in rows
        ),
        output_tokens=sum(int(row["output_tokens"] or 0) for row in rows),
        total_tokens=sum(int(row["total_tokens"] or 0) for row in rows),
    )


@router.get("/performance", response_model=ProviderPerformanceResponse)
async def provider_performance(
    _: Annotated[str, Depends(require_local_admin)],
    session: Session,
) -> ProviderPerformanceResponse:
    completed = case((AgentInvocation.status == "completed", 1), else_=0)
    failed = case((AgentInvocation.status == "failed", 1), else_=0)
    fallback = case(
        (AgentInvocation.fallback_from_provider.is_not(None), 1),
        else_=0,
    )
    fallback_success = case(
        (
            AgentInvocation.fallback_from_provider.is_not(None)
            & (AgentInvocation.status == "completed"),
            1,
        ),
        else_=0,
    )
    duration_coverage = case(
        (AgentInvocation.duration_ms.is_not(None), 1),
        else_=0,
    )
    token_coverage = case(
        (AgentInvocation.total_tokens.is_not(None), 1),
        else_=0,
    )
    result = await session.execute(
        select(
            AgentInvocation.provider.label("provider"),
            Agent.role.label("role"),
            func.count().label("invocations"),
            func.sum(completed).label("completed"),
            func.sum(failed).label("failed"),
            func.sum(func.coalesce(AgentInvocation.duration_ms, 0)).label(
                "duration_total"
            ),
            func.sum(duration_coverage).label("duration_coverage"),
            func.sum(fallback).label("fallback_attempts"),
            func.sum(fallback_success).label("fallback_successes"),
            func.sum(token_coverage).label("token_coverage"),
            func.sum(func.coalesce(AgentInvocation.input_tokens, 0)).label(
                "input_tokens"
            ),
            func.sum(
                func.coalesce(AgentInvocation.cached_input_tokens, 0)
            ).label("cached_input_tokens"),
            func.sum(func.coalesce(AgentInvocation.output_tokens, 0)).label(
                "output_tokens"
            ),
            func.sum(func.coalesce(AgentInvocation.total_tokens, 0)).label(
                "total_tokens"
            ),
        )
        .join(Agent, Agent.id == AgentInvocation.agent_id)
        .where(
            AgentInvocation.run_id.is_not(None),
            AgentInvocation.provider.is_not(None),
            AgentInvocation.status.in_(("completed", "failed")),
        )
        .group_by(AgentInvocation.provider, Agent.role)
        .order_by(AgentInvocation.provider, Agent.role)
    )
    rows = [dict(row) for row in result.mappings().all()]
    by_role = [
        _performance_metric(
            str(row["provider"]),
            str(row["role"]),
            [row],
        )
        for row in rows
    ]
    providers = [
        _performance_metric(
            provider,
            None,
            [row for row in rows if row["provider"] == provider],
        )
        for provider in sorted({str(row["provider"]) for row in rows})
    ]
    return ProviderPerformanceResponse(
        generated_at=datetime.now(UTC),
        providers=providers,
        by_role=by_role,
    )


def _require_login_provider(provider: str) -> None:
    if provider not in LOGIN_PROVIDERS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown provider",
        )


def _gateway_unavailable(error: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Provider gateway unavailable: {error}",
    )


@router.get("", response_model=dict[str, Any])
async def provider_status(_: Annotated[str, Depends(require_local_admin)]) -> dict[str, Any]:
    try:
        return await ProviderGatewayClient().providers()
    except Exception as error:
        raise _gateway_unavailable(error) from error


@router.get("/sandboxes", response_model=dict[str, Any])
async def sandbox_status(_: Annotated[str, Depends(require_local_admin)]) -> dict[str, Any]:
    try:
        return await ProviderGatewayClient().sandboxes()
    except Exception as error:
        raise _gateway_unavailable(error) from error


@router.post("/{provider}/login")
async def start_provider_login(
    provider: str, _: Annotated[str, Depends(require_local_admin)]
) -> JSONResponse:
    _require_login_provider(provider)
    try:
        status_code, payload = await ProviderGatewayClient().login_start(provider)
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)


@router.get("/{provider}/login")
async def provider_login_status(
    provider: str, _: Annotated[str, Depends(require_local_admin)]
) -> JSONResponse:
    _require_login_provider(provider)
    try:
        status_code, payload = await ProviderGatewayClient().login_status(provider)
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)


@router.post("/{provider}/login/input")
async def submit_provider_login_code(
    provider: str,
    request: LoginCodeRequest,
    _: Annotated[str, Depends(require_local_admin)],
) -> JSONResponse:
    _require_login_provider(provider)
    try:
        status_code, payload = await ProviderGatewayClient().login_submit_code(
            provider, request.code
        )
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)


@router.delete("/{provider}/login")
async def cancel_provider_login(
    provider: str, _: Annotated[str, Depends(require_local_admin)]
) -> JSONResponse:
    _require_login_provider(provider)
    try:
        status_code, payload = await ProviderGatewayClient().login_cancel(provider)
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)


@router.post("/custom")
async def create_custom_provider(
    entry: CustomProviderInput,
    _: Annotated[str, Depends(require_local_admin)],
) -> JSONResponse:
    if not entry.api_key:
        raise HTTPException(status_code=422, detail="api_key is required when creating a provider")
    try:
        status_code, payload = await ProviderGatewayClient().create_custom_provider(
            entry.model_dump(exclude_none=True)
        )
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)


@router.put("/custom/{name}")
async def update_custom_provider(
    name: str,
    entry: CustomProviderInput,
    _: Annotated[str, Depends(require_local_admin)],
) -> JSONResponse:
    try:
        status_code, payload = await ProviderGatewayClient().update_custom_provider(
            name, entry.model_dump(exclude_none=True)
        )
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)


@router.delete("/custom/{name}")
async def delete_custom_provider(
    name: str, _: Annotated[str, Depends(require_local_admin)]
) -> JSONResponse:
    try:
        status_code, payload = await ProviderGatewayClient().delete_custom_provider(name)
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)


@router.get("/custom/{name}/models")
async def probe_custom_provider(
    name: str, _: Annotated[str, Depends(require_local_admin)]
) -> JSONResponse:
    try:
        status_code, payload = await ProviderGatewayClient().probe_custom_provider(name)
    except Exception as error:
        raise _gateway_unavailable(error) from error
    return JSONResponse(status_code=status_code, content=payload)
