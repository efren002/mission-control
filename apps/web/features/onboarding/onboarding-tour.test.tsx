import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OnboardingTour } from "./onboarding-tour";
import { openOnboardingTour, TOUR_STORAGE_KEY } from "./onboarding-state";

describe("OnboardingTour", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("opens automatically on the first visit", () => {
    render(<OnboardingTour />);

    expect(
      screen.getByRole("dialog", { name: "Mission Control guide" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Welcome to Mission Control")).toBeInTheDocument();
  });

  it("walks through the steps with Next and Back", () => {
    render(<OnboardingTour />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Connect a provider")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Welcome to Mission Control")).toBeInTheDocument();
  });

  it("ends on a call to action that opens Missions", () => {
    render(<OnboardingTour />);

    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }

    const finish = screen.getByRole("link", { name: "Start building" });
    expect(finish).toHaveAttribute("href", "/missions");

    fireEvent.click(finish);
    expect(
      screen.queryByRole("dialog", { name: "Mission Control guide" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe("done");
  });

  it("does not reappear after being skipped", () => {
    const first = render(<OnboardingTour />);
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(
      screen.queryByRole("dialog", { name: "Mission Control guide" }),
    ).not.toBeInTheDocument();
    first.unmount();

    render(<OnboardingTour />);
    expect(
      screen.queryByRole("dialog", { name: "Mission Control guide" }),
    ).not.toBeInTheDocument();
  });

  it("reopens from the start when the open event fires", () => {
    localStorage.setItem(TOUR_STORAGE_KEY, "done");
    render(<OnboardingTour />);
    expect(
      screen.queryByRole("dialog", { name: "Mission Control guide" }),
    ).not.toBeInTheDocument();

    act(() => openOnboardingTour());

    expect(
      screen.getByRole("dialog", { name: "Mission Control guide" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Welcome to Mission Control")).toBeInTheDocument();
  });

  it("closes with the Escape key", () => {
    render(<OnboardingTour />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "Mission Control guide" }),
    ).not.toBeInTheDocument();
  });
});
