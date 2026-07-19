from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
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
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with async_session_factory() as session:
        yield session


async def close_database() -> None:
    await engine.dispose()
