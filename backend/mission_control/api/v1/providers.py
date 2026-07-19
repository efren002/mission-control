from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from mission_control.core.security import require_local_admin
from mission_control.infrastructure.providers.gateway_client import ProviderGatewayClient

router = APIRouter(prefix="/providers", tags=["providers"])

LOGIN_PROVIDERS = frozenset({"codex", "claude"})


class LoginCodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=4096)


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
