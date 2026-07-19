from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel

from mission_control.core.security import require_local_admin

router = APIRouter(prefix="/system", tags=["system"])


class JobAccepted(BaseModel):
    message_id: str
    status: str


@router.post("/heartbeat", response_model=JobAccepted, status_code=status.HTTP_202_ACCEPTED)
async def queue_heartbeat(_: Annotated[str, Depends(require_local_admin)]) -> JobAccepted:
    from mission_control.workers.actors.system import emit_system_heartbeat

    message = emit_system_heartbeat.send("api")
    return JobAccepted(message_id=message.message_id, status="queued")


@router.get("/me")
async def current_user(user: Annotated[str, Depends(require_local_admin)]) -> dict[str, str]:
    return {"username": user, "role": "administrator"}
