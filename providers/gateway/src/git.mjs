import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";

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

// Installed-dependency directories, any generated .env, and compiled
// frontend build output are conventionally gitignored, so neither a fresh
// `git worktree add` nor a merge-based integration ever carries them
// across worktree boundaries. Copying straight from the filesystem (only
// when the target's manifest exists and it has nothing there yet) keeps
// tests and previews runnable without re-running installs or asset builds
// inside runtime-gateway's network-isolated sandbox, where they can't
// reliably be redone from scratch.
const DEPENDENCY_DIRECTORIES = [
  { manifest: "composer.json", directory: "vendor" },
  { manifest: "package.json", directory: "node_modules" },
  { manifest: ".env.example", directory: ".env" },
  { manifest: "vite.config.js", directory: "public/build" },
  { manifest: "vite.config.ts", directory: "public/build" },
];

async function syncDependencyDirectories(sourceDir, targetDir) {
  for (const { manifest, directory } of DEPENDENCY_DIRECTORIES) {
    if (!existsSync(resolve(targetDir, manifest))) continue;
    const sourcePath = resolve(sourceDir, directory);
    const targetPath = resolve(targetDir, directory);
    if (!existsSync(sourcePath) || existsSync(targetPath)) continue;
    await cp(sourcePath, targetPath, { recursive: true });
  }
}

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

async function repositoryHead(workspace) {
  const head = await runGit(workspace, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw failure(head, "Unable to read the repository HEAD");
  return head.stdout.trim();
}

async function mergeBase(workspace, left, right) {
  const result = await runGit(workspace, ["merge-base", left, right]);
  if (result.code !== 0) throw failure(result, "Unable to read the worktree baseline");
  return result.stdout.trim();
}

async function assertClean(workspace) {
  const status = await runGit(workspace, ["status", "--porcelain"]);
  if (status.code !== 0) throw failure(status, "Unable to inspect the working tree");
  if (status.stdout.trim()) {
    throw new Error("The repository has uncommitted changes");
  }
}

function worktreeIdentity(runId, worktreeRoot) {
  if (
    typeof runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
  ) {
    throw new Error("Run ID is not a valid UUID");
  }
  return {
    branch: `mission-control/run-${runId.toLowerCase()}`,
    worktree: resolve(worktreeRoot, runId.toLowerCase()),
  };
}

function taskWorktreeIdentity(taskId, worktreeRoot) {
  if (
    typeof taskId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)
  ) {
    throw new Error("Task ID is not a valid UUID");
  }
  return {
    branch: `mission-control/task-${taskId.toLowerCase()}`,
    worktree: resolve(worktreeRoot, "tasks", taskId.toLowerCase()),
  };
}

async function createLinkedWorktree(sourceWorkspace, branch, worktree, root) {
  await assertRepositoryRoot(sourceWorkspace);
  await assertClean(sourceWorkspace);
  await mkdir(root, { recursive: true });

  if (existsSync(worktree)) {
    await assertRepositoryRoot(worktree);
    const currentBranch = await runGit(worktree, ["branch", "--show-current"]);
    if (currentBranch.code !== 0 || currentBranch.stdout.trim() !== branch) {
      throw new Error("Existing worktree belongs to a different branch");
    }
    return {
      worktree,
      branch,
      baselineSha: await mergeBase(sourceWorkspace, "HEAD", branch),
      recovered: true,
    };
  }

  const sourceHead = await repositoryHead(sourceWorkspace);
  const branchExists = await runGit(sourceWorkspace, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code !== 0 && branchExists.code !== 1) {
    throw failure(branchExists, "Unable to inspect the isolated branch");
  }
  const args =
    branchExists.code === 0
      ? ["worktree", "add", worktree, branch]
      : ["worktree", "add", "-b", branch, worktree, "HEAD"];
  const created = await runGit(sourceWorkspace, args);
  if (created.code !== 0) throw failure(created, "Unable to create the isolated worktree");
  await syncDependencyDirectories(sourceWorkspace, worktree);
  return {
    worktree,
    branch,
    baselineSha:
      branchExists.code === 0
        ? await mergeBase(sourceWorkspace, "HEAD", branch)
        : sourceHead,
    recovered: false,
  };
}

/**
 * Create or recover a run-scoped linked worktree from the source HEAD.
 * Repeated calls for the same run are idempotent.
 */
export async function gitCreateWorktree(sourceWorkspace, runId, worktreeRoot) {
  const { branch, worktree } = worktreeIdentity(runId, worktreeRoot);
  return createLinkedWorktree(sourceWorkspace, branch, worktree, resolve(worktreeRoot));
}

/** Create or recover a task worktree branching from the mission workspace. */
export async function gitCreateTaskWorktree(sourceWorkspace, taskId, worktreeRoot) {
  const { branch, worktree } = taskWorktreeIdentity(taskId, worktreeRoot);
  return createLinkedWorktree(
    sourceWorkspace,
    branch,
    worktree,
    resolve(worktreeRoot, "tasks"),
  );
}

/**
 * Fast-forward the source repository to a verified worktree branch.
 * Refuses integration when the source moved or either workspace is dirty.
 */
export async function gitIntegrateWorktree(
  sourceWorkspace,
  worktree,
  branch,
  baselineSha,
) {
  if (
    typeof branch !== "string" ||
    !/^mission-control\/run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      branch,
    )
  ) {
    throw new Error("Worktree branch is invalid");
  }
  if (typeof baselineSha !== "string" || !/^[0-9a-f]{40,64}$/.test(baselineSha)) {
    throw new Error("Baseline commit is invalid");
  }
  await assertRepositoryRoot(sourceWorkspace);
  await assertRepositoryRoot(worktree);
  await assertClean(sourceWorkspace);
  await assertClean(worktree);
  const sourceHead = await repositoryHead(sourceWorkspace);
  if (sourceHead !== baselineSha) {
    throw new Error(
      `Source repository moved from baseline ${baselineSha.slice(0, 12)} to ${sourceHead.slice(0, 12)}`,
    );
  }
  const currentBranch = await runGit(worktree, ["branch", "--show-current"]);
  if (currentBranch.code !== 0 || currentBranch.stdout.trim() !== branch) {
    throw new Error("Worktree is not on the expected mission branch");
  }
  const integrated = await runGit(sourceWorkspace, ["merge", "--ff-only", branch]);
  if (integrated.code !== 0) {
    throw failure(integrated, "Unable to fast-forward the source repository");
  }
  const integrationSha = await repositoryHead(sourceWorkspace);
  await syncDependencyDirectories(worktree, sourceWorkspace);

  const removed = await runGit(sourceWorkspace, ["worktree", "remove", "--force", worktree]);
  if (removed.code !== 0) {
    return {
      integrated: true,
      integrationSha,
      cleaned: false,
      cleanupError: removed.stderr.trim() || "Unable to remove the integrated worktree",
    };
  }
  const deleted = await runGit(sourceWorkspace, ["branch", "-d", branch]);
  return {
    integrated: true,
    integrationSha,
    cleaned: deleted.code === 0,
    cleanupError:
      deleted.code === 0
        ? null
        : deleted.stderr.trim() || "Unable to delete the integrated mission branch",
  };
}

/**
 * Merge an independently executed task branch into its mission worktree.
 * A merge commit makes retries idempotent and conflicts are aborted without
 * leaving partial changes in the mission workspace.
 */
export async function gitIntegrateTaskWorktree(
  sourceWorkspace,
  worktree,
  branch,
  baselineSha,
) {
  if (
    typeof branch !== "string" ||
    !/^mission-control\/task-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      branch,
    )
  ) {
    throw new Error("Task worktree branch is invalid");
  }
  if (typeof baselineSha !== "string" || !/^[0-9a-f]{40,64}$/.test(baselineSha)) {
    throw new Error("Task baseline commit is invalid");
  }
  await assertRepositoryRoot(sourceWorkspace);
  await assertRepositoryRoot(worktree);
  await assertClean(sourceWorkspace);
  await assertClean(worktree);
  const currentBranch = await runGit(worktree, ["branch", "--show-current"]);
  if (currentBranch.code !== 0 || currentBranch.stdout.trim() !== branch) {
    throw new Error("Worktree is not on the expected task branch");
  }
  const baselineIsAncestor = await runGit(worktree, [
    "merge-base",
    "--is-ancestor",
    baselineSha,
    branch,
  ]);
  if (baselineIsAncestor.code !== 0) {
    throw new Error("Task branch no longer descends from its recorded baseline");
  }

  const alreadyIntegrated = await runGit(sourceWorkspace, [
    "merge-base",
    "--is-ancestor",
    branch,
    "HEAD",
  ]);
  if (alreadyIntegrated.code !== 0 && alreadyIntegrated.code !== 1) {
    throw failure(alreadyIntegrated, "Unable to inspect task integration state");
  }
  if (alreadyIntegrated.code === 1) {
    const merged = await runGit(sourceWorkspace, [
      ...commitIdentity,
      "merge",
      "--no-ff",
      "--no-edit",
      branch,
    ]);
    if (merged.code !== 0) {
      const unmerged = await runGit(sourceWorkspace, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      await runGit(sourceWorkspace, ["merge", "--abort"]);
      const detail = merged.stderr.trim() || merged.stdout.trim();
      const error = new Error(
        `Task changes conflict with the mission workspace${detail ? `: ${detail}` : ""}`,
      );
      error.conflictFiles =
        unmerged.code === 0
          ? unmerged.stdout.split("\n").map((item) => item.trim()).filter(Boolean)
          : [];
      throw error;
    }
  }
  const integrationSha = await repositoryHead(sourceWorkspace);
  await syncDependencyDirectories(worktree, sourceWorkspace);
  const removed = await runGit(sourceWorkspace, ["worktree", "remove", "--force", worktree]);
  if (removed.code !== 0) {
    return {
      integrated: true,
      integrationSha,
      cleaned: false,
      cleanupError: removed.stderr.trim() || "Unable to remove the task worktree",
    };
  }
  const deleted = await runGit(sourceWorkspace, ["branch", "-d", branch]);
  return {
    integrated: true,
    integrationSha,
    cleaned: deleted.code === 0,
    cleanupError:
      deleted.code === 0
        ? null
        : deleted.stderr.trim() || "Unable to delete the integrated task branch",
  };
}

/** Return a read-only comparison for a preserved task integration conflict. */
export async function gitTaskWorktreeReport(
  sourceWorkspace,
  worktree,
  branch,
  baselineSha,
) {
  await assertRepositoryRoot(sourceWorkspace);
  await assertRepositoryRoot(worktree);
  if (
    typeof branch !== "string" ||
    !/^mission-control\/task-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      branch,
    )
  ) {
    throw new Error("Task worktree branch is invalid");
  }
  if (typeof baselineSha !== "string" || !/^[0-9a-f]{40,64}$/.test(baselineSha)) {
    throw new Error("Task baseline commit is invalid");
  }
  const branchHead = await repositoryHead(worktree);
  const sourceHead = await repositoryHead(sourceWorkspace);
  const taskChanges = await runGit(worktree, [
    "diff",
    "--name-status",
    `${baselineSha}..${branchHead}`,
  ]);
  if (taskChanges.code !== 0) {
    throw failure(taskChanges, "Unable to inspect task changes");
  }
  const missionChanges = await runGit(sourceWorkspace, [
    "diff",
    "--name-status",
    `${baselineSha}..${sourceHead}`,
  ]);
  if (missionChanges.code !== 0) {
    throw failure(missionChanges, "Unable to inspect mission changes");
  }
  const diff = await runGit(worktree, [
    "diff",
    "--no-ext-diff",
    "--unified=3",
    `${baselineSha}..${branchHead}`,
  ]);
  if (diff.code !== 0) throw failure(diff, "Unable to render the task patch");
  return {
    sourceHead,
    branchHead,
    taskChanges: taskChanges.stdout,
    missionChanges: missionChanges.stdout,
    diff: diff.stdout,
  };
}

/**
 * Prepare the preserved task worktree for assisted conflict resolution by
 * merging the current mission HEAD into the task branch without committing.
 * Repeated calls recover the same in-progress merge instead of starting over.
 */
export async function gitPrepareTaskResolution(
  sourceWorkspace,
  worktree,
  branch,
  baselineSha,
) {
  await assertRepositoryRoot(sourceWorkspace);
  await assertRepositoryRoot(worktree);
  if (
    typeof branch !== "string" ||
    !/^mission-control\/task-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      branch,
    )
  ) {
    throw new Error("Task worktree branch is invalid");
  }
  if (typeof baselineSha !== "string" || !/^[0-9a-f]{40,64}$/.test(baselineSha)) {
    throw new Error("Task baseline commit is invalid");
  }
  await assertClean(sourceWorkspace);
  const currentBranch = await runGit(worktree, ["branch", "--show-current"]);
  if (currentBranch.code !== 0 || currentBranch.stdout.trim() !== branch) {
    throw new Error("Worktree is not on the expected task branch");
  }
  const baselineIsAncestor = await runGit(worktree, [
    "merge-base",
    "--is-ancestor",
    baselineSha,
    branch,
  ]);
  if (baselineIsAncestor.code !== 0) {
    throw new Error("Task branch no longer descends from its recorded baseline");
  }

  const sourceHead = await repositoryHead(sourceWorkspace);
  const mergeHead = await runGit(worktree, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  if (mergeHead.code === 0) {
    if (mergeHead.stdout.trim() !== sourceHead) {
      throw new Error("Task worktree contains a merge for an outdated mission commit");
    }
    const unmerged = await runGit(worktree, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    if (unmerged.code !== 0) {
      throw failure(unmerged, "Unable to inspect the prepared conflict");
    }
    return {
      prepared: true,
      recovered: true,
      sourceHead,
      branchHead: await repositoryHead(worktree),
      conflictFiles: unmerged.stdout.split("\n").map((item) => item.trim()).filter(Boolean),
    };
  }
  if (mergeHead.code !== 1) {
    throw failure(mergeHead, "Unable to inspect the task merge state");
  }

  await assertClean(worktree);
  const branchHead = await repositoryHead(worktree);
  const merged = await runGit(worktree, [
    ...commitIdentity,
    "merge",
    "--no-commit",
    "--no-ff",
    sourceHead,
  ]);
  const unmerged = await runGit(worktree, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  if (unmerged.code !== 0) {
    await runGit(worktree, ["merge", "--abort"]);
    throw failure(unmerged, "Unable to inspect the prepared conflict");
  }
  const conflictFiles = unmerged.stdout.split("\n").map((item) => item.trim()).filter(Boolean);
  if (merged.code !== 0 && conflictFiles.length === 0) {
    await runGit(worktree, ["merge", "--abort"]);
    throw failure(merged, "Unable to prepare the task conflict for resolution");
  }
  return {
    prepared: true,
    recovered: false,
    sourceHead,
    branchHead,
    conflictFiles,
  };
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
