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
      task_count: 1,
      approval_status: null,
      created_at: old,
      updated_at: old,
      tasks: [
        {
          id: "task-1",
          title: "Review",
          description: null,
          status: "in_progress",
          agent_role: "reviewer",
          assigned_agent_id: "agent-1",
          checkpoint_sha: null,
        },
      ],
      events: [],
      approvals: [],
      invocations: [
        {
          id: "invocation-1",
          agent_id: "agent-1",
          agent_name: "Reviewer",
          purpose: "task_execution",
          status: "running",
          duration_ms: null,
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
});
