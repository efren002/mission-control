import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MaintenanceFinding } from "@/features/catalog/api";

import { FindingsInbox, formatInterval } from "./operations-board";

function finding(overrides: Partial<MaintenanceFinding> = {}): MaintenanceFinding {
  return {
    id: "f1",
    schedule_id: "s1",
    project_id: "p1",
    repository_id: null,
    detector_kind: "failing_test_diagnosis",
    severity: "high",
    title: "Test suite failing in demo",
    detail: "pytest exited with code 1",
    evidence: {},
    proposed_objective: { title: "Fix failing tests", description: "..." },
    status: "proposed",
    objective_id: null,
    created_at: "2026-07-20T00:00:00Z",
    resolved_at: null,
    ...overrides,
  };
}

describe("FindingsInbox", () => {
  afterEach(cleanup);

  it("shows an empty state when there are no findings", () => {
    render(<FindingsInbox findings={[]} busyId={null} onApprove={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(/No findings are waiting/i)).toBeInTheDocument();
  });

  it("approves a finding through the callback", () => {
    const onApprove = vi.fn();
    render(
      <FindingsInbox
        findings={[finding()]}
        busyId={null}
        onApprove={onApprove}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("disables approval when there is no proposed objective", () => {
    render(
      <FindingsInbox
        findings={[finding({ proposed_objective: null })]}
        busyId={null}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
  });
});

describe("formatInterval", () => {
  it("renders human-friendly cadences", () => {
    expect(formatInterval(86_400)).toBe("1d");
    expect(formatInterval(3_600)).toBe("1h");
    expect(formatInterval(1_800)).toBe("30m");
  });
});
