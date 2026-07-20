import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomProviderForm } from "./custom-provider-form";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const API_BASE = "http://localhost:8000/api/v1";

describe("CustomProviderForm", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("submits a validated provider with the api_key via POST /providers/custom", async () => {
    const calls: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push(init ?? {});
      return jsonResponse({ providers: {} });
    });
    const onSaved = vi.fn();

    render(
      <CustomProviderForm mode="create" token="local-token" onSaved={onSaved} onCancel={() => undefined} />,
    );

    fireEvent.change(screen.getByPlaceholderText("openrouter"), { target: { value: "openrouter" } });
    fireEvent.change(screen.getByPlaceholderText("https://openrouter.ai/api/v1"), {
      target: { value: "https://openrouter.ai/api/v1" },
    });
    // API key field is masked by default (type=password).
    const keyInput = screen.getByPlaceholderText("sk-...");
    expect(keyInput).toHaveAttribute("type", "password");
    fireEvent.change(keyInput, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(String(calls[0].body)).toEqual(
      JSON.stringify({
        name: "openrouter",
        kind: "http",
        format: "openai",
        base_url: "https://openrouter.ai/api/v1",
        model: null,
        api_key: "sk-test-123",
        max_tokens: null,
      }),
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      `${API_BASE}/providers/custom`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("toggles the API key field between masked and visible", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ providers: {} }));
    render(
      <CustomProviderForm mode="create" token="local-token" onSaved={() => undefined} onCancel={() => undefined} />,
    );

    const keyInput = screen.getByPlaceholderText("sk-...");
    expect(keyInput).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByLabelText(/show api key/i));
    expect(keyInput).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByLabelText(/hide api key/i));
    expect(keyInput).toHaveAttribute("type", "password");
  });

  it("blocks submit when the api_key is missing on create", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ providers: {} }));
    const onSaved = vi.fn();

    render(
      <CustomProviderForm mode="create" token="local-token" onSaved={onSaved} onCancel={() => undefined} />,
    );

    fireEvent.change(screen.getByPlaceholderText("openrouter"), { target: { value: "openrouter" } });
    fireEvent.change(screen.getByPlaceholderText("https://openrouter.ai/api/v1"), {
      target: { value: "https://x/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => expect(screen.getByText(/api key is required/i)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("seeds fields from initial in update mode and omits a blank api_key", async () => {
    const calls: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push(init ?? {});
      return jsonResponse({ providers: {} });
    });
    const onSaved = vi.fn();

    render(
      <CustomProviderForm
        mode="update"
        token="local-token"
        onSaved={onSaved}
        onCancel={() => undefined}
        initial={{
          name: "openrouter",
          format: "anthropic",
          base_url: "https://api.anthropic.com/v1",
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 8192,
        }}
      />,
    );

    expect(screen.getByPlaceholderText("openrouter")).toBeDisabled();
    // Leave the key blank → sent as null so the gateway keeps the existing key.
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls[0].method).toBe("PUT");
    expect(JSON.parse(String(calls[0].body)).api_key).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      `${API_BASE}/providers/custom/openrouter`,
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
