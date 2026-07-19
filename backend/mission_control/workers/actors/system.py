import json
from datetime import UTC, datetime

import dramatiq
from redis import Redis

from mission_control.core.config import get_settings
from mission_control.infrastructure.queue.broker import broker as broker


@dramatiq.actor(max_retries=3, min_backoff=1000)
def emit_system_heartbeat(source: str = "worker") -> dict[str, str]:
    event = {
        "type": "system.heartbeat",
        "source": source,
        "timestamp": datetime.now(UTC).isoformat(),
    }
    client = Redis.from_url(get_settings().redis_url, decode_responses=True)
    client.publish("mission-control.events", json.dumps(event))
    client.close()
    return event
