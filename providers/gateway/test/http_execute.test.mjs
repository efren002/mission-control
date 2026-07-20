import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

import { encryptKey } from "../src/crypto.mjs";

const MASTER_KEY = "ab".repeat(32); // 32-byte hex
const TOKEN = "test-gateway-token-http";
const GATEWAY_PORT = 18_300 + Math.floor(Math.random() * 500);
const baseUrl = () => `http://127.0.0.1:${GATEWAY_PORT}`;

let gateway;
let workspaceRoot;
let upstream;
let upstreamPort;
let configDir;

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
  workspaceRoot = mkdtempSync(join(tmpdir(), "gateway-http-ws-"));
  configDir = mkdtempSync(join(tmpdir(), "gateway-http-cfg-"));

  // Mock upstream OpenAI-compatible endpoint.
  upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    req.on("data", () => {});
    req.on("end", () => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "planned" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = upstream.address().port;

  writeFileSync(
    join(configDir, "providers.json"),
    JSON.stringify({
      providers: [
        {
          name: "openrouter",
          kind: "http",
          format: "openai",
          base_url: `http://127.0.0.1:${upstreamPort}/v1`,
          model: "anthropic/claude-3.5-sonnet",
          encrypted_api_key: encryptKey("sk-test", MASTER_KEY),
        },
      ],
    }),
  );

  gateway = spawn("node", [join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: {
      ...process.env,
      PROVIDER_GATEWAY_PORT: String(GATEWAY_PORT),
      PROVIDER_GATEWAY_TOKEN: TOKEN,
      PROVIDER_GATEWAY_WORKSPACE_ROOT: workspaceRoot,
      PROVIDER_GATEWAY_WORKTREE_ROOT: join(workspaceRoot, "worktrees"),
      CUSTOM_PROVIDERS_PATH: join(configDir, "providers.json"),
      PROVIDERS_ENCRYPTION_KEY: MASTER_KEY,
      // HTTP providers execute in-process and never touch the sandbox
      // supervisor; the tests run with --no-deps so the supervisor is absent.
      SANDBOX_REQUIRED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl()}/health`);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Gateway did not become healthy in time");
});

after(() => {
  gateway?.kill("SIGKILL");
  upstream?.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test("GET /v1/providers lists the http provider as installed and authenticated", async () => {
  const response = await fetch(`${baseUrl()}/v1/providers`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.providers.openrouter, "openrouter entry present");
  assert.equal(payload.providers.openrouter.kind, "http");
  assert.equal(payload.providers.openrouter.installed, true);
  assert.equal(payload.providers.openrouter.authenticated, true);
  assert.equal(payload.providers.openrouter.available, true);
});

test("POST /v1/execute dispatches to the http provider in-process and streams SSE", async () => {
  const response = await fetch(`${baseUrl()}/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openrouter",
      workspace: workspaceRoot,
      prompt: "plan something",
      accessMode: "read-only",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = parseEvents(await response.text());
  const started = events.find((e) => e.event === "started");
  const stdout = events.filter((e) => e.event === "stdout").map((e) => e.data.data).join("");
  const completed = events.find((e) => e.event === "completed");
  assert.ok(started, "started event emitted");
  assert.equal(started.data.provider, "openrouter");
  assert.equal(stdout, "planned");
  assert.ok(completed, "completed event emitted");
  assert.equal(completed.data.exitCode, 0);
  assert.equal(completed.data.provider, "openrouter");
  assert.equal(completed.data.usage.inputTokens, 3);
  assert.equal(completed.data.usage.totalTokens, 4);
});

test("POST /v1/execute surfaces an unknown provider name as an SSE error event", async () => {
  const response = await fetch(`${baseUrl()}/v1/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "ninerouter", workspace: workspaceRoot, prompt: "x" }),
  });
  // The execute route commits to an SSE 200 response before validating the
  // provider, so an unknown name arrives as an `error` event, not a 400.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = parseEvents(await response.text());
  const error = events.find((e) => e.event === "error");
  assert.ok(error, "error event emitted");
  assert.match(error.data.detail, /Unsupported provider/i);
});

test("POST /v1/providers/openrouter/login returns 404 for an http provider", async () => {
  const response = await fetch(`${baseUrl()}/v1/providers/openrouter/login`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 404);
});
