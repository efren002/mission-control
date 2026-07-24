import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NotificationCenter } from "./notification-center";

afterEach(cleanup);

describe("NotificationCenter", () => {
  it("opens, displays live events, marks them read, and clears them", () => {
    const { rerender } = render(
      <NotificationCenter connectionState="connected" lastEvent={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("No notifications yet.")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    rerender(
      <NotificationCenter
        connectionState="connected"
        lastEvent={{
          type: "planner.completed",
          source: "planner",
          task_count: 3,
          timestamp: "2026-07-17T00:00:00.000Z",
        }}
      />,
    );

    const unreadButton = screen.getByRole("button", {
      name: "Notifications, 1 unread",
    });
    fireEvent.click(unreadButton);
    expect(screen.getByText("Planning completed")).toBeInTheDocument();
    expect(screen.getByText("3 tasks generated")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(screen.getByText("No notifications yet.")).toBeInTheDocument();
  });

  it("surfaces a provider rate-limit event as a distinct alert", () => {
    render(
      <NotificationCenter
        connectionState="connected"
        lastEvent={{
          type: "provider.rate_limited",
          source: "workflow",
          provider: "claude",
          purpose: "task_execution",
          timestamp: "2026-07-17T00:00:00.000Z",
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    );
    expect(screen.getByText("Provider rate limit reached")).toBeInTheDocument();
    expect(
      screen.getByText(/claude's usage limit was reached during task execution/i),
    ).toBeInTheDocument();
  });

  it("does not surface keepalive traffic", () => {
    render(
      <NotificationCenter
        connectionState="connected"
        lastEvent={{ type: "system.keepalive", source: "api" }}
      />,
    );

    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });
});
