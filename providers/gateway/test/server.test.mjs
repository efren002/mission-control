import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const TOKEN = "test-gateway-token";
const GATEWAY_PORT = 18_100 + Math.floor(Math.random() * 1_000);
const APP_PORT_RANGE = "18901-18902";

let gateway;
let workspaceRoot;
let workspace;
const baseUrl = () => `http://127.0.0.1:${GATEWAY_PORT}`;

function request(path, options = {}) {
  return fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

function parseEvents(sseBody) {
  const events = [];
  let name = null;
  for (const line of sseBody.split("\n")) {
    if (line.startsWith("event:")) name = line.slice("event:".length).trim();
    if (line.startsWith("data:") && name) {
      events.push({ event: name, data: JSON.parse(line.slice("data:".length)) });
      name = null;
    }
  }
  return events;
}

before(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "gateway-server-"));
  workspace = join(workspaceRoot, "project");
  mkdirSync(workspace);
  gateway = spawn("node", [join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: {
      ...process.env,
      PROVIDER_GATEWAY_PORT: String(GATEWAY_PORT),
      PROVIDER_GATEWAY_TOKEN: TOKEN,
      PROVIDER_GATEWAY_WORKSPACE_ROOT: workspaceRoot,
      PROVIDER_GATEWAY_APP_PORT_RANGE: APP_PORT_RANGE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl()}/health`);
      if (response.ok) return;
    } catch {
      // Server is not accepting connections yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Gateway did not become healthy in time");
});

after(() => {
  gateway?.kill("SIGKILL");
  rmSync(workspaceRoot, { recursive: true, force: true });
});

test("commands/stream requires gateway credentials", async () => {
  const response = await fetch(`${baseUrl()}/v1/commands/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace, command: "echo hi" }),
  });
  assert.equal(response.status, 401);
});

test("commands/stream streams stdout and completes with the exit code", async () => {
  const response = await request("/v1/commands/stream", {
    method: "POST",
    body: JSON.stringify({ workspace, command: "echo tests-passed" }),
  });
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  const stdout = events.filter((item) => item.event === "stdout").map((item) => item.data.data).join("");
  const completed = events.find((item) => item.event === "completed");
  assert.match(stdout, /tests-passed/);
  assert.equal(completed.data.exitCode, 0);
  assert.equal(completed.data.timedOut, false);
});

test("commands/stream reports a failing command", async () => {
  const response = await request("/v1/commands/stream", {
    method: "POST",
    body: JSON.stringify({ workspace, command: "echo broken >&2; exit 3" }),
  });
  const events = parseEvents(await response.text());
  const stderr = events.filter((item) => item.event === "stderr").map((item) => item.data.data).join("");
  const completed = events.find((item) => item.event === "completed");
  assert.match(stderr, /broken/);
  assert.equal(completed.data.exitCode, 3);
});

test("commands/stream rejects an empty command", async () => {
  const response = await request("/v1/commands/stream", {
    method: "POST",
    body: JSON.stringify({ workspace, command: "   " }),
  });
  assert.equal(response.status, 400);
});

test("commands/stream rejects a workspace outside the root", async () => {
  const response = await request("/v1/commands/stream", {
    method: "POST",
    body: JSON.stringify({ workspace: "/etc", command: "echo hi" }),
  });
  assert.equal(response.status, 400);
});

test("commands/stream terminates the process group when the client disconnects", async () => {
  const marker = join(workspace, "orphaned-command.txt");
  const controller = new AbortController();
  const response = await request("/v1/commands/stream", {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({
      workspace,
      command: "sleep 2; echo survived > orphaned-command.txt",
    }),
  });
  const pendingBody = response.text();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  controller.abort();
  await assert.rejects(pendingBody, /abort/i);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
  assert.equal(existsSync(marker), false);
});

test("apps lifecycle: start substitutes the port, blocks duplicates, stops cleanly", async () => {
  const started = await request("/v1/apps/start", {
    method: "POST",
    body: JSON.stringify({ workspace, command: "echo serving on $PORT; sleep 30" }),
  });
  assert.equal(started.status, 200);
  const startedPayload = await started.json();
  assert.equal(startedPayload.status, "running");
  assert.equal(startedPayload.port, 18_901);
  assert.match(startedPayload.command, /sleep 30/);
  assert.doesNotMatch(startedPayload.command, /\$PORT/);
  assert.match(startedPayload.command, /18901/);

  const duplicate = await request("/v1/apps/start", {
    method: "POST",
    body: JSON.stringify({ workspace, command: "sleep 30" }),
  });
  assert.equal(duplicate.status, 409);

  const listed = await request("/v1/apps");
  const listedPayload = await listed.json();
  assert.equal(listedPayload.apps.length, 1);
  assert.equal(listedPayload.apps[0].workspace, workspace);
  assert.equal(listedPayload.apps[0].status, "running");

  const stopped = await request("/v1/apps/stop", {
    method: "POST",
    body: JSON.stringify({ workspace }),
  });
  assert.equal(stopped.status, 200);
  const stoppedPayload = await stopped.json();
  assert.equal(stoppedPayload.status, "stopped");

  const restarted = await request("/v1/apps/start", {
    method: "POST",
    body: JSON.stringify({ workspace, command: "sleep 30" }),
  });
  assert.equal(restarted.status, 200);
  await request("/v1/apps/stop", { method: "POST", body: JSON.stringify({ workspace }) });
});

test("apps/stop for an unknown workspace returns 404", async () => {
  const other = join(workspaceRoot, "other");
  mkdirSync(other, { recursive: true });
  const response = await request("/v1/apps/stop", {
    method: "POST",
    body: JSON.stringify({ workspace: other }),
  });
  assert.equal(response.status, 404);
});
