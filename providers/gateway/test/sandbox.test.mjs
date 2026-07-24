import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SANDBOX_REPOSITORY_HOST_ROOT ??= "/tmp";

const {
  safeExecution,
  sandboxDockerArgs,
} = await import("../src/sandbox-supervisor.mjs");

test("provider sandboxes have fixed limits, mounts, and network access", () => {
  const execution = safeExecution({
    kind: "provider",
    sandboxId: "run-4198f342-7b3d-4a21-8c11-63c7b229d880",
    workspace: "/workspaces/worktrees/run",
    provider: "codex",
    accessMode: "read-only",
    args: ["exec", "--json", "fix the task"],
    timeoutMs: 60_000,
  });

  const args = sandboxDockerArgs(execution, "mc-sandbox-test");

  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--name", "mc-sandbox-test"]);
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("--cpus"));
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
  assert.ok(args.some((item) => item.includes("mission-control_runtime_data")));
  assert.ok(args.some((item) =>
    item.includes("target=/workspaces,readonly"),
  ));
  assert.ok(args.some((item) => item.includes("mission-control_codex_credentials")));
  assert.ok(args.some((item) => item.includes("mission-control_claude_credentials")));
  assert.ok(args.some((item) =>
    item.includes("target=/workspaces/repositories,readonly"),
  ));
  assert.equal(args.includes("/var/run/docker.sock"), false);
});

test("write-mode provider sandboxes mount repositories read-write", () => {
  const execution = safeExecution({
    kind: "provider",
    sandboxId: "run-write",
    workspace: "/workspaces/worktrees/run",
    provider: "codex",
    accessMode: "workspace-write",
    args: ["exec", "--json", "fix the task"],
  });

  const args = sandboxDockerArgs(execution, "mc-sandbox-write");
  const repositoryMount = args.find((item) =>
    item.includes("target=/workspaces/repositories"),
  );
  const workspaceMount = args.find((item) =>
    item.includes("target=/workspaces") &&
    !item.includes("target=/workspaces/repositories"),
  );

  assert.ok(repositoryMount);
  assert.equal(repositoryMount.endsWith(",readonly"), false);
  assert.ok(workspaceMount);
  assert.equal(workspaceMount.endsWith(",readonly"), false);
});

test("runtime command sandboxes are credential-free and offline", () => {
  const execution = safeExecution({
    kind: "command",
    sandboxId: "command-4198f342",
    workspace: "/workspaces/repositories/demo",
    command: "npm test",
  });
  const args = sandboxDockerArgs(execution, "mc-sandbox-command");

  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args.some((item) => item.includes("codex_credentials")), false);
  assert.equal(args.some((item) => item.includes("claude_credentials")), false);
  assert.deepEqual(args.slice(-3), ["sh", "-c", "npm test"]);
});

test("sandbox requests reject arbitrary workspaces, providers, and identifiers", () => {
  assert.throws(
    () =>
      safeExecution({
        kind: "command",
        sandboxId: "safe",
        workspace: "/etc",
        command: "id",
      }),
    /workspace is invalid/,
  );
  assert.throws(
    () =>
      safeExecution({
        kind: "provider",
        sandboxId: "../../escape",
        workspace: "/workspaces/demo",
        provider: "bash",
        accessMode: "read-only",
        args: [],
      }),
    /Sandbox ID is invalid/,
  );
});
