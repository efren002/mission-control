import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";

const TOKEN = "test-gateway-token";
const GATEWAY_PORT = 19_100 + Math.floor(Math.random() * 1_000);

let gateway;
let workspaceRoot;
let stubDir;
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

async function pollLogin(provider, predicate, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await request(`/v1/providers/${provider}/login`);
    const payload = await response.json();
    if (predicate(payload)) return payload;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Login session for ${provider} did not reach the expected state`);
}

function writeStub(name, body) {
  const path = join(stubDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

before(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "gateway-login-"));
  stubDir = mkdtempSync(join(tmpdir(), "gateway-login-stubs-"));

  // Replays the real codex device-auth output (ANSI colors included), then
  // waits for a control file next to the stub before reporting success.
  writeStub(
    "codex",
    [
      'dir=$(dirname "$0")',
      'printf "Welcome to Codex [v\\033[90m0.144.5\\033[0m]\\n"',
      'printf "1. Open this link in your browser and sign in to your account\\n"',
      'printf "   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n"',
      'printf "2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n"',
      'printf "   \\033[94mD5IO-KN5QQ\\033[0m\\n"',
      'while [ ! -f "$dir/codex-approved" ]; do sleep 0.1; done',
      "exit 0",
    ].join("\n"),
  );

  // Replays the real claude login output (OSC-8 hyperlink included), then reads
  // pasted codes from the terminal. Like the real CLI it re-prompts once on a
  // rejected code instead of exiting, then fails hard on a second bad code.
  writeStub(
    "claude",
    [
      'printf "Opening browser to sign in\\n"',
      'printf "If the browser did not open, visit: \\033]8;;https://claude.com/oauth/authorize?code=true&state=abc\\007https://claude.com/oauth/authorize?code=true&state=abc\\033]8;;\\007\\n"',
      'printf "Paste code here if prompted > "',
      "read pasted_code",
      '[ "$pasted_code" = "valid-oauth-code#state" ] && exit 0',
      'if [ "$pasted_code" = "swallow-code" ]; then',
      // The real CLI prints nothing for an unrecognized code and keeps reading.
      "  read pasted_code",
      '  [ "$pasted_code" = "valid-oauth-code#state" ] && exit 0',
      "  exit 1",
      "fi",
      'printf "Invalid code\\n"',
      'printf "Paste code here if prompted > "',
      "read pasted_code",
      '[ "$pasted_code" = "valid-oauth-code#state" ] && exit 0',
      'printf "Invalid authorization code\\n"',
      "exit 1",
    ].join("\n"),
  );

  gateway = spawn("node", [join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: {
      ...process.env,
      PATH: `${stubDir}${delimiter}${process.env.PATH}`,
      PROVIDER_GATEWAY_PORT: String(GATEWAY_PORT),
      PROVIDER_GATEWAY_TOKEN: TOKEN,
      PROVIDER_GATEWAY_WORKSPACE_ROOT: workspaceRoot,
      PROVIDER_GATEWAY_LOGIN_VERIFY_TIMEOUT_MS: "1500",
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
  rmSync(stubDir, { recursive: true, force: true });
});

test("login routes require gateway credentials", async () => {
  const response = await fetch(`${baseUrl()}/v1/providers/codex/login`, { method: "POST" });
  assert.equal(response.status, 401);
});

test("login rejects unknown providers", async () => {
  const response = await request("/v1/providers/notreal/login", { method: "POST" });
  assert.equal(response.status, 404);
});

test("login status for a provider without a session returns 404", async () => {
  const response = await request("/v1/providers/claude/login");
  assert.equal(response.status, 404);
});

test("codex login parses the URL and device code, blocks duplicates, and succeeds", async () => {
  const started = await request("/v1/providers/codex/login", { method: "POST" });
  assert.equal(started.status, 200);
  const startedPayload = await started.json();
  assert.equal(startedPayload.provider, "codex");
  assert.equal(startedPayload.needsInput, false);

  const awaiting = await pollLogin(
    "codex",
    (payload) => payload.status === "awaiting_browser" && payload.url && payload.userCode,
  );
  assert.equal(awaiting.url, "https://auth.openai.com/codex/device");
  assert.equal(awaiting.userCode, "D5IO-KN5QQ");

  const duplicate = await request("/v1/providers/codex/login", { method: "POST" });
  assert.equal(duplicate.status, 409);

  const wrongInput = await request("/v1/providers/codex/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "anything" }),
  });
  assert.equal(wrongInput.status, 400);

  writeFileSync(join(stubDir, "codex-approved"), "");
  const succeeded = await pollLogin("codex", (payload) => payload.status === "succeeded");
  assert.equal(succeeded.error, null);
});

test("claude login accepts the pasted code and succeeds", async () => {
  const started = await request("/v1/providers/claude/login", { method: "POST" });
  assert.equal(started.status, 200);

  const awaiting = await pollLogin(
    "claude",
    (payload) => payload.status === "awaiting_input" && payload.url,
  );
  assert.equal(awaiting.needsInput, true);
  assert.match(awaiting.url, /^https:\/\/claude\.com\/oauth\/authorize/);

  const emptyCode = await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "   " }),
  });
  assert.equal(emptyCode.status, 400);
  const multiline = await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "line-one\nline-two" }),
  });
  assert.equal(multiline.status, 400);

  const submitted = await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "valid-oauth-code#state" }),
  });
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).status, "verifying");

  await pollLogin("claude", (payload) => payload.status === "succeeded");
});

test("claude login returns to awaiting_input when the code is rejected", async () => {
  await request("/v1/providers/claude/login", { method: "POST" });
  await pollLogin("claude", (payload) => payload.status === "awaiting_input");
  await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "wrong-code" }),
  });
  const rejected = await pollLogin(
    "claude",
    (payload) => payload.status === "awaiting_input" && payload.error,
  );
  assert.match(rejected.error, /did not accept the code/);

  const retried = await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "valid-oauth-code#state" }),
  });
  assert.equal(retried.status, 200);
  await pollLogin("claude", (payload) => payload.status === "succeeded");
});

test("claude login reports a hard rejection as failed with detail", async () => {
  await request("/v1/providers/claude/login", { method: "POST" });
  await pollLogin("claude", (payload) => payload.status === "awaiting_input");
  await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "wrong-code" }),
  });
  await pollLogin("claude", (payload) => payload.status === "awaiting_input" && payload.error);
  await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "wrong-again" }),
  });
  const failed = await pollLogin("claude", (payload) => payload.status === "failed");
  assert.match(failed.error, /Invalid authorization code/);
});

test("claude login times out a silently swallowed code and allows a retry", async () => {
  await request("/v1/providers/claude/login", { method: "POST" });
  await pollLogin("claude", (payload) => payload.status === "awaiting_input");
  await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "swallow-code" }),
  });
  const timedOut = await pollLogin(
    "claude",
    (payload) => payload.status === "awaiting_input" && payload.error,
  );
  assert.match(timedOut.error, /did not accept the code/);

  await request("/v1/providers/claude/login/input", {
    method: "POST",
    body: JSON.stringify({ code: "valid-oauth-code#state" }),
  });
  await pollLogin("claude", (payload) => payload.status === "succeeded");
});

test("an active login can be cancelled and then restarted", async () => {
  rmSync(join(stubDir, "codex-approved"), { force: true });
  await request("/v1/providers/codex/login", { method: "POST" });
  await pollLogin("codex", (payload) => payload.status === "awaiting_browser");

  const cancelled = await request("/v1/providers/codex/login", { method: "DELETE" });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, "cancelled");

  const restarted = await request("/v1/providers/codex/login", { method: "POST" });
  assert.equal(restarted.status, 200);
  await pollLogin("codex", (payload) => payload.status === "awaiting_browser");
  await request("/v1/providers/codex/login", { method: "DELETE" });
});
