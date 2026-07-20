import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import {
  gitCheckpoint,
  gitCreateTaskWorktree,
  gitCreateWorktree,
  gitIntegrateTaskWorktree,
  gitIntegrateWorktree,
  gitPrepareTaskResolution,
  gitRevert,
  gitTaskWorktreeReport,
} from "./git.mjs";
import {
  cancelLogin,
  getLogin,
  setLoginSuccessHandler,
  shutdownLogins,
  startLogin,
  submitLoginInput,
} from "./login.mjs";
import {
  initialProviderUsage,
  parseProviderUsage,
  recordProviderUsage,
} from "./usage.mjs";
import { buildRegistry, httpProviderStatus, HTTP_KIND_NAME } from "./registry.mjs";
import { probeHttpModels, streamHttpCompletion } from "./http_provider.mjs";
import { mutateProvider } from "./provider_store.mjs";
import { decryptKey, isKeyConfigured } from "./crypto.mjs";

const PORT = Number(process.env.PROVIDER_GATEWAY_PORT ?? 8100);
const TOKEN = process.env.PROVIDER_GATEWAY_TOKEN ?? "";
const WORKSPACE_ROOT = resolve(process.env.PROVIDER_GATEWAY_WORKSPACE_ROOT ?? "/workspaces");
const WORKTREE_ROOT = resolve(process.env.PROVIDER_GATEWAY_WORKTREE_ROOT ?? join(WORKSPACE_ROOT, "worktrees"));
if (
  WORKTREE_ROOT === WORKSPACE_ROOT ||
  relative(WORKSPACE_ROOT, WORKTREE_ROOT).startsWith(`..${sep}`)
) {
  throw new Error("Provider worktree root must be inside the workspace root");
}
const RUNTIME_ONLY = process.env.PROVIDER_GATEWAY_RUNTIME_ONLY === "true";
const SANDBOX_SUPERVISOR_URL = (process.env.SANDBOX_SUPERVISOR_URL ?? "").replace(/\/$/, "");
const SANDBOX_SUPERVISOR_TOKEN = process.env.SANDBOX_SUPERVISOR_TOKEN ?? "";
const SANDBOX_REQUIRED = process.env.SANDBOX_REQUIRED === "true";
const MAX_BODY_BYTES = 128 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 2_000_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RECENT_USAGE = 10;
const MAX_COMMAND_CHARS = 2_000;
const MAX_APP_LOG_CHARS = 20_000;
const APP_PORT_RANGE = parsePortRange(process.env.PROVIDER_GATEWAY_APP_PORT_RANGE ?? "8201-8210");
// CLI version/auth probes spawn subprocesses and take seconds; auth state changes
// rarely, so status requests share one probe per provider within this window.
const PROVIDER_STATUS_TTL_MS = Number(process.env.PROVIDER_GATEWAY_STATUS_TTL_MS ?? 30_000);
const providerProbeCache = new Map();
const appProcesses = new Map();
const authenticationFailures = new Map();
const providerUsage = new Map([
  ["codex", initialProviderUsage()],
  ["claude", initialProviderUsage()],
]);
const recentProviderUsage = new Map([
  ["codex", []],
  ["claude", []],
]);

// New files in group-writable repository directories remain editable by the host owner.
process.umask(0o002);

// CLI probe/auth metadata for the built-in providers. HTTP providers are
// declared in providers.json and never reach this table.
const providerCommands = {
  codex: {
    command: "codex",
    versionArgs: ["--version"],
    authArgs: ["login", "status"],
    capabilities: ["structured_output", "streaming_events", "repository_editing", "sandbox_control"],
  },
  claude: {
    command: "claude",
    versionArgs: ["--version"],
    authArgs: ["auth", "status", "--text"],
    capabilities: ["structured_output", "streaming_events", "repository_editing", "sandbox_control"],
  },
};

// HTTP providers come from providers.json; a malformed file fails fast at boot
// so the gateway refuses to start rather than silently dropping a provider.
// `registry` is rebuilt in place whenever the custom-provider file is mutated
// through the /v1/providers/custom routes, so callers always see a consistent
// snapshot.
const CUSTOM_PROVIDERS_PATH = process.env.CUSTOM_PROVIDERS_PATH || null;
// Master key for provider API keys encrypted at rest. Required when custom
// providers are enabled; the gateway refuses to start otherwise so a missing
// key can never silently downgrade encrypted entries to undecryptable.
const MASTER_KEY = process.env.PROVIDERS_ENCRYPTION_KEY ?? "";
if (CUSTOM_PROVIDERS_PATH && !isKeyConfigured(MASTER_KEY)) {
  throw new Error("PROVIDERS_ENCRYPTION_KEY must be set when CUSTOM_PROVIDERS_PATH is configured");
}
let registry = buildRegistry({ customProvidersPath: CUSTOM_PROVIDERS_PATH });
syncUsageMaps(registry);

function reloadRegistry() {
  registry = buildRegistry({ customProvidersPath: CUSTOM_PROVIDERS_PATH });
  syncUsageMaps(registry);
}

// Seed/drop usage tracking to match the HTTP providers currently in the
// registry. Existing counters are preserved across a reload so editing one
// provider does not reset another's stats.
function syncUsageMaps(next) {
  const httpNames = new Set();
  for (const [name, entry] of next) {
    if (entry.kind !== HTTP_KIND_NAME) continue;
    httpNames.add(name);
    if (!providerUsage.has(name)) providerUsage.set(name, initialProviderUsage());
    if (!recentProviderUsage.has(name)) recentProviderUsage.set(name, []);
  }
  for (const name of [...providerUsage.keys()]) {
    if (!httpNames.has(name) && !providerCommands[name]) {
      providerUsage.delete(name);
      recentProviderUsage.delete(name);
    }
  }
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function authorized(request) {
  if (!TOKEN) return false;
  return request.headers.authorization === `Bearer ${TOKEN}`;
}

function safeWorkspace(candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) return null;
  const workspace = resolve(candidate);
  const outsideRoot = relative(WORKSPACE_ROOT, workspace).startsWith(`..${sep}`);
  if (outsideRoot || workspace === resolve("/")) return null;
  return workspace;
}

function environmentFor(provider) {
  return {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/runner",
    CODEX_HOME: "/home/runner/.codex",
    // Keeps claude's config file inside the persisted credentials volume so it
    // survives container recreation instead of living in the writable layer.
    CLAUDE_CONFIG_DIR: "/home/runner/.claude",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    PROVIDER: provider,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
}

function loginEnvironment(provider) {
  // Unlike execution probes, login must look interactive: no CI flag and no
  // dumb terminal, so the CLIs run their device-auth and paste-code flows.
  return {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/runner",
    CODEX_HOME: "/home/runner/.codex",
    CLAUDE_CONFIG_DIR: "/home/runner/.claude",
    LANG: "C.UTF-8",
    DISABLE_AUTOUPDATER: "1",
    PROVIDER: provider,
  };
}

setLoginSuccessHandler((provider) => {
  // Force the next status request to re-probe so the dashboard sees the new
  // authentication immediately instead of after the status cache TTL.
  providerProbeCache.delete(provider);
  authenticationFailures.delete(provider);
});

function parsePortRange(raw) {
  const match = /^(\d+)-(\d+)$/.exec(String(raw).trim());
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match ? Number(match[2]) : Number.NaN;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65_535 || end < start) {
    return { start: 8201, end: 8210 };
  }
  return { start, end };
}

async function createRuntimeHome(kind) {
  const home = await mkdtemp(join(tmpdir(), `mission-control-${kind}-`));
  const temporaryDirectory = join(home, "tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  return { home, temporaryDirectory };
}

async function cleanupRuntimeHome(home) {
  try {
    await rm(home, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Unable to remove temporary runtime home ${home}:`, error);
  }
}

function commandEnvironment(port, runtimeHome = "/home/runner", temporaryDirectory = "/tmp") {
  return {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: runtimeHome,
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: join(runtimeHome, ".cache"),
    NPM_CONFIG_CACHE: join(runtimeHome, ".npm"),
    COMPOSER_HOME: join(runtimeHome, ".composer"),
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    ...(port === null ? {} : { PORT: String(port) }),
  };
}

function requireCommand(body) {
  const command = body.command;
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    command.length > MAX_COMMAND_CHARS
  ) {
    throw new Error("Command must be a non-empty string within the size limit");
  }
  return command;
}

function commandFor(provider, workspace, prompt, model, accessMode) {
  if (provider === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        ...(model ? ["--model", model] : []),
        "--cd",
        workspace,
        ...(accessMode === "workspace-write"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--sandbox", "read-only"]),
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        prompt,
      ],
    };
  }

  return {
    command: "claude",
    args: [
      "-p",
      ...(model ? ["--model", model] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      accessMode === "workspace-write" ? "acceptEdits" : "plan",
      "--no-session-persistence",
      // Write-mode executions (implementation/QA) need room for many tool
      // calls; the request timeout is the real bound. Read-only planning
      // stays capped since it produces a single plan.
      "--max-turns",
      accessMode === "workspace-write" ? "100" : "25",
      prompt,
    ],
  };
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object") throw new Error("Request body must be an object");
  return body;
}

async function resolveSafeWorkspace(candidate) {
  const workspace = safeWorkspace(candidate);
  if (!workspace || !existsSync(workspace)) throw new Error("Workspace is not allowed or does not exist");
  const canonicalRoot = await realpath(WORKSPACE_ROOT);
  const canonicalWorkspace = await realpath(workspace);
  const outsideRoot = relative(canonicalRoot, canonicalWorkspace).startsWith(`..${sep}`);
  if (outsideRoot) throw new Error("Workspace resolves outside the configured workspace root");
  return canonicalWorkspace;
}

function writeEvent(response, event, data) {
  if (response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function sandboxHealth() {
  if (!SANDBOX_SUPERVISOR_URL) {
    return {
      status: SANDBOX_REQUIRED ? "unavailable" : "disabled",
      required: SANDBOX_REQUIRED,
    };
  }
  try {
    const response = await fetch(`${SANDBOX_SUPERVISOR_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    const payload = await response.json();
    return {
      status: response.ok ? "operational" : "unavailable",
      required: SANDBOX_REQUIRED,
      ...(payload && typeof payload === "object" ? payload : {}),
    };
  } catch (error) {
    return {
      status: "unavailable",
      required: SANDBOX_REQUIRED,
      detail: error instanceof Error ? error.message : "Sandbox supervisor unavailable",
    };
  }
}

async function sandboxInventory() {
  if (!SANDBOX_SUPERVISOR_URL) {
    return {
      status: SANDBOX_REQUIRED ? "unavailable" : "disabled",
      required: SANDBOX_REQUIRED,
      activeSandboxes: [],
    };
  }
  const headers = {
    authorization: `Bearer ${SANDBOX_SUPERVISOR_TOKEN}`,
  };
  const [healthResponse, listResponse] = await Promise.all([
    fetch(`${SANDBOX_SUPERVISOR_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    }),
    fetch(`${SANDBOX_SUPERVISOR_URL}/v1/sandboxes`, {
      headers,
      signal: AbortSignal.timeout(3_000),
    }),
  ]);
  if (!healthResponse.ok || !listResponse.ok) {
    throw new Error("Sandbox supervisor is unavailable");
  }
  const health = await healthResponse.json();
  const listed = await listResponse.json();
  return {
    ...health,
    status: "operational",
    required: SANDBOX_REQUIRED,
    executionIsolation: "disposable-container",
    activeSandboxes: Array.isArray(listed.sandboxes) ? listed.sandboxes : [],
  };
}

function sandboxIdentity(value) {
  if (typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/i.test(value)) {
    return value.toLowerCase();
  }
  return `request-${randomUUID()}`;
}

async function relaySandbox(request, response, body, onEvent) {
  if (!SANDBOX_SUPERVISOR_URL) {
    throw new Error("Sandbox supervisor is not configured");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  try {
    const sandboxResponse = await fetch(
      `${SANDBOX_SUPERVISOR_URL}/v1/sandboxes/run`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SANDBOX_SUPERVISOR_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!sandboxResponse.ok || !sandboxResponse.body) {
      const payload = await sandboxResponse.json().catch(() => null);
      throw new Error(payload?.detail ?? `Sandbox supervisor returned ${sandboxResponse.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = null;
    for await (const chunk of sandboxResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:") || !eventName) continue;
        const payload = JSON.parse(line.slice(5).trim());
        await onEvent(eventName, payload);
        eventName = null;
      }
    }
  } finally {
    request.off("aborted", abort);
    response.off("close", abort);
  }
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The process group already exited.
  }
}

function superviseStreamingProcess(request, response, child, timeoutMs) {
  let finished = false;
  let cancelled = false;
  let timedOut = false;
  let forceKillTimer;

  const terminate = (reason) => {
    if (finished || cancelled) return;
    cancelled = true;
    timedOut = reason === "timeout";
    killProcessGroup(child, "SIGTERM");
    forceKillTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2_000);
    forceKillTimer.unref();
  };
  const onAborted = () => terminate("disconnect");
  const onResponseClose = () => {
    if (!response.writableEnded) terminate("disconnect");
  };
  request.once("aborted", onAborted);
  response.once("close", onResponseClose);
  const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
  timeoutTimer.unref();

  return {
    finish() {
      finished = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      request.off("aborted", onAborted);
      response.off("close", onResponseClose);
    },
    get cancelled() {
      return cancelled;
    },
    get timedOut() {
      return timedOut;
    },
  };
}

function runVersion(provider) {
  return new Promise((resolveVersion) => {
    const config = providerCommands[provider];
    const child = spawn(config.command, config.versionArgs, {
      cwd: WORKSPACE_ROOT,
      env: environmentFor(provider),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(0, 2_000);
    });
    child.on("error", (error) => resolveVersion({ available: false, error: error.message }));
    child.on("close", (code) =>
      resolveVersion({ available: code === 0, version: output.trim(), exitCode: code }),
    );
    setTimeout(() => child.kill("SIGTERM"), 5_000).unref();
  });
}

function runAuthentication(provider) {
  return new Promise((resolveAuthentication) => {
    const config = providerCommands[provider];
    const child = spawn(config.command, config.authArgs, {
      cwd: WORKSPACE_ROOT,
      env: environmentFor(provider),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      output = `${output}${chunk}`.slice(-2_000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) =>
      resolveAuthentication({ authenticated: false, authError: error.message }),
    );
    child.on("close", (code) =>
      resolveAuthentication({
        authenticated: code === 0,
        authDetail: output.trim(),
        authExitCode: code,
      }),
    );
    setTimeout(() => child.kill("SIGTERM"), 5_000).unref();
  });
}

function runCodexRateLimits() {
  return new Promise((resolveRateLimits) => {
    const child = spawn("codex", ["app-server"], {
      cwd: WORKSPACE_ROOT,
      env: environmentFor("codex"),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(), 5_000);
    timer.unref();
    const finish = (rateLimits = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolveRateLimits(rateLimits);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("error", () => finish());
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.id === 0 && message.result) {
            send({ method: "initialized", params: {} });
            send({ method: "account/rateLimits/read", id: 1, params: {} });
          } else if (message.id === 1) {
            finish(message.result ?? null);
          }
        } catch {
          // Ignore non-protocol output and let the request timeout safely.
        }
      }
    });
    child.on("error", () => finish());
    child.on("close", () => finish());
    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "mission_control",
          title: "Mission Control",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function probeProvider(provider) {
  const version = await runVersion(provider);
  const authentication = version.available
    ? await runAuthentication(provider)
    : { authenticated: false };
  const rateLimits =
    provider === "codex" && version.available && authentication.authenticated
      ? await runCodexRateLimits()
      : null;
  return { version, authentication, rateLimits };
}

function cachedProbe(provider) {
  const entry = providerProbeCache.get(provider);
  if (entry && Date.now() - entry.startedAt < PROVIDER_STATUS_TTL_MS) return entry.promise;
  const fresh = { startedAt: Date.now(), promise: probeProvider(provider) };
  fresh.promise.catch(() => providerProbeCache.delete(provider));
  providerProbeCache.set(provider, fresh);
  return fresh.promise;
}

async function providerStatus() {
  const names = Object.keys(providerCommands);
  const probes = await Promise.all(names.map((provider) => cachedProbe(provider)));
  const providers = {};
  names.forEach((provider, index) => {
    const { version, authentication, rateLimits } = probes[index];
    const runtimeAuthError = authenticationFailures.get(provider);
    providers[provider] = {
      ...providerCommands[provider],
      kind: "cli",
      ...version,
      installed: version.available,
      ...authentication,
      ...(runtimeAuthError
        ? { authenticated: false, authDetail: runtimeAuthError }
        : {}),
      usage: {
        ...providerUsage.get(provider),
        recentRequests: recentProviderUsage.get(provider),
      },
      ...(rateLimits ?? {}),
      available:
        version.available &&
        authentication.authenticated &&
        !runtimeAuthError,
    };
  });
  for (const [name, entry] of registry) {
    if (entry.kind !== HTTP_KIND_NAME) continue;
    const status = httpProviderStatus(entry, MASTER_KEY);
    providers[name] = {
      ...status,
      usage: {
        ...providerUsage.get(name),
        recentRequests: recentProviderUsage.get(name),
      },
    };
  }
  return providers;
}

async function runHttpProvider({ entry, provider, response, prompt, model, timeoutMs, usageLabel }) {
  const apiKey = decryptKey(entry.encrypted_api_key, MASTER_KEY);
  const startedAt = Date.now();
  writeEvent(response, "started", {
    provider,
    workspace: null,
    command: null,
    startedAt: new Date(startedAt).toISOString(),
  });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let parsedUsage = null;
  let timedOut = false;
  let exitCode = 0;
  try {
    const result = await streamHttpCompletion({
      entry,
      apiKey,
      model,
      prompt,
      timeoutMs,
      onStdout: (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk);
        writeEvent(response, "stdout", { data: chunk });
      },
      onStderr: (chunk) => {
        stderrBytes += Buffer.byteLength(chunk);
        writeEvent(response, "stderr", { data: chunk });
      },
    });
    parsedUsage = result.parsedUsage;
    exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "HTTP provider failed";
    timedOut = /timed out|abort/i.test(message);
    exitCode = 1;
    writeEvent(response, "stderr", { data: message });
  }
  providerUsage.set(
    provider,
    recordProviderUsage(providerUsage.get(provider), parsedUsage),
  );
  recentProviderUsage.set(
    provider,
    [
      {
        label: usageLabel?.trim() || "Unlabelled request",
        model: model || entry.model || null,
        promptChars: prompt.length,
        inputTokens: parsedUsage?.inputTokens ?? 0,
        cachedInputTokens: parsedUsage?.cachedInputTokens ?? 0,
        outputTokens: parsedUsage?.outputTokens ?? 0,
        totalTokens: parsedUsage?.totalTokens ?? 0,
        durationMs: Date.now() - startedAt,
        succeeded: exitCode === 0,
        completedAt: new Date().toISOString(),
      },
      ...(recentProviderUsage.get(provider) ?? []),
    ].slice(0, MAX_RECENT_USAGE),
  );
  if (exitCode === 0) authenticationFailures.delete(provider);
  writeEvent(response, "completed", {
    provider,
    exitCode,
    signal: null,
    timedOut,
    cancelled: false,
    durationMs: Date.now() - startedAt,
    stdoutBytes,
    stderrBytes,
    usage: parsedUsage,
  });
}

async function execute(request, response, body) {
  const provider = body.provider;
  const prompt = body.prompt;
  if (!registry.has(provider)) throw new Error("Unsupported provider");
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
    throw new Error("Prompt must be a non-empty string within the size limit");
  }
  const model = body.model;
  if (model !== null && model !== undefined && (typeof model !== "string" || model.length > 120)) {
    throw new Error("Model must be a string within the size limit");
  }
  const usageLabel = body.usageLabel;
  if (
    usageLabel !== null &&
    usageLabel !== undefined &&
    (typeof usageLabel !== "string" || usageLabel.length > 160)
  ) {
    throw new Error("Usage label must be a string within the size limit");
  }
  const accessMode = body.accessMode ?? "read-only";
  if (!["read-only", "workspace-write"].includes(accessMode)) {
    throw new Error("Unsupported access mode");
  }
  const timeoutMs = Math.min(
    Math.max(Number(body.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1_000),
    DEFAULT_TIMEOUT_MS,
  );

  // HTTP providers run in-process: no filesystem, no sandbox supervisor,
  // no checkpoint. accessMode is ignored — they only produce text.
  const entry = registry.get(provider);
  if (entry.kind === HTTP_KIND_NAME) {
    return runHttpProvider({
      entry,
      provider,
      response,
      prompt,
      model: model || null,
      timeoutMs,
      usageLabel,
    });
  }

  const workspace = await resolveSafeWorkspace(body.workspace);
  const { command, args } = commandFor(provider, workspace, prompt, model || null, accessMode);
  if (SANDBOX_SUPERVISOR_URL) {
    let stdout = "";
    let stderr = "";
    const startedAt = Date.now();
    await relaySandbox(
      request,
      response,
      {
        kind: "provider",
        provider,
        args,
        workspace,
        timeoutMs,
        sandboxId: sandboxIdentity(body.sandboxId),
      },
      async (event, payload) => {
        if (event === "stdout" && typeof payload?.data === "string") {
          stdout = `${stdout}${payload.data}`.slice(-MAX_OUTPUT_CHARS);
        } else if (event === "stderr" && typeof payload?.data === "string") {
          stderr = `${stderr}${payload.data}`.slice(-MAX_OUTPUT_CHARS);
        }
        if (event === "completed") {
          const parsedUsage = parseProviderUsage(provider, stdout);
          providerUsage.set(
            provider,
            recordProviderUsage(providerUsage.get(provider), parsedUsage),
          );
          recentProviderUsage.set(
            provider,
            [
              {
                label: usageLabel?.trim() || "Unlabelled request",
                model: model || null,
                promptChars: prompt.length,
                inputTokens: parsedUsage?.inputTokens ?? 0,
                cachedInputTokens: parsedUsage?.cachedInputTokens ?? 0,
                outputTokens: parsedUsage?.outputTokens ?? 0,
                totalTokens: parsedUsage?.totalTokens ?? 0,
                durationMs: payload.durationMs ?? Date.now() - startedAt,
                succeeded: payload.exitCode === 0,
                completedAt: new Date().toISOString(),
              },
              ...(recentProviderUsage.get(provider) ?? []),
            ].slice(0, MAX_RECENT_USAGE),
          );
          if (payload.exitCode === 0) {
            authenticationFailures.delete(provider);
          } else if (/401 Unauthorized|not logged in|authentication/i.test(stderr)) {
            authenticationFailures.set(
              provider,
              stderr.trim().slice(-2_000) || "Provider authentication failed",
            );
          }
          writeEvent(response, event, { ...payload, provider, usage: parsedUsage });
          return;
        }
        writeEvent(response, event, {
          ...payload,
          ...(event === "started" ? { provider, workspace, command } : {}),
        });
      },
    );
    return;
  }
  if (SANDBOX_REQUIRED) {
    throw new Error("Disposable sandbox execution is required but unavailable");
  }
  const child = spawn(command, args, {
    cwd: workspace,
    env: environmentFor(provider),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  const startedAt = Date.now();
  const supervisor = superviseStreamingProcess(request, response, child, timeoutMs);

  writeEvent(response, "started", { provider, workspace, command, startedAt: new Date(startedAt).toISOString() });
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_CHARS);
    writeEvent(response, "stdout", { data: chunk.toString("utf8") });
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_CHARS);
    writeEvent(response, "stderr", { data: chunk.toString("utf8") });
  });

  await new Promise((resolveProcess) => {
    child.on("error", (error) => {
      stderr = `${stderr}${error.message}`;
      supervisor.finish();
      resolveProcess();
    });
    child.on("close", (code, signal) => {
      supervisor.finish();
      const parsedUsage = parseProviderUsage(provider, stdout);
      providerUsage.set(
        provider,
        recordProviderUsage(providerUsage.get(provider), parsedUsage),
      );
      const completedAt = new Date();
      recentProviderUsage.set(
        provider,
        [
          {
            label: usageLabel?.trim() || "Unlabelled request",
            model: model || null,
            promptChars: prompt.length,
            inputTokens: parsedUsage?.inputTokens ?? 0,
            cachedInputTokens: parsedUsage?.cachedInputTokens ?? 0,
            outputTokens: parsedUsage?.outputTokens ?? 0,
            totalTokens: parsedUsage?.totalTokens ?? 0,
            durationMs: Date.now() - startedAt,
            succeeded: code === 0,
            completedAt: completedAt.toISOString(),
          },
          ...(recentProviderUsage.get(provider) ?? []),
        ].slice(0, MAX_RECENT_USAGE),
      );
      if (code === 0) {
        authenticationFailures.delete(provider);
      } else if (/401 Unauthorized|not logged in|authentication/i.test(stderr)) {
        authenticationFailures.set(
          provider,
          stderr.trim().slice(-2_000) || "Provider authentication failed",
        );
      }
      writeEvent(response, "completed", {
        provider,
        exitCode: code,
        signal,
        timedOut: supervisor.timedOut,
        cancelled: supervisor.cancelled && !supervisor.timedOut,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        usage: parsedUsage,
      });
      resolveProcess();
    });
  });
}

async function runSandboxCommand(request, response, body, workspace, command, timeoutMs) {
  await relaySandbox(
    request,
    response,
    {
      kind: "command",
      command,
      workspace,
      timeoutMs,
      sandboxId: sandboxIdentity(body.sandboxId),
    },
    async (event, payload) => writeEvent(response, event, payload),
  );
}

async function runShellCommand(
  request,
  response,
  { command, workspace, timeoutMs: requestedTimeoutMs, sandboxId },
) {
  const timeoutMs = Math.min(Math.max(Number(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS), 1_000), DEFAULT_TIMEOUT_MS);
  if (SANDBOX_SUPERVISOR_URL) {
    await runSandboxCommand(
      request,
      response,
      { sandboxId },
      workspace,
      command,
      timeoutMs,
    );
    return;
  }
  if (SANDBOX_REQUIRED) {
    throw new Error("Disposable sandbox execution is required but unavailable");
  }
  const runtime = await createRuntimeHome("command");
  const child = spawn("sh", ["-c", command], {
    cwd: workspace,
    env: commandEnvironment(null, runtime.home, runtime.temporaryDirectory),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  const startedAt = Date.now();
  const supervisor = superviseStreamingProcess(request, response, child, timeoutMs);

  writeEvent(response, "started", { workspace, command, startedAt: new Date(startedAt).toISOString() });
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_CHARS);
    writeEvent(response, "stdout", { data: chunk.toString("utf8") });
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_CHARS);
    writeEvent(response, "stderr", { data: chunk.toString("utf8") });
  });

  await new Promise((resolveProcess) => {
    child.on("error", (error) => {
      supervisor.finish();
      stderr = `${stderr}${error.message}`;
      writeEvent(response, "stderr", { data: error.message });
      writeEvent(response, "completed", {
        exitCode: null,
        signal: null,
        timedOut: supervisor.timedOut,
        cancelled: supervisor.cancelled && !supervisor.timedOut,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      });
      resolveProcess();
    });
    child.on("close", (code, signal) => {
      supervisor.finish();
      writeEvent(response, "completed", {
        exitCode: code,
        signal,
        timedOut: supervisor.timedOut,
        cancelled: supervisor.cancelled && !supervisor.timedOut,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      });
      resolveProcess();
    });
  });
  await cleanupRuntimeHome(runtime.home);
}

function appPayload(workspace, entry) {
  return {
    workspace,
    status: entry.status,
    port: entry.port,
    command: entry.command,
    startedAt: entry.startedAt,
    exitCode: entry.exitCode,
    logTail: entry.logTail.slice(-4_000),
  };
}

function allocateAppPort() {
  const used = new Set(
    [...appProcesses.values()].filter((entry) => entry.status === "running").map((entry) => entry.port),
  );
  for (let port = APP_PORT_RANGE.start; port <= APP_PORT_RANGE.end; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

function killAppGroup(entry, signal) {
  if (!entry.pid) return;
  try {
    process.kill(-entry.pid, signal);
  } catch {
    // The process group already exited.
  }
}

function appAlive(entry) {
  return entry.child.exitCode === null && entry.child.signalCode === null;
}

async function startApp(body) {
  const command = requireCommand(body);
  const workspace = await resolveSafeWorkspace(body.workspace);
  const existing = appProcesses.get(workspace);
  if (existing && existing.status === "running") {
    return { statusCode: 409, payload: { detail: "An app is already running for this workspace" } };
  }
  const port = allocateAppPort();
  if (port === null) {
    return { statusCode: 409, payload: { detail: "No free app ports are available" } };
  }
  const finalCommand = command
    .replaceAll("${PORT}", String(port))
    .replaceAll("$PORT", String(port));
  const runtime = await createRuntimeHome("app");
  // detached makes sh a process-group leader so Stop can kill its children too.
  const child = spawn("sh", ["-c", finalCommand], {
    cwd: workspace,
    env: commandEnvironment(port, runtime.home, runtime.temporaryDirectory),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const entry = {
    pid: child.pid ?? null,
    child,
    port,
    command: finalCommand,
    startedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    logTail: "",
    runtimeHome: runtime.home,
  };
  const append = (chunk) => {
    entry.logTail = `${entry.logTail}${chunk}`.slice(-MAX_APP_LOG_CHARS);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    append(error.message);
    if (entry.status === "running") entry.status = "exited";
  });
  child.on("close", (code) => {
    if (entry.status === "running") entry.status = "exited";
    entry.exitCode = code;
    void cleanupRuntimeHome(entry.runtimeHome);
  });
  appProcesses.set(workspace, entry);
  return { statusCode: 200, payload: appPayload(workspace, entry) };
}

async function stopApp(body) {
  const workspace = await resolveSafeWorkspace(body.workspace);
  const entry = appProcesses.get(workspace);
  if (!entry) {
    return { statusCode: 404, payload: { detail: "No app has been started for this workspace" } };
  }
  if (entry.status === "running") {
    entry.status = "stopped";
    killAppGroup(entry, "SIGTERM");
    setTimeout(() => {
      if (appAlive(entry)) killAppGroup(entry, "SIGKILL");
    }, 2_000).unref();
  }
  return { statusCode: 200, payload: appPayload(workspace, entry) };
}

function listApps() {
  return [...appProcesses.entries()].map(([workspace, entry]) => appPayload(workspace, entry));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const sandbox = await sandboxHealth();
      const sandboxUnavailable = SANDBOX_REQUIRED && sandbox.status !== "operational";
      return json(response, sandboxUnavailable ? 503 : 200, {
        status: sandboxUnavailable ? "unavailable" : "operational",
        service: RUNTIME_ONLY ? "runtime-gateway" : "provider-gateway",
        mode: RUNTIME_ONLY ? "runtime-only" : "provider",
        executionIsolation: sandbox.status === "operational" ? "disposable-container" : "process",
        sandbox,
      });
    }
    if (!authorized(request)) return json(response, 401, { detail: "Invalid gateway credentials" });
    if (
      RUNTIME_ONLY &&
      request.url !== "/v1/commands/stream" &&
      request.url !== "/v1/apps" &&
      request.url !== "/v1/apps/start" &&
      request.url !== "/v1/apps/stop"
    ) {
      return json(response, 403, { detail: "Endpoint is disabled in runtime-only mode" });
    }
    if (request.method === "GET" && request.url === "/v1/providers") {
      return json(response, 200, { providers: await providerStatus() });
    }
    if (request.method === "GET" && request.url === "/v1/sandboxes") {
      return json(response, 200, await sandboxInventory());
    }
    const loginRoute = /^\/v1\/providers\/(codex|claude)\/login(\/input)?$/.exec(request.url ?? "");
    if (loginRoute) {
      const provider = loginRoute[1];
      if (loginRoute[2] && request.method === "POST") {
        const body = await requestBody(request);
        const result = submitLoginInput(provider, body.code);
        return json(response, result.statusCode, result.payload);
      }
      if (!loginRoute[2] && request.method === "POST") {
        const result = startLogin(provider, loginEnvironment(provider));
        return json(response, result.statusCode, result.payload);
      }
      if (!loginRoute[2] && request.method === "GET") {
        const result = getLogin(provider);
        return json(response, result.statusCode, result.payload);
      }
      if (!loginRoute[2] && request.method === "DELETE") {
        const result = cancelLogin(provider);
        return json(response, result.statusCode, result.payload);
      }
      return json(response, 404, { detail: "Not found" });
    }
    if (request.method === "POST" && request.url === "/v1/providers/custom") {
      if (!CUSTOM_PROVIDERS_PATH) {
        return json(response, 503, { detail: "Custom providers are not configured on this gateway" });
      }
      const body = await requestBody(request);
      await mutateProvider({ path: CUSTOM_PROVIDERS_PATH, op: "create", input: body, masterKey: MASTER_KEY });
      reloadRegistry();
      return json(response, 200, { providers: await providerStatus() });
    }
    const modelsRoute = /^\/v1\/providers\/custom\/([^/]+)\/models$/.exec(request.url ?? "");
    if (modelsRoute && request.method === "GET") {
      if (!CUSTOM_PROVIDERS_PATH) {
        return json(response, 503, { detail: "Custom providers are not configured on this gateway" });
      }
      const name = decodeURIComponent(modelsRoute[1]);
      const entry = registry.get(name);
      if (!entry || entry.kind !== HTTP_KIND_NAME) {
        return json(response, 404, { detail: `Provider "${name}" is not an HTTP provider` });
      }
      let apiKey;
      try {
        apiKey = decryptKey(entry.encrypted_api_key, MASTER_KEY);
      } catch (error) {
        return json(response, 200, { ok: false, error: error.message });
      }
      const probe = await probeHttpModels({ entry, apiKey });
      return json(response, 200, probe);
    }
    const customRoute = /^\/v1\/providers\/custom\/([^/]+)$/.exec(request.url ?? "");
    if (customRoute) {
      if (!CUSTOM_PROVIDERS_PATH) {
        return json(response, 503, { detail: "Custom providers are not configured on this gateway" });
      }
      const name = decodeURIComponent(customRoute[1]);
      if (request.method === "PUT") {
        const body = await requestBody(request);
        await mutateProvider({ path: CUSTOM_PROVIDERS_PATH, op: "update", name, input: body, masterKey: MASTER_KEY });
        reloadRegistry();
        return json(response, 200, { providers: await providerStatus() });
      }
      if (request.method === "DELETE") {
        await mutateProvider({ path: CUSTOM_PROVIDERS_PATH, op: "delete", name });
        reloadRegistry();
        return json(response, 200, { providers: await providerStatus() });
      }
      return json(response, 404, { detail: "Not found" });
    }
    if (request.method === "POST" && request.url === "/v1/git/checkpoint") {
      const body = await requestBody(request);
      const workspace = await resolveSafeWorkspace(body.workspace);
      return json(response, 200, await gitCheckpoint(workspace, body.message));
    }
    if (request.method === "POST" && request.url === "/v1/git/revert") {
      const body = await requestBody(request);
      const workspace = await resolveSafeWorkspace(body.workspace);
      return json(response, 200, await gitRevert(workspace, body.commitSha));
    }
    if (request.method === "POST" && request.url === "/v1/git/worktrees") {
      const body = await requestBody(request);
      const sourceWorkspace = await resolveSafeWorkspace(body.sourceWorkspace);
      return json(
        response,
        200,
        await gitCreateWorktree(sourceWorkspace, body.runId, WORKTREE_ROOT),
      );
    }
    if (request.method === "POST" && request.url === "/v1/git/worktrees/integrate") {
      const body = await requestBody(request);
      const sourceWorkspace = await resolveSafeWorkspace(body.sourceWorkspace);
      const worktree = await resolveSafeWorkspace(body.worktree);
      return json(
        response,
        200,
        await gitIntegrateWorktree(
          sourceWorkspace,
          worktree,
          body.branch,
          body.baselineSha,
        ),
      );
    }
    if (request.method === "POST" && request.url === "/v1/git/task-worktrees") {
      const body = await requestBody(request);
      const sourceWorkspace = await resolveSafeWorkspace(body.sourceWorkspace);
      return json(
        response,
        200,
        await gitCreateTaskWorktree(sourceWorkspace, body.taskId, WORKTREE_ROOT),
      );
    }
    if (request.method === "POST" && request.url === "/v1/git/task-worktrees/integrate") {
      const body = await requestBody(request);
      const sourceWorkspace = await resolveSafeWorkspace(body.sourceWorkspace);
      const worktree = await resolveSafeWorkspace(body.worktree);
      return json(
        response,
        200,
        await gitIntegrateTaskWorktree(
          sourceWorkspace,
          worktree,
          body.branch,
          body.baselineSha,
        ),
      );
    }
    if (request.method === "POST" && request.url === "/v1/git/task-worktrees/report") {
      const body = await requestBody(request);
      const sourceWorkspace = await resolveSafeWorkspace(body.sourceWorkspace);
      const worktree = await resolveSafeWorkspace(body.worktree);
      return json(
        response,
        200,
        await gitTaskWorktreeReport(
          sourceWorkspace,
          worktree,
          body.branch,
          body.baselineSha,
        ),
      );
    }
    if (request.method === "POST" && request.url === "/v1/git/task-worktrees/resolve") {
      const body = await requestBody(request);
      const sourceWorkspace = await resolveSafeWorkspace(body.sourceWorkspace);
      const worktree = await resolveSafeWorkspace(body.worktree);
      return json(
        response,
        200,
        await gitPrepareTaskResolution(
          sourceWorkspace,
          worktree,
          body.branch,
          body.baselineSha,
        ),
      );
    }
    if (request.method === "POST" && ["/v1/execute", "/v1/execute/stream"].includes(request.url)) {
      const body = await requestBody(request);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      });
      await execute(request, response, body);
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/commands/stream") {
      const body = await requestBody(request);
      const command = requireCommand(body);
      const workspace = await resolveSafeWorkspace(body.workspace);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      });
      await runShellCommand(request, response, {
        command,
        workspace,
        timeoutMs: body.timeoutMs,
        sandboxId: body.sandboxId,
      });
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/apps/start") {
      const body = await requestBody(request);
      const result = await startApp(body);
      return json(response, result.statusCode, result.payload);
    }
    if (request.method === "POST" && request.url === "/v1/apps/stop") {
      const body = await requestBody(request);
      const result = await stopApp(body);
      return json(response, result.statusCode, result.payload);
    }
    if (request.method === "GET" && request.url === "/v1/apps") {
      return json(response, 200, { apps: listApps() });
    }
    return json(response, 404, { detail: "Not found" });
  } catch (error) {
    if (!response.headersSent) return json(response, 400, {
      detail: error instanceof Error ? error.message : "Request failed",
      ...(Array.isArray(error?.conflictFiles) ? { conflictFiles: error.conflictFiles } : {}),
    });
    writeEvent(response, "error", { detail: error instanceof Error ? error.message : "Request failed" });
    response.end();
  }
});

server.headersTimeout = 10_000;
server.requestTimeout = DEFAULT_TIMEOUT_MS + 10_000;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    for (const entry of appProcesses.values()) {
      if (appAlive(entry)) killAppGroup(entry, "SIGKILL");
    }
    shutdownLogins();
    process.exit(0);
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`provider-gateway listening on ${PORT}`);
});
