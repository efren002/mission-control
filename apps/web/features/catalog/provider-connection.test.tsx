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

  it("hides the login button for http providers and shows the encrypted-key hint", () => {
    cleanup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("http providers must not poll the login endpoints");
    });

    render(
      <ProviderConnectionCard
        provider="openrouter"
        status={{
          kind: "http",
          authenticated: false,
          version: "http",
        }}
        token="local-token"
        onAuthenticated={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /connect/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText((_, element) =>
        Boolean(element?.textContent?.match(/stored encrypted in providers\.json/i)),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("ProviderConnectionBanner", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists disconnected providers that are in use and hides when everything is connected", async () => {
    // Route by URL: providers (status), settings/workflow (planner), agents (in-use providers).
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith("/providers"))
        return jsonResponse({
          providers: {
            codex: { authenticated: true },
            claude: { authenticated: false },
            openrouter: { kind: "http", authenticated: true },
          },
        });
      if (path.endsWith("/settings/workflow"))
        return jsonResponse({ planner_provider: "openrouter" });
      if (path.endsWith("/agents"))
        return jsonResponse([{ id: "a1", provider: "claude", enabled: true }]);
      throw new Error(`unexpected fetch ${path}`);
    });

    render(<ProviderConnectionBanner token="local-token" />);

    // Claude is in use (as an agent provider) and disconnected → warn.
    expect(await screen.findByText(/Claude is not connected/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect in settings/i })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("does not nag about CLI providers that are not in use", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith("/providers"))
        return jsonResponse({
          providers: {
            codex: { authenticated: false },
            claude: { authenticated: false },
            openrouter: { kind: "http", authenticated: true },
          },
        });
      if (path.endsWith("/settings/workflow"))
        return jsonResponse({ planner_provider: "openrouter" });
      if (path.endsWith("/agents")) return jsonResponse([]);
      throw new Error(`unexpected fetch ${path}`);
    });

    render(<ProviderConnectionBanner token="local-token" />);

    // Neither CLI provider is in use, so the banner stays hidden.
    await waitFor(() =>
      expect(screen.queryByText(/not connected/)).not.toBeInTheDocument(),
    );
  });
});
