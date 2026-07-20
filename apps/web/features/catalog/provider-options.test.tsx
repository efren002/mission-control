import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildProviderOptions, ProviderSelect } from "./provider-options";

describe("buildProviderOptions", () => {
  afterEach(() => cleanup());

  it("appends http providers from GET /providers with a kind label, keeping the CLI defaults", () => {
    const options = buildProviderOptions({
      codex: { kind: "cli", authenticated: true },
      claude: { kind: "cli", authenticated: false },
      openrouter: { kind: "http", authenticated: true, version: "http" },
    });

    expect(options.map((option) => option.value)).toEqual([
      "codex",
      "claude",
      "openrouter",
    ]);
    const http = options.find((option) => option.value === "openrouter");
    expect(http?.kind).toBe("http");
    expect(http?.label).toMatch(/openrouter/i);
    expect(http?.label).toMatch(/http/i);
  });

  it("always includes codex and claude even when the gateway omits them", () => {
    const options = buildProviderOptions({});
    expect(options.map((option) => option.value)).toEqual(["codex", "claude"]);
  });
});

describe("ProviderSelect", () => {
  afterEach(() => cleanup());

  it("renders dynamic options including http providers", () => {
    const options = buildProviderOptions({ openrouter: { kind: "http" } });
    render(
      <ProviderSelect
        options={options}
        value="openrouter"
        onChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("option", { name: /openrouter/i, selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude" })).toBeInTheDocument();
  });

  it("keeps the current value selectable when it is not in the option list", () => {
    render(
      <ProviderSelect
        options={[{ value: "codex", label: "Codex", kind: "cli" }]}
        value="openrouter"
        onChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("option", { name: /openrouter/i, selected: true }),
    ).toBeInTheDocument();
  });
});
