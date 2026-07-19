import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminTokenProvider } from "@/features/auth/use-admin-token";
import { catalogApi, type Approval, type Run } from "@/features/catalog/api";

import { GettingStarted } from "./getting-started";
import { CHECKLIST_STORAGE_KEY } from "./onboarding-state";

const approvedApproval = { status: "approved" } as Approval;
const completedRun = { status: "completed" } as Run;

function mockCatalog({
  authenticated = false,
  objectives = 0,
  approved = false,
  built = false,
} = {}) {
  vi.spyOn(catalogApi, "providers").mockResolvedValue({
    providers: { codex: { authenticated }, claude: { authenticated: false } },
  });
  vi.spyOn(catalogApi, "objectives").mockResolvedValue(
    Array.from({ length: objectives }, (_, index) => ({
      id: `objective-${index}`,
      project_id: "project-1",
      title: "Build the app",
      description: null,
      status: "planned",
    })),
  );
  vi.spyOn(catalogApi, "approvals").mockResolvedValue(
    approved ? [approvedApproval] : [],
  );
  vi.spyOn(catalogApi, "runs").mockResolvedValue(built ? [completedRun] : []);
}

describe("GettingStarted", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.setItem("mission-control.admin-token", "local-token");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows live setup progress with links for the remaining steps", async () => {
    mockCatalog({ authenticated: true, objectives: 1 });

    render(<GettingStarted />, { wrapper: AdminTokenProvider });

    expect(
      await screen.findByText("2 of 4 steps complete"),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect an AI provider")).toBeInTheDocument();
    expect(screen.getByText("Approve the generated plan")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review plan" })).toHaveAttribute(
      "href",
      "/missions",
    );
    expect(
      screen.queryByRole("link", { name: "Open Settings" }),
    ).not.toBeInTheDocument();
  });

  it("hides itself once every step is complete", async () => {
    mockCatalog({ authenticated: true, objectives: 2, approved: true, built: true });

    render(<GettingStarted />, { wrapper: AdminTokenProvider });

    await waitFor(() => expect(catalogApi.runs).toHaveBeenCalled());
    expect(
      screen.queryByRole("region", { name: "Getting started checklist" }),
    ).not.toBeInTheDocument();
  });

  it("stays dismissed across renders", async () => {
    mockCatalog();

    const first = render(<GettingStarted />, { wrapper: AdminTokenProvider });
    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss checklist" }),
    );
    expect(
      screen.queryByText("First mission checklist"),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(CHECKLIST_STORAGE_KEY)).toBe("dismissed");
    first.unmount();

    render(<GettingStarted />, { wrapper: AdminTokenProvider });
    await waitFor(() =>
      expect(
        screen.queryByText("First mission checklist"),
      ).not.toBeInTheDocument(),
    );
  });
});
