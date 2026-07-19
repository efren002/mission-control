import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.SANDBOX_SUPERVISOR_PORT ?? 8120);
const TOKEN = process.env.SANDBOX_SUPERVISOR_TOKEN ?? "";
const IMAGE = process.env.SANDBOX_IMAGE ?? "mission-control-provider-gateway:latest";
const RUNTIME_VOLUME = process.env.SANDBOX_RUNTIME_VOLUME ?? "mission-control_runtime_data";
const CODEX_VOLUME = process.env.SANDBOX_CODEX_VOLUME ?? "mission-control_codex_credentials";
const CLAUDE_VOLUME = process.env.SANDBOX_CLAUDE_VOLUME ?? "mission-control_claude_credentials";
const REPOSITORY_ROOT = process.env.SANDBOX_REPOSITORY_HOST_ROOT ?? "";
const ATTACHMENT_ROOT = process.env.SANDBOX_ATTACHMENT_HOST_ROOT ?? "";
const REPOSITORY_GID = process.env.SANDBOX_REPOSITORY_GID ?? "1000";
const MEMORY = process.env.SANDBOX_MEMORY ?? "2g";
const CPUS = process.env.SANDBOX_CPUS ?? "2";
const PIDS = process.env.SANDBOX_PIDS ?? "256";
const MAX_BODY_BYTES = 256 * 1024;
const activeSandboxes = new Map();

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeEvent(response, event, data) {
  if (!response.writableEnded) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
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

function safeSandboxId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(value)
  ) {
    throw new Error("Sandbox ID is invalid");
  }
  return value.toLowerCase();
}

function safeWorkspace(value) {
  if (
    typeof value !== "string" ||
    !/^\/workspaces(?:\/[a-zA-Z0-9._-]+)*$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("Sandbox workspace is invalid");
  }
  return value;
}

export function safeExecution(body) {
  const kind = body.kind;
  if (!["provider", "command"].includes(kind)) {
    throw new Error("Sandbox execution kind is invalid");
  }
  const sandboxId = safeSandboxId(body.sandboxId);
  const workspace = safeWorkspace(body.workspace);
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 1_800_000), 1_000), 1_800_000);
  if (!Number.isFinite(timeoutMs)) throw new Error("Sandbox timeout is invalid");
  if (kind === "provider") {
    if (!["codex", "claude"].includes(body.provider)) {
      throw new Error("Sandbox provider is invalid");
    }
    if (!Array.isArray(body.args) || !body.args.every((item) => typeof item === "string")) {
      throw new Error("Sandbox provider arguments are invalid");
    }
    if (body.args.join("").length > 150_000) {
      throw new Error("Sandbox provider arguments exceed the size limit");
    }
    return {
      kind,
      sandboxId,
      workspace,
      timeoutMs,
      command: body.provider,
      args: body.args,
      credentials: true,
    };
  }
  if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 2_000) {
    throw new Error("Sandbox command is invalid");
  }
  return {
    kind,
    sandboxId,
    workspace,
    timeoutMs,
    command: "sh",
    args: ["-c", body.command],
    credentials: false,
  };
}

function mountArgs(execution) {
  const args = [
    "--mount",
    `type=volume,source=${RUNTIME_VOLUME},target=/workspaces`,
  ];
  if (REPOSITORY_ROOT) {
    args.push(
      "--mount",
      `type=bind,source=${REPOSITORY_ROOT},target=/workspaces/repositories`,
    );
  }
  if (execution.credentials && ATTACHMENT_ROOT) {
    args.push(
      "--mount",
      `type=bind,source=${ATTACHMENT_ROOT},target=/workspaces/attachments,readonly`,
    );
  }
  if (execution.credentials) {
    args.push(
      "--mount",
      `type=volume,source=${CODEX_VOLUME},target=/home/runner/.codex`,
      "--mount",
      `type=volume,source=${CLAUDE_VOLUME},target=/home/runner/.claude`,
    );
  }
  return args;
}

export function sandboxDockerArgs(execution, containerName) {
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--label",
    "mission-control.sandbox=true",
    "--label",
    `mission-control.sandbox-id=${execution.sandboxId}`,
    "--label",
    `mission-control.kind=${execution.kind}`,
    "--init",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    PIDS,
    "--memory",
    MEMORY,
    "--cpus",
    CPUS,
    "--network",
    execution.credentials ? "bridge" : "none",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=512m,uid=10001,gid=10001,mode=1777",
    "--tmpfs",
    "/home/runner:rw,nosuid,size=256m,uid=10001,gid=10001,mode=0700",
    "--user",
    "10001:10001",
    "--group-add",
    REPOSITORY_GID,
    "--workdir",
    execution.workspace,
    "--env",
    "HOME=/home/runner",
    "--env",
    "CODEX_HOME=/home/runner/.codex",
    "--env",
    "CLAUDE_CONFIG_DIR=/home/runner/.claude",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "TERM=dumb",
    "--env",
    "CI=1",
    "--env",
    "DISABLE_AUTOUPDATER=1",
    "--env",
    "GIT_CONFIG_COUNT=1",
    "--env",
    "GIT_CONFIG_KEY_0=safe.directory",
    "--env",
    "GIT_CONFIG_VALUE_0=*",
    ...mountArgs(execution),
    IMAGE,
    execution.command,
    ...execution.args,
  ];
}

function removeContainer(name) {
  const cleanup = spawn("docker", ["rm", "--force", name], {
    stdio: "ignore",
  });
  cleanup.unref();
}

async function runSandbox(request, response, body) {
  const execution = safeExecution(body);
  const shortId = execution.sandboxId.slice(0, 32).replace(/-+$/, "");
  const containerName = `mc-sandbox-${shortId}-${randomUUID().slice(0, 8)}`;
  const args = sandboxDockerArgs(execution, containerName);
  const startedAt = Date.now();
  const child = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const entry = {
    containerName,
    sandboxId: execution.sandboxId,
    kind: execution.kind,
    workspace: execution.workspace,
    startedAt: new Date(startedAt).toISOString(),
  };
  activeSandboxes.set(containerName, entry);
  let finished = false;
  let timedOut = false;
  let forceTimer;
  const stop = (timeout = false) => {
    if (finished) return;
    timedOut = timedOut || timeout;
    child.kill("SIGTERM");
    removeContainer(containerName);
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    forceTimer.unref();
  };
  const timeout = setTimeout(() => stop(true), execution.timeoutMs);
  timeout.unref();
  request.once("aborted", () => stop());
  response.once("close", () => {
    if (!response.writableEnded) stop();
  });

  writeEvent(response, "started", entry);
  child.stdout.on("data", (chunk) =>
    writeEvent(response, "stdout", { data: chunk.toString("utf8") }),
  );
  child.stderr.on("data", (chunk) =>
    writeEvent(response, "stderr", { data: chunk.toString("utf8") }),
  );
  await new Promise((resolveRun) => {
    child.on("error", (error) => {
      writeEvent(response, "stderr", { data: error.message });
      resolveRun({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolveRun({ code, signal }));
  }).then(({ code, signal }) => {
    finished = true;
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    activeSandboxes.delete(containerName);
    writeEvent(response, "completed", {
      exitCode: code,
      signal,
      timedOut,
      durationMs: Date.now() - startedAt,
      sandboxId: execution.sandboxId,
      containerName,
      disposed: true,
    });
  });
}

export function createSandboxSupervisor() {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
          encoding: "utf8",
          timeout: 5_000,
        });
        return json(response, docker.status === 0 ? 200 : 503, {
          status: docker.status === 0 ? "operational" : "unavailable",
          dockerVersion: docker.stdout?.trim() || null,
          activeSandboxes: activeSandboxes.size,
          limits: { memory: MEMORY, cpus: CPUS, pids: Number(PIDS) },
        });
      }
      if (!TOKEN || request.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(response, 401, { detail: "Invalid sandbox supervisor credentials" });
      }
      if (request.method === "GET" && request.url === "/v1/sandboxes") {
        return json(response, 200, { sandboxes: [...activeSandboxes.values()] });
      }
      if (request.method === "POST" && request.url === "/v1/sandboxes/run") {
        const body = await requestBody(request);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
        });
        await runSandbox(request, response, body);
        response.end();
        return;
      }
      return json(response, 404, { detail: "Not found" });
    } catch (error) {
      if (!response.headersSent) {
        return json(response, 400, {
          detail: error instanceof Error ? error.message : "Sandbox request failed",
        });
      }
      writeEvent(response, "error", {
        detail: error instanceof Error ? error.message : "Sandbox request failed",
      });
      response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSandboxSupervisor().listen(PORT, "0.0.0.0", () => {
    console.log(`sandbox-supervisor listening on ${PORT}`);
  });
}
