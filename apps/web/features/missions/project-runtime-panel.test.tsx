import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRuntimePanel } from "./project-runtime-panel";

const runtime = {
  project_id: "project-1",
  repository_id: "repository-1",
  configured_test_command: null,
  configured_app_command: null,
  detected_test_command: "npm test",
  detected_app_command: "npm run dev -- --host 0.0.0.0 --port $PORT",
  effective_test_command: "npm test",
  effective_app_command: "npm run dev -- --host 0.0.0.0 --port $PORT",
  test_run: null,
  app: null,
  gateway_error: null,
};

describe("ProjectRuntimePanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads detected commands and queues project tests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          id: "command-1",
          project_id: "project-1",
          repository_id: "repository-1",
          kind: "test",
          command: "npm test",
          status: "queued",
          exit_code: null,
          output_excerpt: null,
          error: null,
          started_at: null,
          finished_at: null,
          created_at: "2026-07-18T00:00:00Z",
          updated_at: "2026-07-18T00:00:00Z",
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(runtime), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <ProjectRuntimePanel
        projectId="project-1"
        repositoryId="repository-1"
        token="local-token"
      />,
    );

    expect(await screen.findByText("Tests: npm test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /run tests/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "/projects/project-1/runtime/tests?repository_id=repository-1",
        ),
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
