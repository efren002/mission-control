FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system mission-control \
    && adduser --system --ingroup mission-control --uid 10001 mission-control

COPY pyproject.toml alembic.ini ./
COPY alembic ./alembic
COPY mission_control ./mission_control

FROM base AS runtime
RUN pip install --no-cache-dir .
USER mission-control
CMD ["uvicorn", "mission_control.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM base AS development
ENV PYTHONPATH=/app
RUN pip install --no-cache-dir ".[dev]"
USER mission-control
CMD ["uvicorn", "mission_control.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
