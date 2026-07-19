"use client";

import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  HeartPulse,
  RadioTower,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { StatusPill } from "@/components/status/status-pill";
import { useAdminToken } from "@/features/auth/use-admin-token";
import { catalogApi } from "@/features/catalog/api";
import type {
  ProviderPerformance as ProviderPerformanceData,
  ProviderStatus,
} from "@/features/catalog/api";
import { cn } from "@/lib/cn";

import { ProviderUsage } from "./provider-usage";
import { ProviderPerformance } from "./provider-performance";
import { useRealtimeEvents } from "./use-realtime-events";
import { useSystemHealth } from "./use-system-health";

const ACTIVE_OBJECTIVE_STATUSES = new Set([
  "planning",
  "awaiting_approval",
  "awaiting_execution_approval",
  "executing",
]);

const COMPONENT_LABELS: Record<string, string> = {
  postgres: "Database",
  redis: "Redis cache",
  provider_gateway: "Provider gateway",
  runtime_gateway: "Runtime gateway",
};

interface WorkflowSummary {
  objectivesActive: number;
  objectivesTotal: number;
  approvalsPending: number;
  runsExecuting: number;
  runsPlanning: number;
  runsHolding: number;
}

const emptySummary: WorkflowSummary = {
  objectivesActive: 0,
  objectivesTotal: 0,
  approvalsPending: 0,
  runsExecuting: 0,
  runsPlanning: 0,
  runsHolding: 0,
};

const FEED_HIDDEN_KEYS = new Set([
  "type",
  "source",
  "run_id",
  "timestamp",
  "receivedAt",
]);

function describeEventPayload(event: Record<string, unknown>): string {
  return Object.entries(event)
    .filter(
      ([key, value]) =>
        !FEED_HIDDEN_KEYS.has(key) &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"),
    )
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(" ");
}

function HealthRow({
  label,
  state,
}: {
  label: string;
  state: "operational" | "unavailable" | "scanning";
}) {
  return (
    <div className="flex items-center justify-between border-t border-[#292824] py-2.5 first:border-t-0">
      <span className="text-xs text-terminal">{label}</span>
      <span
        className={cn(
          "inline-flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.12em]",
          state === "operational"
            ? "text-phosphor"
            : state === "unavailable"
              ? "text-orange-300"
              : "text-dim",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5",
            state === "operational"
              ? "bg-phosphor shadow-[0_0_8px_#9bbd86]"
              : state === "unavailable"
                ? "bg-orange-400"
                : "bg-[#55524c]",
          )}
        />
        {state}
      </span>
    </div>
  );
}

function RadarBackdrop() {
  return (
    <div className="radar-display" aria-hidden="true">
      <span className="radar-blip radar-blip-one" />
      <span className="radar-blip radar-blip-two" />
      <span className="radar-blip radar-blip-three" />
    </div>
  );
}

const MATRIX_COLUMNS = [
  "010011010101001101",
  "SYSRUN2049ONLINE",
  "110010100110101100",
  "AGENT07LIVEUPLINK",
  "001101011001011010",
  "UPLINKREADYNOMINAL",
  "101100101101001101",
  "MISSIONCONTROLEXEC",
  "011010010011101001",
  "TELEMETRYSTREAM01",
  "100101101001011010",
  "OBJECTIVELOCKED",
];

function MatrixBackdrop() {
  return (
    <div className="matrix-backdrop" aria-hidden="true">
      {MATRIX_COLUMNS.map((characters, index) => (
        <span key={index}>{characters}</span>
      ))}
    </div>
  );
}

export function DashboardOverview() {
  const health = useSystemHealth();
  const { token } = useAdminToken();
  const realtime = useRealtimeEvents(token);
  const [agentSummary, setAgentSummary] = useState({ online: 0, total: 0 });
  const [workflow, setWorkflow] = useState<WorkflowSummary>(emptySummary);
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>(
    {},
  );
  const [providerPerformance, setProviderPerformance] =
    useState<ProviderPerformanceData | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshThrottle = useRef<{ timer: number | null; lastRefresh: number }>(
    { timer: null, lastRefresh: 0 },
  );
  const operational = health.data?.status === "operational";

  // Workflow events (run.*, task.*, execution.*, ...) refresh the summary
  // ahead of the 60s poll; bursts collapse into one reload per 5s window.
  useEffect(() => {
    const event = realtime.lastEvent;
    if (!event || event.type.startsWith("system.")) return;
    const throttle = refreshThrottle.current;
    if (throttle.timer != null) return;
    const delay = Math.max(0, 5_000 - (Date.now() - throttle.lastRefresh));
    throttle.timer = window.setTimeout(() => {
      throttle.timer = null;
      throttle.lastRefresh = Date.now();
      setRefreshTick((tick) => tick + 1);
    }, delay);
  }, [realtime.lastEvent]);

  useEffect(() => {
    const throttle = refreshThrottle.current;
    return () => {
      if (throttle.timer != null) window.clearTimeout(throttle.timer);
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const load = async () => {
      setProvidersLoading(true);
      try {
        const [agents, providerData, performance, objectives, approvals, runs] =
          await Promise.all([
            catalogApi.agents(token),
            catalogApi.providers(token),
            catalogApi.providerPerformance(token),
            catalogApi.objectives(token),
            catalogApi.approvals(token),
            catalogApi.runs(token),
          ]);
        if (!active) return;
        setAgentSummary({
          online: agents.filter((agent) => agent.status === "online").length,
          total: agents.length,
        });
        setProviders(providerData.providers);
        setProviderPerformance(performance);
        setWorkflow({
          objectivesActive: objectives.filter((objective) =>
            ACTIVE_OBJECTIVE_STATUSES.has(objective.status),
          ).length,
          objectivesTotal: objectives.length,
          approvalsPending: approvals.filter(
            (approval) => approval.status === "pending",
          ).length,
          runsExecuting: runs.filter(
            (run) =>
              run.status === "executing" ||
              run.status === "queued_for_execution",
          ).length,
          runsPlanning: runs.filter((run) => run.status === "planning").length,
          runsHolding: runs.filter(
            (run) =>
              run.status === "awaiting_approval" ||
              run.status === "awaiting_execution_approval",
          ).length,
        });
      } catch {
        // Infrastructure health remains visible when protected telemetry fails.
      } finally {
        if (active) setProvidersLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [token, refreshTick]);

  const runtime =
    workflow.runsExecuting > 0
      ? {
          value: "EXEC",
          detail: `${workflow.runsExecuting} run${workflow.runsExecuting === 1 ? "" : "s"} building`,
          tone: "text-phosphor",
        }
      : workflow.runsPlanning > 0
        ? {
            value: "PLAN",
            detail: `${workflow.runsPlanning} run${workflow.runsPlanning === 1 ? "" : "s"} planning`,
            tone: "text-phosphor",
          }
        : workflow.runsHolding > 0
          ? {
              value: "HOLD",
              detail: "Waiting on approval",
              tone: "text-signal",
            }
          : {
              value: "IDLE",
              detail: "Awaiting first objective",
              tone: "text-terminal",
            };

  const metrics = [
    {
      label: "Active objectives",
      value: String(workflow.objectivesActive).padStart(2, "0"),
      detail:
        workflow.objectivesTotal > 0
          ? `${workflow.objectivesTotal} defined`
          : "No workflow deployed",
      icon: Activity,
      tone: workflow.objectivesActive > 0 ? "text-phosphor" : "text-terminal",
      href: "/objectives",
    },
    {
      label: "Agents online",
      value: String(agentSummary.online).padStart(2, "0"),
      detail: `${agentSummary.total} configured`,
      icon: Bot,
      tone: "text-terminal",
      meter:
        agentSummary.total > 0
          ? agentSummary.online / agentSummary.total
          : null,
      href: "/agents",
    },
    {
      label: "Pending approvals",
      value: String(workflow.approvalsPending).padStart(2, "0"),
      detail:
        workflow.approvalsPending > 0
          ? "Awaiting your decision"
          : "Approval queue clear",
      icon: CheckCircle2,
      tone: workflow.approvalsPending > 0 ? "text-signal" : "text-terminal",
      href: "/approvals",
    },
    {
      label: "Runtime",
      value: runtime.value,
      detail: runtime.detail,
      icon: Clock3,
      tone: runtime.tone,
      href: "/runs",
    },
  ];

  return (
    <div className="space-y-8">
      <section className="flex flex-col justify-between gap-4 border-b border-[#292824] pb-5 md:flex-row md:items-end">
        <div>
          <p className="eyebrow mb-3">System overview</p>
          <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal md:text-3xl">
            Mission Control
          </h1>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-dim">
            Supervise missions, compare provider outcomes, and inspect the
            evidence behind every completed build.
          </p>
        </div>
        <StatusPill
          label={
            health.isLoading
              ? "Scanning"
              : operational
                ? "Systems nominal"
                : "Degraded"
          }
          active={operational}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_minmax(240px,300px)]">
        <div className="grid gap-px border border-[#292824] bg-[#292824] sm:grid-cols-2">
          {metrics.map(
            ({ label, value, detail, icon: Icon, tone, meter, href }) => (
              <Link
                key={label}
                href={href}
                className="block bg-panel p-4 transition-colors hover:bg-[#151310] focus-visible:bg-[#151310] focus-visible:outline-none"
              >
                <div className="mb-7 flex items-center justify-between">
                  <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-dim">
                    {label}
                  </p>
                  <Icon className="h-3.5 w-3.5 text-signal" />
                </div>
                <p
                  className={cn(
                    "font-mono text-3xl font-bold tracking-[-0.06em]",
                    tone,
                  )}
                >
                  {value}
                </p>
                <p className="mt-2 text-[10px] text-dim">{detail}</p>
                {meter != null && (
                  <div className="mt-3 h-0.5 w-full bg-signal/10">
                    <div
                      className="h-full bg-signal"
                      style={{ width: `${Math.round(meter * 100)}%` }}
                    />
                  </div>
                )}
              </Link>
            ),
          )}
        </div>

        <article className="control-panel relative overflow-hidden p-4">
          <RadarBackdrop />
          <div className="relative z-10 mb-4 flex items-center justify-between">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-dim">
              System health
            </p>
            <HeartPulse className="h-3.5 w-3.5 text-signal" />
          </div>
          <div className="relative z-10">
            <HealthRow
              label="API gateway"
              state={
                health.isLoading
                  ? "scanning"
                  : health.isError
                    ? "unavailable"
                    : "operational"
              }
            />
            {Object.entries(health.data?.components ?? {}).map(
              ([name, component]) => (
                <HealthRow
                  key={name}
                  label={COMPONENT_LABELS[name] ?? name}
                  state={component.status}
                />
              ),
            )}
            <HealthRow
              label="Event stream"
              state={
                realtime.connectionState === "connected"
                  ? "operational"
                  : realtime.connectionState === "connecting"
                    ? "scanning"
                    : "unavailable"
              }
            />
          </div>
        </article>
      </section>

      <ProviderPerformance
        performance={providerPerformance}
        loading={providersLoading}
      />

      <ProviderUsage providers={providers} loading={providersLoading} />

      <section className="control-panel p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="eyebrow">Live telemetry</p>
            <h2 className="mt-2 text-lg font-semibold text-white">
              Event uplink
            </h2>
          </div>
          <RadioTower className="h-4 w-4 text-signal" />
        </div>
        <div className="relative min-h-28 overflow-hidden border border-[#292824] bg-black/30 p-4 font-mono text-[10px]">
          <MatrixBackdrop />
          <div className="relative z-10 flex items-center justify-between gap-3">
            <p className="text-dim">CHANNEL mission-control.events</p>
            <p className="text-[#55524c]">uplink.{realtime.connectionState}</p>
          </div>
          {realtime.events.length === 0 ? (
            <p className="relative z-10 mt-4 text-dim">
              Listening for events...
            </p>
          ) : (
            <div className="relative z-10 mt-4 max-h-48 space-y-1.5 overflow-y-auto">
              {realtime.events.map((event, index) => {
                const detail = describeEventPayload(event);
                return (
                  <div
                    key={`${event.receivedAt}-${index}`}
                    className="flex items-baseline gap-3"
                  >
                    <span className="shrink-0 text-[#55524c]">
                      {new Date(event.receivedAt).toLocaleTimeString()}
                    </span>
                    <span className="min-w-0">
                      <span className="text-phosphor">
                        {event.type}
                        {event.source ? ` :: ${event.source}` : ""}
                        {typeof event.run_id === "string"
                          ? ` :: run ${event.run_id.slice(0, 8)}`
                          : ""}
                      </span>
                      {detail ? (
                        <span className="ml-3 break-all text-dim">
                          {detail}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <p className="mt-4 text-[10px] leading-5 text-dim">
          The event feed contains operational metadata only; provider prompts
          and credentials are excluded.
        </p>
      </section>
    </div>
  );
}
