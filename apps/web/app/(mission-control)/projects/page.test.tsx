import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminTokenProvider } from "@/features/auth/use-admin-token";

import ProjectsPage from "./page";

const project = {
  id: "project-1",
  name: "Storefront",
  status: "active",
  memory: "",
  test_command: "npm run test:unit",
  app_command: null,
};

describe("ProjectsPage runtime commands", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    sessionStorage.setItem("mission-control.admin-token", "local-token");
  });

  it("edits and saves per-project test and app commands", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/projects") && !init?.method) {
        return new Response(JSON.stringify([project]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/runtime/commands") && init?.method === "PUT") {
        return new Response(JSON.stringify({
          project_id: project.id,
          repository_id: null,
          configured_test_command: "npm run test:unit",
          configured_app_command: "npm start -- --port $PORT",
          detected_test_command: null,
          detected_app_command: null,
          effective_test_command: "npm run test:unit",
          effective_app_command: "npm start -- --port $PORT",
          test_run: null,
          app: null,
          gateway_error: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(<ProjectsPage />, { wrapper: AdminTokenProvider });

    const testCommand = await screen.findByLabelText("Test command");
    expect(testCommand).toHaveValue("npm run test:unit");
    fireEvent.change(screen.getByLabelText("App command"), {
      target: { value: "npm start -- --port $PORT" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save commands/i }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/runtime/commands"),
      );
      expect(request).toBeDefined();
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        test_command: "npm run test:unit",
        app_command: "npm start -- --port $PORT",
      });
    });
  });

  it("disables save buttons until a field has unsaved changes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/projects") && !init?.method) {
        return new Response(JSON.stringify([project]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(<ProjectsPage />, { wrapper: AdminTokenProvider });

    const saveMemory = await screen.findByRole("button", { name: /save memory/i });
    expect(saveMemory).toBeDisabled();
    expect(screen.getByRole("button", { name: /save name/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save commands/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Project memory"), {
      target: { value: "- Use PostgreSQL" },
    });
    expect(saveMemory).toBeEnabled();
  });

  it("disables create until a project name is entered", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<ProjectsPage />, { wrapper: AdminTokenProvider });

    const create = await screen.findByRole("button", { name: /create/i });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("project name"), {
      target: { value: "storefront" },
    });
    expect(create).toBeEnabled();
  });
});
