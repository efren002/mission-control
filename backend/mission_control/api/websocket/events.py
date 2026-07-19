import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.asyncio import Redis

from mission_control.core.config import get_settings

router = APIRouter(tags=["realtime"])


def _is_closed_transport(error: RuntimeError) -> bool:
    detail = str(error).lower()
    return "closed" in detail or "close message" in detail


@router.websocket("/ws/events")
async def event_stream(websocket: WebSocket) -> None:
    await websocket.accept()
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
            await websocket.send_json(json.loads(data) if isinstance(data, str) else data)
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
