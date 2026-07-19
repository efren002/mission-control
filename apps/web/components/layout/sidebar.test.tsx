import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminTokenProvider } from "@/features/auth/use-admin-token";

import { MobileNavigation, Sidebar } from "./sidebar";

const usePathname = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => usePathname(),
}));

describe("Sidebar", () => {
  afterEach(cleanup);

  beforeEach(() => {
    usePathname.mockReturnValue("/objectives");
  });

  it("orders navigation from missions through advanced workflow views", () => {
    render(<Sidebar />);

    expect(
      screen.getAllByRole("link").map((link) => link.textContent?.trim()),
    ).toEqual([
      "Dashboard",
      "Missions",
      "Operations",
      "Projects",
      "Repositories",
      "Agents",
      "Settings",
      "Objectives",
      "Runs",
      "Approvals",
      "Tasks",
    ]);
  });

  it("marks the current page as active", () => {
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: "Objectives" })).toHaveClass(
      "border-l-signal",
    );
  });

  it("opens and closes the mobile navigation drawer", () => {
    render(<MobileNavigation />, { wrapper: AdminTokenProvider });

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(
      screen.getByRole("dialog", { name: "Mobile navigation" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Local admin token")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Close navigation panel" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Mobile navigation" }),
    ).not.toBeInTheDocument();
  });
});
