# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Local-first orchestration platform for supervised AI software-development workflows. A Next.js dashboard drives a FastAPI + Dramatiq backend that plans, executes, verifies, and integrates code changes produced by Claude Code / Codex CLIs running inside isolated gateways. All process state is durable (PostgreSQL) and every provider/test invocation runs in a disposable, token-protected sandbox container.

## Commands

Everything runs through Docker Compose via the Makefile. There is no host-side dev workflow.

```bash
make up                 # create .env with generated tokens, build, start full stack
make up-runtime-egress  # same, but allow outbound internet for trusted project tests/previews
make down
make logs               # api + worker + web
make migrate            # docker compose run --rm migrate (Alembic)

make test               # gateway (node --test) + api (pytest) + web (vitest)
make lint               # ruff + mypy (api) + eslint + tsc (web)
make format             # ruff format + prettier

make api-shell          # shell into running api container
make web-shell          # shell into running web container
```

Run a single test suite (still containerized):

```bash
docker compose run --rm api python -m pytest tests/test_job_dispatch.py::test_name
docker compose run --rm web npm test -- --run features/missions/mission-board.test.tsx
docker compose run --rm --no-deps provider-gateway npm test
```

Tokens (`LOCAL_ADMIN_TOKEN`, `PROVIDER_GATEWAY_TOKEN`, `RUNTIME_GATEWAY_TOKEN`, `SANDBOX_SUPERVISOR_TOKEN`) are generated into `.env` by `make setup` and never overwritten on subsequent runs.

## Architecture boundaries (backend)

Strict layered Python package at [backend/mission_control/](backend/mission_control/). Dependencies point inward; inner layers must not import outer ones.

- [api/v1/](backend/mission_control/api/v1/) — FastAPI routers. Thin: validate, call an application service, return. Aggregated in [router.py](backend/mission_control/api/v1/router.py) and mounted under `/api/v1`.
- [application/services/](backend/mission_control/application/services/) — orchestration: objectives, agents, job dispatch, provider routing, maintenance, run events, runtime detection. Workflow logic lives here.
- [application/ports/](backend/mission_control/application/ports/) — abstract contracts (`providers`, `runners`). Services depend on these, not on concrete infra.
- [domain/](backend/mission_control/domain/) — kept pure: no FastAPI, SQLAlchemy, Redis, or provider imports.
- [infrastructure/](backend/mission_control/infrastructure/) — concrete adapters: `database/` (SQLAlchemy async, Alembic models), `providers/gateway_client.py`, `queue/` (Redis/Dramatiq), `git/`.
- [workers/actors/](backend/mission_control/workers/actors/) — Dramatiq actors: `planner`, `executor`, `maintenance`, `commands`, `system`.
- [core/](backend/mission_control/core/) — `config.py` (pydantic-settings, `lru_cache`d `get_settings()`), `security.py`, `logging.py`.

Entrypoint: [main.py](backend/mission_control/main.py). The `lifespan` seeds default agents and starts two background loops: `dispatch_loop` (transactional outbox → Redis) and `maintenance_scheduler_loop`. Both are cancelled on shutdown.

## Workflow state machine

Objective → `Plan` (read-only planner actor through provider gateway) → generated tasks → human **approval** → `Build project` (authorizes repo writes, queues executor) → per-task execution in a run-scoped linked Git worktree on `mission-control/run-<run-id>` → checkpoint commit after each task → deterministic project tests → independent reviewer against acceptance criteria → **fast-forward-only merge** into the registered repository.

Hard rules enforced in code and PostgreSQL:
- Planning is read-only. Writes require the global write setting + approval gates.
- A failing deterministic test blocks completion even if the reviewer approves.
- Reviewer verification is read-only and recorded as a separate invocation.
- Provider fallback is bounded to one alternate-provider attempt; both routes are recorded.
- Tasks predicted to touch overlapping files are serialized before execution; merge conflicts preserve the task branch and create a **task integration** approval instead of clobbering.

## Dispatch outbox (reliability core)

Planning and test-publication jobs are written to a PostgreSQL outbox (`dispatch_jobs`) in the same transaction as their workflow state change. `dispatch_loop` retries pending outbox records every ~5s and delivers to Redis/Dramatiq. Redis being down queues work durably instead of losing it. Actor state claims make duplicate delivery safe. See [application/services/job_dispatch.py](backend/mission_control/application/services/job_dispatch.py).

## Gateways and the sandbox

Two separate Node services plus a sandbox supervisor. The Docker socket is given **only** to `sandbox-supervisor`; no other service gets it.

- **provider-gateway** ([providers/gateway/](providers/gateway/), port 8100) — non-root, no Docker socket, has Codex/Claude CLIs and their credential volumes, accepts workspaces only under `/workspaces`. Streaming execute endpoint returns SSE (`started`/`stdout`/`stderr`/`completed`). Used for planning, execution, reviewer verification, provider sign-in.
- **runtime-gateway** (port 8110) — credential-free, independent token, no provider credential volumes. Runs project tests and app previews. Starts in `runtime-only` mode (rejects provider exec/login/git mutation even with a valid token). Default-deny networking; tests are always offline.
- **sandbox-supervisor** — owns the Docker socket, exposes a narrow token-protected API. Builds disposable containers (read-only rootfs, dropped caps, `no-new-privileges`, init, memory-backed `/tmp`+HOME, resource limits from `SANDBOX_*`). Both gateways require `SANDBOX_REQUIRED` and refuse work rather than falling back to in-gateway execution when the supervisor is down.

Egress override (`make up-runtime-egress`) enables masquerading on the runtime bridge only; it does not join the gateway to the control plane.

## Frontend (apps/web)

Next.js 15 + React 19 + TanStack Query + Tailwind. App-router under [app/(mission-control)/](apps/web/app/(mission-control)/). Feature modules under [features/](apps/web/features/) (`missions`, `operations`, `catalog`, `auth`, `onboarding`, `system`); shared UI under [components/](apps/web/components/), API/WS clients under [lib/](apps/web/lib/) and [providers/](apps/web/providers/). Auto-admin-login in development pulls the token from `GET /api/v1/auth/local-session`. Realtime events arrive over a WebSocket that authenticates with the admin token in the `Sec-WebSocket-Protocol` header.

## Conventions

- Python ≥3.12, ruff (line-length 100, rules `E F I UP B ASYNC RUF`), mypy **strict** with pydantic + sqlalchemy plugins. Tests use `pytest-asyncio` in auto mode.
- Workflow status values and concurrency invariants are enforced in PostgreSQL as well as in code — when changing a status or adding a state transition, update both the app logic and the DB constraints/migration together.
- Alembic migrations are transactional DDL and live in [backend/alembic/versions/](backend/alembic/versions/). After model changes, add a migration and run `make migrate`.
- Prompts are versioned under [prompts/](prompts/); the provider result contract is [schemas/provider-result.schema.json](schemas/provider-result.schema.json).
