import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
  it("renders the supplied label", () => {
    render(<StatusPill label="Operational" active />);
    expect(screen.getByText("Operational")).toBeInTheDocument();
  });
});
