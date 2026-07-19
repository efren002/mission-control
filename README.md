# AI Company Mission Control

Local-first orchestration platform for supervised AI software-development workflows.

## Screenshots

![Dashboard overview](docs/dashboard-page.png)

![Mission screen](docs/mission-page.png)

## Current scope

This repository contains a Next.js dashboard, FastAPI API, Dramatiq workers, PostgreSQL,
Redis, migrations, health monitoring, realtime transport, and an isolated provider gateway
for Claude Code and Codex CLI. Approved execution runs can edit registered repositories and
record Git checkpoint commits through the provider gateway.

## Requirements

- Docker Engine with Docker Compose v2
- GNU Make (optional)

## Start locally

```bash
make up
```

That is the whole first-run setup. `make up` creates `.env` from `.env.example` with strong
generated values for `LOCAL_ADMIN_TOKEN` and `PROVIDER_GATEWAY_TOKEN` (rerunning it never
overwrites an existing `.env`), then builds and starts the stack. Without GNU Make, run the
equivalent by hand: copy `.env.example` to `.env`, replace both token placeholders with long
random values, and run `docker compose up --build`.

The first build installs both provider CLIs into the `provider-gateway` image. The gateway runs as a non-root user, has no Docker socket, and only accepts workspaces under `/workspaces`.

Open:

- Dashboard: http://localhost:3000
- API documentation: http://localhost:8000/docs
- API health: http://localhost:8000/api/v1/health

The dashboard signs in automatically in local development: the API serves the admin token from
`GET /api/v1/auth/local-session`, which is enabled only when `ENVIRONMENT=development`,
`AUTO_ADMIN_LOGIN=true`, and a real (non-placeholder) token is configured. The API port is bound
to `127.0.0.1` and CORS is restricted to the dashboard origin. Set `AUTO_ADMIN_LOGIN=false` and
enter the token manually in the top bar before exposing the service beyond localhost. The
realtime endpoint currently emits non-sensitive service telemetry only; application events will
require authenticated sessions before implementation.

## Authenticate the provider gateway

Open <http://localhost:3000/settings> and press **Connect** on a provider card.

- **Codex** shows a sign-in link and a one-time code. Open the link, enter the code, and the
  card flips to connected automatically.
- **Claude** shows a sign-in link. Sign in, copy the code the page gives you, and paste it into
  the card.

The Missions screen shows a reminder banner while any provider is disconnected. Sign-in runs the
provider's own CLI login inside the gateway container; the resulting credentials are stored in
named Docker volumes, survive gateway rebuilds, and are never displayed or stored by the
dashboard. A pending sign-in expires after ten minutes and can be cancelled at any time.

The equivalent terminal commands remain available:

Codex subscription login:

```bash
docker compose run --rm --no-deps provider-gateway codex login --device-auth
```

Claude subscription login:

```bash
docker compose run --rm --no-deps provider-gateway claude auth login
```

## Build with Missions

Open <http://localhost:3000/missions> for the guided workflow. Describe what you want to build,
press **Start mission**, and everything else happens on that one screen: a project is created
automatically (or pick an existing one), the planner drafts tasks, you review and approve the
plan inline, press **Build project**, and watch the tasks complete. Failures surface on the same
screen with a retry action.

The sections below describe the underlying pieces. The Objectives, Runs, Approvals, and Tasks
pages remain available under **Advanced** in the sidebar for step-by-step control and detailed
timelines; nothing about their behavior changed.

## Register a project and repository

Set `REPOSITORY_HOST_ROOT` in `.env` to the host directory containing the repositories you want Mission Control to inspect. The container always sees this directory as `/repositories`; repository registration accepts a path relative to that root (for example, `my-app`).

```bash
docker compose up -d --build
```

Open <http://localhost:3000/projects> (the admin session is established automatically in local development) and create a project. Then open <http://localhost:3000/repositories>, choose the project, and register the relative Git repository path.

![Projects page](docs/project-page.png)

![Repositories page](docs/repository-page.png)

## Create an objective

Open <http://localhost:3000/objectives>, select a project, describe the desired outcome and acceptance criteria, and create the objective. Press `Plan` to create a controlled, read-only planner run that generates proposed tasks for human review.

![Objectives page](docs/objectives-page.png)

## Persistent project instructions

Use **Settings** to save coding standards that apply to every project. On **Projects**, save
project-specific decisions, constraints, conventions, and operating rules. Every planner run receives
both sets of instructions; project memory takes precedence over a global standard when they conflict.
The values are stored in PostgreSQL and survive service restarts and rebuilds.

## Configure agents and workflow controls

A default roster (Lead Planner, Senior Developer, QA Engineer, and Code Reviewer, all on the
Codex provider) is seeded automatically the first time the API starts with an empty agents
table, so planning and automatic task assignment work without any manual agent setup. Open
**Agents** to create or edit planner, developer, QA, and reviewer profiles. Each profile selects
a provider and optional model, stores role-specific instructions, reports live provider availability,
can run a safe connectivity test, and exposes its invocation history. Generated tasks can be assigned
manually, or automatically by matching their requested role to an enabled agent.

![Agents page](docs/agents-page.png)

Open **Settings** to configure the planning provider and model, approval gates, automatic
assignment, task limits, provider timeout, output retention, repository-write authorization,
and global coding standards. Each assigned agent profile controls the provider and model used
for its execution tasks. Administrative and gateway tokens remain environment-managed secrets.
Provider sign-in is available from **Settings**; the resulting credentials live in the gateway's
Docker volumes and are intentionally never stored through the dashboard.

![Settings page](docs/settings-page.png)

## Run the Codex planner

After creating an objective, press `Plan`. The API returns immediately and the Dramatiq worker invokes Codex through the provider gateway in read-only mode. Generated tasks appear at <http://localhost:3000/tasks>. A successful plan moves the objective and run to `awaiting_approval`; no files are edited and no Git operations are performed.

![Tasks page](docs/tasks-page.png)

Open <http://localhost:3000/runs> to inspect the durable timeline, generated tasks, provider
invocation input/output excerpts, and errors for each attempt. Open
<http://localhost:3000/approvals> to review the proposed tasks. Approving a plan marks the run
complete and the objective planned; rejecting it records the reason and makes the objective
eligible for another planning attempt.

![Runs page](docs/run-page.png)

![Approvals page](docs/approvals-page.png)

## Execute an approved plan

Open the approved plan at <http://localhost:3000/runs> and press **Build project**. This explicit
action authorizes repository edits, automatically creates a Git repository when the project has
none, assigns the existing project repository when there is one, and immediately queues execution.
Repository management at <http://localhost:3000/repositories> is optional advanced setup for
projects that need a specific existing repository.

The worker processes tasks in plan order because each task builds on the same working tree. Live
states (`queued`, `in progress`, `completed`, `failed`, or `blocked`) appear on the Tasks and Runs
screens, which refresh every five seconds. Provider input/output excerpts and errors remain
available in the run detail.

Execution edits the selected repository mounted from `REPOSITORY_HOST_ROOT`; the repository path
shown in Runs and Repositories is where the resulting project can be opened on the host. Agents
never run `git commit` themselves; instead, Mission Control saves a checkpoint commit (authored
as "Mission Control") after every completed task, plus one before execution when the working tree
already had changes. When a task fails for good, its partial changes are also committed (as
"Task N (failed): ...") so they stay attributed to that task instead of leaking into the next
mission's baseline. Each task's diff is available from **View changes** on the Missions screen
(or `GET /api/v1/tasks/{id}/diff`), and any checkpoint can be rolled back with normal Git tools,
for example `git revert <sha>`. After a run finishes, **Undo this task** on the Missions screen
(or `POST /api/v1/tasks/{id}/revert`) creates that revert commit for you; the undo is refused if
the working tree is dirty and cancelled cleanly if later changes conflict with it.

While a task runs, the agent's output streams into the Missions screen live (stored as the
rolling invocation excerpt, so it also respects the retention setting). A failed provider
attempt is automatically retried once with the failure fed back to the agent; only a second
failure stops the run and blocks the remaining tasks so partial changes can be inspected before
retrying manually.

Provider invocations retain up to 4,000 characters of input and output by default. This can be
disabled in **Settings**. Output from invocations created before retention was enabled cannot be
recovered.

## Run project tests and preview the app

After a mission has built a repository, its completion panel includes **Run tests** and
**Run app**. Test runs are queued on the worker, executed inside the provider gateway against
the writable repository mount, and shown on the mission as a live rolling output excerpt. A
nonzero exit code is recorded as a failed test run without changing the mission or build status.

Mission Control detects these defaults when the project command is empty:

- Node projects with a `test` script: `npm test`
- Node projects with a `dev` script: `npm run dev -- --host 0.0.0.0 --port $PORT`
- Laravel projects: `php artisan test` and
  `php artisan serve --host 0.0.0.0 --port $PORT`

Use **Projects** to override either command. An empty field restores auto-detection. Commands
run through `sh -c` inside the provider gateway and should be treated as trusted project
configuration. App commands should listen on `0.0.0.0` and use `$PORT`; the gateway substitutes
an available port from `8201` through `8210`. While the app is running, **Open app** launches its
local preview and **Stop app** terminates the app process group.

Preview processes are intentionally local and ephemeral. Restarting the provider gateway stops
them, and at most ten apps can run concurrently with the default Compose port range. Change
`PROVIDER_GATEWAY_APP_PORT_RANGE` and the matching `ports` mapping in `compose.yaml` together if
you need a different range.

If the stack was already running before Phase 4, rebuild it so the worker loads the planner actor and the `tasks` migration:

```bash
docker compose up -d --build migrate worker api web
```

Both commands are interactive. If a browser cannot reach the container callback, copy the displayed URL or code into your host browser and paste the result back into the terminal. Claude also supports `claude setup-token` for a long-lived subscription OAuth token in automation, but do not commit that token to `.env` or source control.

Check provider availability:

```bash
docker compose up -d provider-gateway
docker compose exec provider-gateway codex login status
docker compose exec provider-gateway claude auth status --text
```

Check the authenticated gateway API by copying `PROVIDER_GATEWAY_TOKEN` from `.env`:

```bash
curl http://localhost:8100/health
curl http://localhost:8100/v1/providers \
  -H "Authorization: Bearer <PROVIDER_GATEWAY_TOKEN>"
```

Run the safe read-only smoke execution against the shared workspace:

```bash
curl -N -X POST http://localhost:8100/v1/execute/stream \
  -H "Authorization: Bearer <PROVIDER_GATEWAY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"codex","workspace":"/workspaces","prompt":"Describe this workspace in three concise bullets. Do not edit files."}'
```

The response is Server-Sent Events with `started`, `stdout`, `stderr`, and `completed` events.

## Common commands

```bash
make up
make test
make lint
make migrate
make down
```

## Architecture boundaries

- `api` accepts input and delegates application behavior.
- `worker` executes durable background work through Dramatiq.
- `domain` remains independent of FastAPI, SQLAlchemy, Redis, and AI providers.
- `application/ports` defines execution and provider contracts.
- `infrastructure` implements external integrations.
- Real AI tasks will run in disposable, non-root runner containers with worktrees mounted explicitly.
- Planning is read-only. Repository editing is available only through the execution state machine,
  with the global write setting enabled and (by default) a separate execution approval.

The general worker must never receive an unrestricted Docker socket or production credentials.
