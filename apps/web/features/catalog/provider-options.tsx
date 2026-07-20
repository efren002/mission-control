"use client";

import type { ProviderStatus } from "./api";

export type ProviderKind = "cli" | "http";

export interface ProviderOption {
  value: string;
  label: string;
  kind: ProviderKind;
}

// CLI providers are always present (they own the login flow). HTTP providers
// are appended from the gateway's provider map at runtime.
const CLI_PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
};

const CLI_PROVIDER_ORDER = ["codex", "claude"] as const;

export function providerLabel(name: string): string {
  return CLI_PROVIDER_LABELS[name] ?? name;
}

export function buildProviderOptions(
  providers: Record<string, ProviderStatus>,
): ProviderOption[] {
  const options: ProviderOption[] = CLI_PROVIDER_ORDER.map((name) => ({
    value: name,
    label: CLI_PROVIDER_LABELS[name],
    kind: "cli",
  }));
  for (const [name, status] of Object.entries(providers)) {
    if (status?.kind === "http") {
      options.push({ value: name, label: `${name} (http)`, kind: "http" });
    }
  }
  return options;
}

// Keeps the currently-selected value selectable even when the gateway is
// unreachable or the agent's provider is not yet in the option list, so an
// http provider never silently disappears from the dropdown.
function withCurrentValue(
  options: ProviderOption[],
  value: string,
): ProviderOption[] {
  if (!value || options.some((option) => option.value === value)) return options;
  return [
    ...options,
    { value, label: providerLabel(value), kind: "cli" as ProviderKind },
  ];
}

export function ProviderSelect({
  options,
  value,
  onChange,
  id,
  className,
}: {
  options: ProviderOption[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
}) {
  const effective = withCurrentValue(options, value);
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    >
      {effective.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
