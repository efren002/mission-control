from unittest.mock import AsyncMock, MagicMock

import pytest

from mission_control.api.websocket import events


class ClosedWebSocket:
    def __init__(self) -> None:
        self.accept = AsyncMock()
        self.send_json = AsyncMock(
            side_effect=[
                None,
                RuntimeError(
                    "unable to perform operation on TCPTransport; the handler is closed"
                ),
            ]
        )


@pytest.mark.asyncio
async def test_event_stream_treats_a_closed_transport_as_a_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    websocket = ClosedWebSocket()
    pubsub = MagicMock()
    pubsub.subscribe = AsyncMock()
    pubsub.get_message = AsyncMock(return_value=None)
    pubsub.unsubscribe = AsyncMock()
    pubsub.aclose = AsyncMock()
    redis = MagicMock()
    redis.pubsub.return_value = pubsub
    redis.aclose = AsyncMock()
    monkeypatch.setattr(events.Redis, "from_url", MagicMock(return_value=redis))

    await events.event_stream(websocket)  # type: ignore[arg-type]

    websocket.accept.assert_awaited_once()
    assert websocket.send_json.await_count == 2
    pubsub.unsubscribe.assert_awaited_once_with("mission-control.events")
    pubsub.aclose.assert_awaited_once()
    redis.aclose.assert_awaited_once()


@pytest.mark.parametrize(
    ("detail", "expected"),
    [
        ("the handler is closed", True),
        ("Cannot call send once a close message has been sent", True),
        ("serialization failed", False),
    ],
)
def test_closed_transport_detection(detail: str, expected: bool) -> None:
    assert events._is_closed_transport(RuntimeError(detail)) is expected
