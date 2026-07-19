import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminTokenProvider } from "@/features/auth/use-admin-token";

import AgentsPage from "./page";

const agent = {
  id: "agent-1",
  name: "Implementation Agent",
  role: "developer",
  provider: "codex",
  model: null,
  instructions: "Implement scoped changes and run tests.",
  enabled: true,
  status: "online",
  provider_version: "codex-cli 0.144.5",
  capabilities: ["repository_editing", "streaming_events"],
  assignment_count: 3,
  invocation_count: 8,
};

const invocation = {
  id: "invocation-1",
  agent_id: agent.id,
  run_id: null,
  task_id: null,
  purpose: "connectivity_test",
  status: "completed",
  duration_ms: 240,
  input_excerpt: "Confirm availability.",
  output_excerpt: "Implementation Agent is available.",
  error: null,
  created_at: "2026-07-19T00:00:00Z",
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AgentsPage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("scrollTo", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("creates an enabled agent with the configured profile", async () => {
    sessionStorage.setItem(
      "mission-control.admin-token",
      "agents-create-token",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/agents") && init?.method === "POST") {
          return jsonResponse(
            { ...agent, name: "QA Specialist", role: "qa" },
            201,
          );
        }
        if (url.endsWith("/agents") && !init?.method)
          return jsonResponse([agent]);
        return jsonResponse({ detail: "Not found" }, 404);
      });

    render(<AgentsPage />, { wrapper: AdminTokenProvider });

    const name = await screen.findByLabelText("Display name");
    fireEvent.change(name, { target: { value: "QA Specialist" } });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "qa" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create agent/i }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith("/agents") && init?.method === "POST",
      );
      expect(request).toBeDefined();
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
        name: "QA Specialist",
        role: "qa",
        provider: "codex",
        enabled: true,
      });
    });
    expect(
      await screen.findByText("Agent added to the roster."),
    ).toBeInTheDocument();
  });

  it("loads an agent into the editor and saves profile changes", async () => {
    sessionStorage.setItem("mission-control.admin-token", "agents-edit-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith(`/agents/${agent.id}`) && init?.method === "PUT") {
          return jsonResponse({
            ...agent,
            name: "Senior Implementation Agent",
          });
        }
        if (url.endsWith("/agents") && !init?.method)
          return jsonResponse([agent]);
        return jsonResponse({ detail: "Not found" }, 404);
      });

    render(<AgentsPage />, { wrapper: AdminTokenProvider });

    fireEvent.click(await screen.findByRole("button", { name: "Edit agent" }));
    const name = screen.getByLabelText("Display name");
    expect(name).toHaveValue(agent.name);
    expect(screen.getByText("Editing")).toBeInTheDocument();

    fireEvent.change(name, {
      target: { value: "Senior Implementation Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith(`/agents/${agent.id}`) && init?.method === "PUT",
      );
      expect(request).toBeDefined();
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
        name: "Senior Implementation Agent",
        instructions: agent.instructions,
      });
    });
  });

  it("tests an agent and opens its retained invocation history", async () => {
    sessionStorage.setItem("mission-control.admin-token", "agents-test-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (
          url.endsWith(`/agents/${agent.id}/test`) &&
          init?.method === "POST"
        ) {
          return jsonResponse(invocation);
        }
        if (url.endsWith(`/agents/${agent.id}/invocations`)) {
          return jsonResponse([invocation]);
        }
        if (url.endsWith("/agents") && !init?.method)
          return jsonResponse([agent]);
        return jsonResponse({ detail: "Not found" }, 404);
      });

    render(<AgentsPage />, { wrapper: AdminTokenProvider });

    fireEvent.click(await screen.findByRole("button", { name: "Test agent" }));

    expect(
      await screen.findByText("Implementation Agent responded successfully."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Invocation log")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Provider output"));
    expect(
      screen.getByText("Implementation Agent is available."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/agents/${agent.id}/test`),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
