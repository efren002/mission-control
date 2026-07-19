import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatTokens, ProviderUsage } from "./provider-usage";

describe("ProviderUsage", () => {
  it("renders usage for both providers and Codex account limits", () => {
    render(
      <ProviderUsage
        loading={false}
        providers={{
          codex: {
            available: true,
            usage: {
              requests: 2,
              inputTokens: 1200,
              cachedInputTokens: 800,
              outputTokens: 300,
              totalTokens: 1500,
              updatedAt: null,
              recentRequests: [
                {
                  label: "Task · Reduce dashboard token usage",
                  model: "gpt-5",
                  promptChars: 4200,
                  inputTokens: 1200,
                  cachedInputTokens: 800,
                  outputTokens: 300,
                  totalTokens: 1500,
                  durationMs: 65000,
                  succeeded: true,
                  completedAt: "2026-07-17T00:00:00.000Z",
                },
              ],
            },
            rateLimits: {
              planType: "plus",
              primary: {
                usedPercent: 42,
                resetsAt: null,
                windowDurationMins: 300,
              },
            },
          },
          claude: {
            available: true,
            usage: {
              requests: 1,
              inputTokens: 500,
              cachedInputTokens: 100,
              outputTokens: 50,
              totalTokens: 550,
              updatedAt: null,
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("42% used")).toBeInTheDocument();
    expect(screen.getByText("5 hours")).toBeInTheDocument();
    expect(screen.getByText("2 requests since gateway start")).toBeInTheDocument();
    expect(screen.getByText("Recent token drivers")).toBeInTheDocument();
    expect(
      screen.getByText("Task · Reduce dashboard token usage"),
    ).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
  });

  it("formats large token totals compactly", () => {
    expect(formatTokens(1250)).toBe("1.3K");
  });
});
