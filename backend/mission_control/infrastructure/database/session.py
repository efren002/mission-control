import asyncio
import weakref
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from mission_control.core.config import get_settings

settings = get_settings()
# Dramatiq actors each run in a fresh event loop (asyncio.run), so pooled
# asyncpg connections would outlive their loop and fail on reuse. Workers
# therefore open a new connection per checkout instead of pooling.
engine = (
    create_async_engine(settings.database_url, poolclass=NullPool)
    if settings.worker_mode
    else create_async_engine(settings.database_url, pool_pre_ping=True)
)

# SQLAlchemy's engine lazily creates a first-connect setup lock (an
# asyncio.Lock) that binds permanently to whichever event loop first uses
# it. Every worker actor invocation runs its own asyncio.run() loop, so
# reusing the single global engine across invocations leaves that lock
# unusable outside its original loop and every later invocation fails to
# open a connection. Cache one engine per currently-running loop instead;
# each is disposable since NullPool never keeps a connection open between
# checkouts anyway.
_worker_engines: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, AsyncEngine]" = (
    weakref.WeakKeyDictionary()
)


def _engine_for_current_loop() -> AsyncEngine:
    if not settings.worker_mode:
        return engine
    loop = asyncio.get_running_loop()
    loop_engine = _worker_engines.get(loop)
    if loop_engine is None:
        loop_engine = create_async_engine(settings.database_url, poolclass=NullPool)
        _worker_engines[loop] = loop_engine
    return loop_engine


def async_session_factory() -> AsyncSession:
    return AsyncSession(_engine_for_current_loop(), expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with async_session_factory() as session:
        yield session


async def close_database() -> None:
    await engine.dispose()
