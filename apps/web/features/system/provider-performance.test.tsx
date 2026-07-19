import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderPerformance } from "./provider-performance";

describe("ProviderPerformance", () => {
  it("renders persistent outcomes, fallbacks, roles, and token coverage", () => {
    render(
      <ProviderPerformance
        loading={false}
        performance={{
          generated_at: "2026-07-19T00:00:00Z",
          providers: [
            {
              provider: "codex",
              role: null,
              invocations: 4,
              completed: 3,
              failed: 1,
              success_rate: 75,
              average_duration_ms: 30_000,
              fallback_attempts: 1,
              fallback_successes: 1,
              token_coverage: 3,
              input_tokens: 1_000,
              cached_input_tokens: 200,
              output_tokens: 500,
              total_tokens: 1_500,
            },
            {
              provider: "claude",
              role: null,
              invocations: 0,
              completed: 0,
              failed: 0,
              success_rate: 0,
              average_duration_ms: null,
              fallback_attempts: 0,
              fallback_successes: 0,
              token_coverage: 0,
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            },
          ],
          by_role: [
            {
              provider: "codex",
              role: "developer",
              invocations: 4,
              completed: 3,
              failed: 1,
              success_rate: 75,
              average_duration_ms: 30_000,
              fallback_attempts: 1,
              fallback_successes: 1,
              token_coverage: 3,
              input_tokens: 1_000,
              cached_input_tokens: 200,
              output_tokens: 500,
              total_tokens: 1_500,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Provider performance")).toBeInTheDocument();
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "codex · developer",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 of 1 fallback attempts succeeded/),
    ).toBeInTheDocument();
    expect(screen.getByText("(3/4)")).toBeInTheDocument();
  });
});
