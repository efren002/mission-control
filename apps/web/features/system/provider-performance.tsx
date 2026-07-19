import { GitCompareArrows } from "lucide-react";

import type {
  ProviderPerformance as ProviderPerformanceData,
  ProviderPerformanceMetric,
} from "@/features/catalog/api";

import { formatTokens } from "./provider-usage";

export function ProviderPerformance({
  performance,
  loading,
}: {
  performance: ProviderPerformanceData | null;
  loading: boolean;
}) {
  const metrics = performance?.providers ?? [];
  const byRole = performance?.by_role ?? [];

  return (
    <section className="control-panel p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="eyebrow">Persistent outcomes</p>
          <h2 className="mt-2 text-lg font-semibold text-white">
            Provider performance
          </h2>
        </div>
        <GitCompareArrows className="h-4 w-4 text-signal" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {(["codex", "claude"] as const).map((provider) => {
          const metric = metrics.find((item) => item.provider === provider);
          return (
            <ProviderCard
              key={provider}
              provider={provider}
              metric={metric}
              loading={loading}
            />
          );
        })}
      </div>

      {byRole.length > 0 && (
        <div className="mt-5 overflow-x-auto border border-[#292824]">
          <table className="w-full min-w-[680px] text-left">
            <thead className="bg-black/20 text-[8px] uppercase tracking-wider text-dim">
              <tr>
                <th className="px-3 py-2.5">Provider / role</th>
                <th className="px-3 py-2.5">Outcomes</th>
                <th className="px-3 py-2.5">Success</th>
                <th className="px-3 py-2.5">Average time</th>
                <th className="px-3 py-2.5">Fallbacks</th>
                <th className="px-3 py-2.5">Recorded tokens</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#292824] text-[10px]">
              {byRole.map((metric) => (
                <tr key={`${metric.provider}-${metric.role}`}>
                  <td className="px-3 py-3 text-terminal">
                    <span className="capitalize">{metric.provider}</span>
                    <span className="text-dim"> · {metric.role}</span>
                  </td>
                  <td className="px-3 py-3 text-dim">
                    {metric.completed} passed / {metric.failed} failed
                  </td>
                  <td className="px-3 py-3 font-mono text-terminal">
                    {formatRate(metric)}
                  </td>
                  <td className="px-3 py-3 font-mono text-dim">
                    {formatDuration(metric.average_duration_ms)}
                  </td>
                  <td className="px-3 py-3 text-dim">
                    {metric.fallback_attempts
                      ? `${metric.fallback_successes}/${metric.fallback_attempts} succeeded`
                      : "None"}
                  </td>
                  <td className="px-3 py-3 font-mono text-dim">
                    {formatTokens(metric.total_tokens)}
                    <span className="ml-1 text-[#55524c]">
                      ({metric.token_coverage}/{metric.invocations})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-[9px] leading-4 text-[#55524c]">
        Outcomes include completed and failed mission invocations with recorded
        routing metadata. Token coverage shows how many invocations reported
        provider usage; unknown usage is excluded instead of counted as zero.
      </p>
    </section>
  );
}

function ProviderCard({
  provider,
  metric,
  loading,
}: {
  provider: "codex" | "claude";
  metric: ProviderPerformanceMetric | undefined;
  loading: boolean;
}) {
  const samples = metric?.invocations ?? 0;
  return (
    <article className="border border-[#292824] bg-white/[0.015] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold capitalize text-terminal">
            {provider}
          </p>
          <p className="mt-1 text-[9px] uppercase tracking-wider text-dim">
            Mission history
          </p>
        </div>
        <span className="text-[9px] uppercase text-dim">
          {loading && !metric
            ? "loading"
            : `${samples} outcome${samples === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3">
        <MetricValue label="Success" value={metric ? formatRate(metric) : "—"} />
        <MetricValue
          label="Average time"
          value={formatDuration(metric?.average_duration_ms ?? null)}
        />
        <MetricValue
          label="Tokens"
          value={metric ? formatTokens(metric.total_tokens) : "—"}
        />
      </div>
      <p className="mt-4 border-t border-[#292824] pt-3 text-[9px] text-dim">
        {metric?.fallback_attempts
          ? `${metric.fallback_successes} of ${metric.fallback_attempts} fallback attempts succeeded`
          : "No fallback attempts recorded"}
        {metric
          ? ` · token coverage ${metric.token_coverage}/${metric.invocations}`
          : ""}
      </p>
    </article>
  );
}

function MetricValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-lg font-semibold text-terminal">{value}</p>
      <p className="mt-1 text-[8px] uppercase tracking-wider text-dim">
        {label}
      </p>
    </div>
  );
}

function formatRate(metric: ProviderPerformanceMetric) {
  return metric.invocations > 0 ? `${metric.success_rate}%` : "—";
}

function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value / 60_000)}m`;
}
