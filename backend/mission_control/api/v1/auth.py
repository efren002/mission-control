from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from mission_control.core.config import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])

TOKEN_PLACEHOLDER_PREFIX = "replace-with"


class LocalSession(BaseModel):
    token: str


@router.get("/local-session", response_model=LocalSession)
async def local_session() -> LocalSession:
    """Return the admin token for automatic local sign-in.

    Only available in development with AUTO_ADMIN_LOGIN enabled and a real
    (non-placeholder) token configured. The API port is bound to 127.0.0.1 and
    CORS is restricted to the dashboard origin, so only local clients can read
    this response. Disable AUTO_ADMIN_LOGIN before exposing the service beyond
    localhost.
    """
    settings = get_settings()
    if (
        not settings.auto_admin_login
        or settings.environment != "development"
        or settings.local_admin_token.startswith(TOKEN_PLACEHOLDER_PREFIX)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Local session is not available"
        )
    return LocalSession(token=settings.local_admin_token)
