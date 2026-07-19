---
name: verify
description: Build/launch/drive recipe for verifying mission-control changes end-to-end
---

# Verifying mission-control changes

The whole stack runs via `docker compose` (compose.yaml at repo root); it is
usually already up. `docker compose ps` to confirm. The api container runs
uvicorn with `--reload` and a bind mount, and the web container runs Next dev
with a bind mount, so file edits are live without rebuilds. Wait for the
"WatchFiles detected changes ... Reloading" line in `docker compose logs api`
before probing backend edits.

## Surfaces

- Web UI: http://localhost:3000 (Next.js). Dashboard is `/`, other routes:
  /missions, /projects, /runs, /tasks, /approvals, /objectives, /agents,
  /repositories, /settings.
- API: http://localhost:8000/api/v1 (FastAPI). Websocket at
  /api/v1/ws/events (requires Origin header http://localhost:3000).
- Realtime bus: Redis pub/sub channel `mission-control.events`. Inject test
  events with:
  `docker compose exec -T redis redis-cli PUBLISH mission-control.events '{"type":"...","source":"workflow",...}'`

## Browser driving

A self-contained Playwright harness lives in this directory (kept out of the
app's dependencies on purpose):

```bash
npm install --prefix .claude/skills/verify        # once; pinned playwright
node .claude/skills/verify/drive-dashboard.mjs    # realtime-feed verification
```

Chromium comes from the shared `~/.cache/ms-playwright` cache; if missing, run
`npx --prefix .claude/skills/verify playwright install chromium`. New drive
scripts belong next to drive-dashboard.mjs and should resolve playwright via
`createRequire(import.meta.url)` so they work from any checkout location.

Gotcha: a first-visit onboarding modal (z-[70] overlay) blocks clicks.
Suppress it before load with:

```js
await page.addInitScript(() => {
  window.localStorage.setItem("mission-control.onboarding.tour", "done");
  window.localStorage.setItem("mission-control.onboarding.checklist", "dismissed");
});
```

## Useful checks

- Count websocket connects: `docker compose logs api | grep -c "\[accepted\]"`.
- Backend tests/lint run inside the container:
  `docker compose run --rm api python -m pytest`,
  web tests: `docker compose exec -T web npm test -- --run`.
- Local (host) python has no backend deps; use the containers.
