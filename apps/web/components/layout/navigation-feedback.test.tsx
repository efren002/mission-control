import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NavigationFeedback } from "./navigation-feedback";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

describe("NavigationFeedback", () => {
  beforeEach(() => {
    pathname = "/";
  });

  afterEach(cleanup);

  const clickWithoutBrowserNavigation = (element: HTMLElement) => {
    window.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(element);
  };

  it("shows progress immediately for internal page navigation", () => {
    render(
      <>
        <NavigationFeedback />
        <Link href="/projects">
          <span>Projects</span>
        </Link>
      </>,
    );

    clickWithoutBrowserNavigation(screen.getByText("Projects"));

    expect(
      screen.getByRole("progressbar", { name: "Loading page" }),
    ).toBeInTheDocument();
  });

  it("does not show progress when navigating to the current page", () => {
    render(
      <>
        <NavigationFeedback />
        <Link href="/">Dashboard</Link>
      </>,
    );

    clickWithoutBrowserNavigation(screen.getByText("Dashboard"));

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("does not intercept modified clicks", () => {
    render(
      <>
        <NavigationFeedback />
        <Link href="/projects">Projects</Link>
      </>,
    );

    window.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(screen.getByText("Projects"), { ctrlKey: true });

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
