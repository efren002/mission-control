import secrets
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from mission_control.core.config import get_settings

bearer_scheme = HTTPBearer(auto_error=False)


async def require_local_admin(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> str:
    settings = get_settings()
    if credentials is None or not secrets.compare_digest(
        credentials.credentials, settings.local_admin_token
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    return "local-admin"
