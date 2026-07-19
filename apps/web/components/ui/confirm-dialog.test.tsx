import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useConfirm, type ConfirmOptions } from "./confirm-dialog";

function Harness({ options, onResult }: { options: ConfirmOptions; onResult: (accepted: boolean) => void }) {
  const { confirm, confirmDialog } = useConfirm();
  return (
    <div>
      <button onClick={() => void confirm(options).then(onResult)}>open</button>
      {confirmDialog}
    </div>
  );
}

describe("useConfirm", () => {
  afterEach(cleanup);

  const options: ConfirmOptions = {
    title: "Delete test-project?",
    message: "This permanently deletes its data.",
    confirmLabel: "Delete project",
  };

  it("resolves true when the confirm button is clicked", async () => {
    let result: boolean | null = null;
    render(<Harness options={options} onResult={(accepted) => { result = accepted; }} />);
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("This permanently deletes its data.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("Delete project"));
    });
    expect(result).toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resolves false when cancelled", async () => {
    let result: boolean | null = null;
    render(<Harness options={options} onResult={(accepted) => { result = accepted; }} />);
    fireEvent.click(screen.getByText("open"));
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    expect(result).toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("resolves false when Escape is pressed", async () => {
    let result: boolean | null = null;
    render(<Harness options={options} onResult={(accepted) => { result = accepted; }} />);
    fireEvent.click(screen.getByText("open"));
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(result).toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
