// Drives the dashboard in headless Chromium to verify the realtime event feed:
// one shared websocket, feed rendering, resilience to malformed channel events.
//
// Setup (once):  npm install --prefix .claude/skills/verify
// Run:           node .claude/skills/verify/drive-dashboard.mjs
//
// Screenshots land in .claude/skills/verify/screenshots/ (override: SHOT_DIR).
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const shotDir = process.env.SHOT_DIR ?? join(scriptDir, "screenshots");
mkdirSync(shotDir, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(
    "playwright is not installed for the verify harness.\n" +
      "Run: npm install --prefix .claude/skills/verify\n" +
      "(Chromium itself comes from the shared ~/.cache/ms-playwright cache; " +
      "run 'npx --prefix .claude/skills/verify playwright install chromium' if missing.)",
  );
  process.exit(2);
}

const BASE_URL = process.env.WEB_URL ?? "http://localhost:3000";

function acceptedCount() {
  const out = execSync(
    'docker compose logs api 2>&1 | grep -c "\\[accepted\\]" || true',
    { cwd: repoRoot, encoding: "utf8" },
  );
  return Number(out.trim());
}

function publish(json) {
  execSync(
    `docker compose exec -T redis redis-cli PUBLISH mission-control.events '${json}'`,
    { cwd: repoRoot, encoding: "utf8" },
  );
}

const before = acceptedCount();
console.log(`accepts before: ${before}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
page.on("pageerror", (err) => console.log(`PAGEERROR: ${err.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("mission-control.onboarding.tour", "done");
  window.localStorage.setItem("mission-control.onboarding.checklist", "dismissed");
});

await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
await page.waitForSelector("text=CHANNEL mission-control.events", { timeout: 30000 });
await page.waitForTimeout(2500);
console.log(`accepts after initial load: ${acceptedCount()} (was ${before}; expect +1)`);

publish(
  '{"type":"execution.started","source":"workflow","run_id":"deadbeef-0000-4000-8000-000000000000","task_count":3,"resumed":false}',
);
publish("this is not json at all {{{");
publish(
  '{"type":"execution.failed","source":"workflow","run_id":"deadbeef-0000-4000-8000-000000000000","task_id":"cafe0001-0000-4000-8000-000000000000","detail":"Command exited with status 1: pytest reported 2 failed tests"}',
);
await page.waitForTimeout(1500);

const feedPanel = page.locator("section", { hasText: "Event uplink" }).last();
const feed = await feedPanel.textContent();
console.log(`feed has execution.started: ${feed.includes("execution.started")}`);
console.log(`feed has detail pairs: ${feed.includes("task_count=3")}`);
console.log(
  `survived malformed publish (execution.failed arrived): ${feed.includes("execution.failed")}`,
);
console.log(
  `no reconnect after garbage (single system.connected): ${(feed.match(/system\.connected/g) ?? []).length === 1}`,
);

await feedPanel.screenshot({ path: join(shotDir, "feed-panel.png") });

// Client-side navigation away and back within the 2s linger window: the shared
// socket must survive and no new websocket accept may appear.
await page.click('a[href="/missions"]');
await page.waitForTimeout(800);
await page.click('a[href="/"]');
await page.waitForSelector("text=CHANNEL mission-control.events", { timeout: 30000 });
await page.waitForTimeout(1500);
console.log(`accepts after nav round-trip: ${acceptedCount()} (expect unchanged)`);

const feedAfterNav = await feedPanel.textContent();
console.log(
  `feed retained events across navigation: ${feedAfterNav.includes("execution.started")}`,
);

await browser.close();
console.log(`DONE (screenshots in ${shotDir})`);
