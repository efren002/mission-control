import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderConnectionBanner, ProviderConnectionCard } from "./provider-connection";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const noSession = () => jsonResponse({ detail: "No login session for this provider" }, 404);

describe("ProviderConnectionCard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("starts a codex login and shows the sign-in link and one-time code", async () => {
    const session = {
      provider: "codex",
      status: "awaiting_browser",
      url: "https://auth.openai.com/codex/device",
      userCode: "D5IO-KN5QQ",
      needsInput: false,
      startedAt: "2026-07-18T00:00:00Z",
      error: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if (init?.method === "POST") return jsonResponse(session);
      return noSession();
    });

    render(
      <ProviderConnectionCard
        provider="codex"
        status={{ authenticated: false, version: "codex-cli 0.144.5" }}
        token="local-token"
        onAuthenticated={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /connect/i }));

    const link = await screen.findByRole("link", { name: /open sign-in page/i });
    expect(link).toHaveAttribute("href", "https://auth.openai.com/codex/device");
    expect(screen.getByText("D5IO-KN5QQ")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/providers/codex/login"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("submits the pasted claude code and reports success", async () => {
    const awaiting = {
      provider: "claude",
      status: "awaiting_input",
      url: "https://claude.com/oauth/authorize?code=true",
      userCode: null,
      needsInput: true,
      startedAt: "2026-07-18T00:00:00Z",
      error: null,
    };
    const onAuthenticated = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/login/input")) return jsonResponse({ ...awaiting, status: "succeeded" });
      if (init?.method === "POST") return jsonResponse(awaiting);
      return noSession();
    });

    render(
      <ProviderConnectionCard
        provider="claude"
        status={{ authenticated: false }}
        token="local-token"
        onAuthenticated={onAuthenticated}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /connect/i }));
    const input = await screen.findByPlaceholderText("Paste code");
    fireEvent.change(input, { target: { value: "pasted-oauth-code" } });
    fireEvent.click(screen.getByRole("button", { name: /submit code/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/providers/claude/login/input"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "pasted-oauth-code" }),
      }),
    );
  });
});

describe("ProviderConnectionBanner", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists disconnected providers and hides when everything is connected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        providers: {
          codex: { authenticated: true },
          claude: { authenticated: false },
        },
      }),
    );

    render(<ProviderConnectionBanner token="local-token" />);

    expect(await screen.findByText(/Claude is not connected/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect in settings/i })).toHaveAttribute(
      "href",
      "/settings",
    );

    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        providers: {
          codex: { authenticated: true },
          claude: { authenticated: true },
        },
      }),
    );
    render(<ProviderConnectionBanner token="local-token" />);
    await waitFor(() => expect(screen.queryByText(/not connected/)).not.toBeInTheDocument());
  });
});
