import { Gauge } from "lucide-react";

import type {
  ProviderStatus,
  RateLimitWindow,
} from "@/features/catalog/api";

export function ProviderUsage({
  providers,
  loading,
}: {
  providers: Record<string, ProviderStatus>;
  loading: boolean;
}) {
  return (
    <section className="control-panel p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="eyebrow">Current usage</p>
          <h2 className="mt-2 text-lg font-semibold text-white">
            Model capacity
          </h2>
        </div>
        <Gauge className="h-4 w-4 text-signal" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {(["codex", "claude"] as const).map((name) => {
          const provider = providers[name];
          const usage = provider?.usage;
          return (
            <article
              key={name}
              className="border border-[#292824] bg-white/[0.015] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold capitalize text-terminal">
                    {name === "codex" ? "Codex" : "Claude"}
                  </p>
                  <p className="mt-1 text-[9px] uppercase tracking-wider text-dim">
                    Gateway runtime
                  </p>
                </div>
                <span
                  className={`text-[9px] uppercase ${provider?.available ? "text-phosphor" : "text-orange-300"}`}
                >
                  {loading && !provider
                    ? "scanning"
                    : provider?.available
                      ? "available"
                      : "unavailable"}
                </span>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3">
                <UsageValue
                  label="Total tokens"
                  value={formatTokens(usage?.totalTokens)}
                />
                <UsageValue
                  label="Input"
                  value={formatTokens(usage?.inputTokens)}
                />
                <UsageValue
                  label="Output"
                  value={formatTokens(usage?.outputTokens)}
                />
              </div>
              {usage && usage.requests > 0 && (
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[#292824] pt-4">
                  <UsageValue
                    label="Cached input"
                    value={formatTokens(usage.cachedInputTokens)}
                  />
                  <UsageValue
                    label="Cache rate"
                    value={formatPercent(
                      usage.cachedInputTokens,
                      usage.inputTokens,
                    )}
                  />
                  <UsageValue
                    label="Avg / request"
                    value={formatTokens(
                      Math.round(usage.totalTokens / usage.requests),
                    )}
                  />
                </div>
              )}
              <p className="mt-4 text-[9px] text-dim">
                {usage
                  ? `${usage.requests} request${usage.requests === 1 ? "" : "s"} since gateway start${usage.updatedAt ? ` · updated ${formatUpdatedAt(usage.updatedAt)}` : ""}`
                  : "Usage telemetry is not available yet."}
              </p>

              {name === "codex" && provider?.rateLimits ? (
                <div className="mt-5 border-t border-[#292824] pt-4">
                  <p className="mb-3 text-[9px] uppercase tracking-wider text-dim">
                    Account limits
                    {provider.rateLimits.planType
                      ? ` · ${provider.rateLimits.planType.replaceAll("_", " ")}`
                      : ""}
                  </p>
                  <div className="space-y-3">
                    {provider.rateLimits.primary && (
                      <LimitBar
                        label={formatWindowLabel(
                          provider.rateLimits.primary,
                          "Primary",
                        )}
                        window={provider.rateLimits.primary}
                      />
                    )}
                    {provider.rateLimits.secondary && (
                      <LimitBar
                        label={formatWindowLabel(
                          provider.rateLimits.secondary,
                          "Secondary",
                        )}
                        window={provider.rateLimits.secondary}
                      />
                    )}
                    {!provider.rateLimits.primary &&
                      !provider.rateLimits.secondary && (
                        <p className="text-[9px] text-dim">
                          No active limit window was returned.
                        </p>
                      )}
                  </div>
                </div>
              ) : name === "claude" ? (
                <p className="mt-5 border-t border-[#292824] pt-4 text-[9px] leading-4 text-dim">
                  Claude Code does not expose account quota through its
                  headless CLI; completed-run tokens are tracked here.
                </p>
              ) : null}

              {usage?.recentRequests?.length ? (
                <div className="mt-5 border-t border-[#292824] pt-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-[9px] uppercase tracking-wider text-dim">
                      Recent token drivers
                    </p>
                    <p className="text-[8px] text-[#55524c]">
                      highest usage first
                    </p>
                  </div>
                  <div className="space-y-2">
                    {[...usage.recentRequests]
                      .sort((left, right) => right.totalTokens - left.totalTokens)
                      .slice(0, 5)
                      .map((request, index) => (
                        <div
                          key={`${request.completedAt}-${index}`}
                          className="border border-[#292824] bg-black/10 px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p
                                className="truncate text-[10px] text-terminal"
                                title={request.label}
                              >
                                {request.label}
                              </p>
                              <p className="mt-1 text-[8px] text-dim">
                                {request.model || "default model"} ·{" "}
                                {formatDuration(request.durationMs)} · prompt{" "}
                                {formatChars(request.promptChars)}
                              </p>
                            </div>
                            <p
                              className={`shrink-0 font-mono text-xs font-semibold ${
                                request.succeeded
                                  ? "text-terminal"
                                  : "text-orange-300"
                              }`}
                            >
                              {formatTokens(request.totalTokens)}
                            </p>
                          </div>
                          <p className="mt-1.5 text-[8px] text-[#55524c]">
                            input {formatTokens(request.inputTokens)} · cached{" "}
                            {formatTokens(request.cachedInputTokens)} · output{" "}
                            {formatTokens(request.outputTokens)}
                            {!request.succeeded ? " · failed" : ""}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-[9px] leading-4 text-[#55524c]">
        Runtime counters reset when the provider gateway restarts. Cached input
        is included in input and total token counts.
      </p>
    </section>
  );
}

function UsageValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-lg font-semibold text-terminal">{value}</p>
      <p className="mt-1 text-[8px] uppercase tracking-wider text-dim">
        {label}
      </p>
    </div>
  );
}

function LimitBar({
  label,
  window,
}: {
  label: string;
  window: RateLimitWindow;
}) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[9px]">
        <span className="text-dim">{label}</span>
        <span className={used >= 90 ? "text-orange-300" : "text-terminal"}>
          {used}% used
        </span>
      </div>
      <div className="h-1.5 overflow-hidden bg-[#292824]">
        <div
          className={`h-full ${used >= 90 ? "bg-orange-400" : "bg-signal"}`}
          style={{ width: `${used}%` }}
        />
      </div>
      {window.resetsAt && (
        <p className="mt-1.5 text-right text-[8px] text-[#55524c]">
          Resets {new Date(window.resetsAt * 1000).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function formatWindowLabel(window: RateLimitWindow, fallback: string) {
  if (!window.windowDurationMins) return fallback;
  if (window.windowDurationMins % (60 * 24) === 0) {
    const days = window.windowDurationMins / (60 * 24);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (window.windowDurationMins % 60 === 0) {
    const hours = window.windowDurationMins / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${window.windowDurationMins} min`;
}

export function formatTokens(value?: number) {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleTimeString();
}

function formatPercent(value: number, total: number) {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function formatDuration(value: number) {
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function formatChars(value: number) {
  return `${formatTokens(value)} chars`;
}
