import { resolve } from "node:path";
import { spawn } from "node:child_process";

const GIT_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_CHARS = 500;

const gitEnvironment = {
  PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/runner",
  LANG: "C.UTF-8",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
};

const commitIdentity = [
  "-c",
  "user.name=Mission Control",
  "-c",
  "user.email=agents@mission-control.local",
];

function runGit(workspace, args) {
  return new Promise((resolveRun) => {
    const child = spawn("git", ["-C", workspace, ...args], {
      cwd: workspace,
      env: gitEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(0, 100_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(0, 100_000);
    });
    child.on("error", (error) => resolveRun({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    setTimeout(() => child.kill("SIGTERM"), GIT_TIMEOUT_MS).unref();
  });
}

function failure(result, fallback) {
  return new Error(result.stderr.trim() || result.stdout.trim() || fallback);
}

async function assertRepositoryRoot(workspace) {
  const topLevel = await runGit(workspace, ["rev-parse", "--show-toplevel"]);
  if (topLevel.code !== 0 || resolve(topLevel.stdout.trim()) !== resolve(workspace)) {
    throw new Error("Workspace is not the root of a Git repository");
  }
}

/**
 * Stage every change in the workspace and record it as a checkpoint commit.
 * The workspace must already be validated against the gateway workspace root
 * and must be the top level of a Git repository. Returns the commit SHA, or
 * null when the working tree had nothing to commit.
 */
export async function gitCheckpoint(workspace, message) {
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
    throw new Error("Commit message must be a non-empty string within the size limit");
  }
  await assertRepositoryRoot(workspace);
  const add = await runGit(workspace, ["add", "--all"]);
  if (add.code !== 0) throw failure(add, "Unable to stage workspace changes");
  const staged = await runGit(workspace, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return { committed: false, commitSha: null };
  if (staged.code !== 1) throw failure(staged, "Unable to inspect staged changes");
  const commit = await runGit(workspace, [
    ...commitIdentity,
    "commit",
    "-m",
    message.trim(),
  ]);
  if (commit.code !== 0) throw failure(commit, "Unable to create the checkpoint commit");
  const head = await runGit(workspace, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw failure(head, "Unable to read the checkpoint commit");
  return { committed: true, commitSha: head.stdout.trim() };
}

/**
 * Revert one checkpoint commit with a new revert commit. The workspace must
 * already be validated against the gateway workspace root. Requires a clean
 * working tree; a conflicting revert is aborted and reported as an error.
 */
export async function gitRevert(workspace, commitSha) {
  if (typeof commitSha !== "string" || !/^[0-9a-f]{7,64}$/.test(commitSha)) {
    throw new Error("Commit reference is not a valid SHA");
  }
  await assertRepositoryRoot(workspace);
  const status = await runGit(workspace, ["status", "--porcelain"]);
  if (status.code !== 0) throw failure(status, "Unable to inspect the working tree");
  if (status.stdout.trim()) {
    throw new Error("The repository has uncommitted changes; commit or discard them first");
  }
  const revert = await runGit(workspace, [
    ...commitIdentity,
    "revert",
    "--no-edit",
    commitSha,
  ]);
  if (revert.code !== 0) {
    await runGit(workspace, ["revert", "--abort"]);
    throw failure(revert, "Unable to revert the checkpoint commit");
  }
  const head = await runGit(workspace, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw failure(head, "Unable to read the revert commit");
  return { reverted: true, revertSha: head.stdout.trim() };
}
