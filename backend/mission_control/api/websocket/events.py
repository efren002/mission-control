import asyncio
import base64
import json
import secrets

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.asyncio import Redis

from mission_control.core.config import get_settings

router = APIRouter(tags=["realtime"])


def _origin_is_allowed(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin")
    return origin is not None and origin in get_settings().api_cors_origins


def _requested_admin_token(websocket: WebSocket) -> str | None:
    protocols = websocket.headers.get("sec-websocket-protocol", "")
    encoded = next(
        (
            item.strip().removeprefix("bearer.")
            for item in protocols.split(",")
            if item.strip().startswith("bearer.")
        ),
        None,
    )
    if not encoded:
        return None
    try:
        padding = "=" * (-len(encoded) % 4)
        return base64.urlsafe_b64decode(f"{encoded}{padding}").decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return None


def _is_authenticated(websocket: WebSocket) -> bool:
    token = _requested_admin_token(websocket)
    return token is not None and secrets.compare_digest(
        token, get_settings().local_admin_token
    )


def _is_closed_transport(error: RuntimeError) -> bool:
    detail = str(error).lower()
    return "closed" in detail or "close message" in detail


@router.websocket("/ws/events")
async def event_stream(websocket: WebSocket) -> None:
    if not _origin_is_allowed(websocket):
        await websocket.close(code=1008, reason="Origin not allowed")
        return
    if not _is_authenticated(websocket):
        await websocket.close(code=1008, reason="Invalid credentials")
        return
    await websocket.accept(subprotocol="mission-control")
    redis = Redis.from_url(get_settings().redis_url, decode_responses=True)
    pubsub = redis.pubsub()
    await pubsub.subscribe("mission-control.events")
    try:
        await websocket.send_json({"type": "system.connected", "source": "api"})
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15)
            if message is None:
                await websocket.send_json({"type": "system.keepalive", "source": "api"})
                continue
            data = message["data"]
            try:
                payload = json.loads(data) if isinstance(data, str) else data
            except json.JSONDecodeError:
                continue
            await websocket.send_json(payload)
            await asyncio.sleep(0)
    except WebSocketDisconnect:
        pass
    except RuntimeError as error:
        if not _is_closed_transport(error):
            raise
    finally:
        await pubsub.unsubscribe("mission-control.events")
        await pubsub.aclose()
        await redis.aclose()
