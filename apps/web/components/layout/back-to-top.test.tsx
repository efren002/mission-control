import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackToTop } from "./back-to-top";

describe("BackToTop", () => {
  beforeEach(() => {
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 0,
    });
    window.scrollTo = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });

  afterEach(cleanup);

  it("appears only after the page has been scrolled", () => {
    render(<BackToTop />);
    expect(
      screen.queryByRole("button", { name: "Back to top" }),
    ).not.toBeInTheDocument();

    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 600,
    });
    fireEvent.scroll(window);

    expect(
      screen.getByRole("button", { name: "Back to top" }),
    ).toBeInTheDocument();
  });

  it("smoothly scrolls back to the top", () => {
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 600,
    });
    render(<BackToTop />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));

    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
  });

  it("respects reduced-motion preferences", () => {
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 600,
    });
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    render(<BackToTop />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));

    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "auto",
    });
  });
});
