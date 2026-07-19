import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogApi, type Objective, type RunDetail } from "@/features/catalog/api";
import { AdminTokenProvider } from "@/features/auth/use-admin-token";

import { MissionBoard, MissionDetail } from "./mission-board";

describe("MissionBoard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => sessionStorage.clear());

  it("locks the board until an admin session exists", () => {
    render(<MissionBoard />, { wrapper: AdminTokenProvider });

    expect(screen.getByText("Missions")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("What do you want to build?"),
    ).not.toBeInTheDocument();
  });

  it("offers the guided new mission form once unlocked", async () => {
    sessionStorage.setItem("mission-control.admin-token", "local-token");

    render(<MissionBoard />, { wrapper: AdminTokenProvider });

    expect(
      await screen.findByPlaceholderText("What do you want to build?"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start mission/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start mission/i })).toBeDisabled();
  });

  it("requeues a stale execution from the mission panel", async () => {
    const old = "2026-07-18T10:00:00Z";
    const objective: Objective = {
      id: "objective-1",
      project_id: "project-1",
      title: "Recover build",
      description: null,
      status: "executing",
    };
    const detail: RunDetail = {
      id: "run-1",
      objective_id: objective.id,
      project_id: objective.project_id,
      objective_title: objective.title,
      repository_id: "repository-1",
      status: "executing",
      current_step: "Review",
      worktree_branch: "mission-control/run-run-1",
      worktree_status: "active",
      baseline_sha: null,
      integration_sha: null,
      task_count: 1,
      approval_status: null,
      created_at: old,
      updated_at: old,
      tasks: [
        {
          id: "task-1",
          position: 1,
          depends_on_positions: [],
          title: "Review",
          description: null,
          status: "in_progress",
          agent_role: "reviewer",
          assigned_agent_id: "agent-1",
          checkpoint_sha: null,
          worktree_branch: "mission-control/task-task-1",
          worktree_status: "active",
          integration_sha: null,
          conflict_files: [],
          conflict_detail: null,
          conflict_detected_at: null,
        },
      ],
      events: [],
      approvals: [],
      verification_criteria: [],
      verification_evidence: [],
      invocations: [
        {
          id: "invocation-1",
          agent_id: "agent-1",
          agent_name: "Reviewer",
          purpose: "task_execution",
          status: "running",
          provider: "codex",
          model: null,
          attempt: 1,
          fallback_from_provider: null,
          routing_reason: "agent_preference",
          duration_ms: null,
          input_tokens: null,
          cached_input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          input_excerpt: null,
          output_excerpt: "reviewing",
          error: null,
          created_at: old,
          updated_at: old,
        },
      ],
    };
    const reload = vi.fn(async () => undefined);
    const resume = vi
      .spyOn(catalogApi, "resumeExecution")
      .mockResolvedValue({
        id: detail.id,
        status: "queued_for_execution",
        current_step: "execution_resuming",
        recovered_tasks: 1,
      });

    render(
      <MissionDetail
        objective={objective}
        detail={detail}
        repositories={[]}
        projectName="Recovery project"
        token="local-token"
        busy={false}
        onPlan={() => undefined}
        onDelete={() => undefined}
        reload={reload}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /resume build/i }));

    await waitFor(() => expect(resume).toHaveBeenCalledWith("local-token", detail.id));
    expect(reload).toHaveBeenCalled();
  });

  it("shows criterion evidence for a verified mission", () => {
    const objective: Objective = {
      id: "objective-verified",
      project_id: "project-1",
      title: "Verified build",
      description: "Ship a tested endpoint.",
      status: "completed",
    };
    const now = "2026-07-19T12:00:00Z";
    const detail: RunDetail = {
      id: "run-verified",
      objective_id: objective.id,
      project_id: objective.project_id,
      objective_title: objective.title,
      repository_id: null,
      status: "completed",
      current_step: "verified",
      worktree_branch: null,
      worktree_status: null,
      baseline_sha: null,
      integration_sha: null,
      task_count: 0,
      approval_status: "approved",
      created_at: now,
      updated_at: now,
      tasks: [],
      events: [],
      approvals: [],
      invocations: [],
      verification_criteria: [
        {
          id: "criterion-1",
          position: 1,
          description: "Valid input returns a successful response.",
          status: "passed",
          evidence: "tests/test_endpoint.py passed.",
          verifier_agent_id: "reviewer-1",
          verified_at: now,
        },
      ],
      verification_evidence: [
        {
          id: "evidence-1",
          kind: "test",
          status: "passed",
          command: "npm test",
          exit_code: 0,
          output_excerpt: "1 test passed",
          error: null,
          started_at: now,
          finished_at: now,
        },
      ],
    };

    render(
      <MissionDetail
        objective={objective}
        detail={detail}
        repositories={[]}
        projectName="Verified project"
        token="local-token"
        busy={false}
        onPlan={() => undefined}
        onDelete={() => undefined}
        reload={async () => undefined}
      />,
    );

    expect(screen.getByText("Acceptance evidence")).toBeInTheDocument();
    expect(screen.getByText("1/1 verified")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText(/passed · exit 0/i)).toBeInTheDocument();
    expect(screen.getByText(/tests\/test_endpoint\.py passed/)).toBeInTheDocument();
  });

  it("queues a selected agent to resolve a preserved task conflict", async () => {
    const now = "2026-07-20T01:00:00Z";
    const objective: Objective = {
      id: "objective-conflict",
      project_id: "project-1",
      title: "Resolve merge",
      description: null,
      status: "failed",
    };
    const detail: RunDetail = {
      id: "run-conflict",
      objective_id: objective.id,
      project_id: objective.project_id,
      objective_title: objective.title,
      repository_id: "repository-1",
      status: "failed",
      current_step: "task_integration_failed",
      worktree_branch: "mission-control/run-conflict",
      worktree_status: "preserved",
      baseline_sha: "a".repeat(40),
      integration_sha: null,
      task_count: 1,
      approval_status: "pending",
      created_at: now,
      updated_at: now,
      tasks: [{
        id: "task-conflict",
        position: 1,
        depends_on_positions: [],
        title: "Conflicting task",
        description: null,
        status: "failed",
        agent_role: "developer",
        assigned_agent_id: "agent-developer",
        checkpoint_sha: "b".repeat(40),
        worktree_branch: "mission-control/task-conflict",
        worktree_status: "preserved",
        integration_sha: null,
        conflict_files: ["shared.ts"],
        conflict_detail: "merge conflict",
        conflict_detected_at: now,
      }],
      events: [],
      invocations: [],
      approvals: [{
        id: "approval-conflict",
        task_id: "task-conflict",
        kind: "task_integration",
        status: "pending",
        decision_reason: null,
        decided_at: null,
        created_at: now,
      }],
      verification_criteria: [],
      verification_evidence: [],
    };
    vi.spyOn(catalogApi, "taskConflict").mockResolvedValue({
      task_id: "task-conflict",
      branch: "mission-control/task-conflict",
      workspace: "/workspaces/task-conflict",
      source_head: "c".repeat(40),
      branch_head: "b".repeat(40),
      conflict_files: ["shared.ts"],
      task_changes: "M\tshared.ts",
      mission_changes: "M\tshared.ts",
      diff: "diff --git a/shared.ts b/shared.ts",
      truncated: false,
      latest_resolution: null,
    });
    vi.spyOn(catalogApi, "agents").mockResolvedValue([{
      id: "agent-reviewer",
      name: "Review Agent",
      role: "reviewer",
      provider: "codex",
      model: null,
      instructions: "",
      enabled: true,
      status: "online",
      provider_version: null,
      capabilities: [],
      assignment_count: 0,
      invocation_count: 0,
    }]);
    const resolve = vi.spyOn(catalogApi, "resolveTaskConflict").mockResolvedValue({
      id: "resolution-1",
      task_id: "task-conflict",
      run_id: "run-conflict",
      agent_id: "agent-reviewer",
      agent_name: "Review Agent",
      invocation_id: null,
      status: "queued",
      instructions: "",
      source_head: null,
      branch_before_sha: null,
      resolution_sha: null,
      conflict_files: ["shared.ts"],
      test_command: null,
      test_status: "pending",
      test_exit_code: null,
      test_output_excerpt: null,
      error: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
    });

    render(
      <MissionDetail
        objective={objective}
        detail={detail}
        repositories={[]}
        projectName="Conflict project"
        token="local-token"
        busy={false}
        onPlan={() => undefined}
        onDelete={() => undefined}
        reload={async () => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /inspect conflict/i }));
    expect(await screen.findByText("Assisted resolution")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /run assisted resolution/i }));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        "local-token",
        "task-conflict",
        "agent-reviewer",
        "",
      ),
    );
    expect(await screen.findByText(/Review Agent/)).toBeInTheDocument();
  });
});
