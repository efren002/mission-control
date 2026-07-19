"use client";

import { AlertTriangle, CheckCircle2, Clock, Play, Radar, Trash2, XCircle } from "lucide-react";

import type {
  DetectorKind,
  FindingSeverity,
  MaintenanceFinding,
  MaintenanceRun,
  MaintenanceSchedule,
  OperationsOverview,
} from "@/features/catalog/api";

export const DETECTOR_LABELS: Record<DetectorKind, string> = {
  dependency_maintenance: "Dependency maintenance",
  failing_test_diagnosis: "Failing-test diagnosis",
  documentation_drift: "Documentation drift",
  issue_triage: "Issue triage",
  security_health: "Security checks",
  repo_health: "Repository health",
  mission_template: "Recurring mission",
};

const SEVERITY_STYLES: Record<FindingSeverity, string> = {
  info: "text-dim border-[#292824]",
  low: "text-phosphor border-[#294028]",
  medium: "text-yellow-300 border-yellow-800/60",
  high: "text-orange-300 border-orange-800/60",
  critical: "text-red-300 border-red-800/70",
};

export function OverviewTiles({
  overview,
  continuousEnabled,
}: {
  overview: OperationsOverview | null;
  continuousEnabled: boolean;
}) {
  const proposed = overview?.proposed_findings ?? 0;
  const enabled = overview?.enabled_schedules ?? 0;
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      <Tile label="Findings awaiting review" value={String(proposed)} accent={proposed > 0} />
      <Tile label="Enabled schedules" value={String(enabled)} />
      <Tile
        label="Continuous operations"
        value={continuousEnabled ? "On" : "Off"}
        accent={!continuousEnabled}
        hint={continuousEnabled ? "Running unattended" : "Enable in Settings"}
      />
    </section>
  );
}

function Tile({
  label,
  value,
  accent = false,
  hint,
}: {
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
}) {
  return (
    <article className="control-panel p-4">
      <p className="text-[9px] uppercase tracking-wider text-dim">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-semibold ${accent ? "text-signal" : "text-terminal"}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-[9px] text-dim">{hint}</p>}
    </article>
  );
}

export function FindingsInbox({
  findings,
  busyId,
  onApprove,
  onDismiss,
}: {
  findings: MaintenanceFinding[];
  busyId: string | null;
  onApprove: (finding: MaintenanceFinding) => void;
  onDismiss: (finding: MaintenanceFinding) => void;
}) {
  return (
    <section className="control-panel p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="eyebrow">Approval required</p>
          <h2 className="mt-2 text-lg font-semibold text-white">Findings inbox</h2>
        </div>
        <AlertTriangle className="h-4 w-4 text-signal" />
      </div>
      {findings.length === 0 ? (
        <p className="text-xs text-dim">
          No findings are waiting. Maintenance checks propose work here; nothing runs until you
          approve it.
        </p>
      ) : (
        <ul className="space-y-3">
          {findings.map((finding) => (
            <li key={finding.id} className="border border-[#292824] bg-white/[0.015] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`border px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider ${SEVERITY_STYLES[finding.severity]}`}
                    >
                      {finding.severity}
                    </span>
                    <span className="text-[9px] uppercase tracking-wider text-dim">
                      {DETECTOR_LABELS[finding.detector_kind]}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-terminal">{finding.title}</p>
                  {finding.proposed_objective && (
                    <p className="mt-1 text-[10px] leading-4 text-dim">
                      Proposed objective: {finding.proposed_objective.title}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => onApprove(finding)}
                    disabled={busyId === finding.id || !finding.proposed_objective}
                    className="inline-flex items-center gap-1.5 bg-signal px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-black disabled:opacity-40"
                  >
                    <CheckCircle2 className="h-3 w-3" /> Approve
                  </button>
                  <button
                    onClick={() => onDismiss(finding)}
                    disabled={busyId === finding.id}
                    className="inline-flex items-center gap-1.5 border border-[#292824] px-3 py-1.5 text-[9px] uppercase tracking-wider text-dim hover:border-orange-700 hover:text-orange-300 disabled:opacity-40"
                  >
                    <XCircle className="h-3 w-3" /> Dismiss
                  </button>
                </div>
              </div>
              {finding.detail && (
                <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap border-t border-[#292824] pt-3 text-[10px] leading-4 text-dim">
                  {finding.detail}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SchedulesList({
  schedules,
  busyId,
  onRunNow,
  onToggle,
  onDelete,
}: {
  schedules: MaintenanceSchedule[];
  busyId: string | null;
  onRunNow: (schedule: MaintenanceSchedule) => void;
  onToggle: (schedule: MaintenanceSchedule) => void;
  onDelete: (schedule: MaintenanceSchedule) => void;
}) {
  return (
    <section className="control-panel p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="eyebrow">Automation</p>
          <h2 className="mt-2 text-lg font-semibold text-white">Schedules</h2>
        </div>
        <Radar className="h-4 w-4 text-signal" />
      </div>
      {schedules.length === 0 ? (
        <p className="text-xs text-dim">No schedules yet. Create one below to start proposing work.</p>
      ) : (
        <ul className="space-y-2">
          {schedules.map((schedule) => (
            <li
              key={schedule.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-[#292824] bg-white/[0.015] p-3"
            >
              <div className="min-w-0">
                <p className="text-xs text-terminal">{schedule.name}</p>
                <p className="mt-1 text-[9px] uppercase tracking-wider text-dim">
                  {DETECTOR_LABELS[schedule.detector_kind]} · every {formatInterval(schedule.interval_seconds)}
                  {schedule.last_status ? ` · last ${schedule.last_status}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`text-[9px] font-bold uppercase ${schedule.enabled ? "text-phosphor" : "text-dim"}`}
                >
                  {schedule.enabled ? "Enabled" : "Paused"}
                </span>
                <button
                  onClick={() => onRunNow(schedule)}
                  disabled={busyId === schedule.id}
                  title="Run now"
                  className="inline-flex items-center gap-1 border border-[#292824] px-2 py-1 text-[9px] uppercase text-dim hover:border-signal hover:text-signal disabled:opacity-40"
                >
                  <Play className="h-3 w-3" /> Run
                </button>
                <button
                  onClick={() => onToggle(schedule)}
                  disabled={busyId === schedule.id}
                  className="border border-[#292824] px-2 py-1 text-[9px] uppercase text-dim hover:border-signal hover:text-signal disabled:opacity-40"
                >
                  {schedule.enabled ? "Pause" : "Enable"}
                </button>
                <button
                  onClick={() => onDelete(schedule)}
                  disabled={busyId === schedule.id}
                  title="Delete schedule"
                  className="border border-[#292824] p-1 text-dim hover:border-orange-700 hover:text-orange-300 disabled:opacity-40"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RunsList({ runs }: { runs: MaintenanceRun[] }) {
  if (runs.length === 0) return null;
  return (
    <section className="control-panel p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="eyebrow">History</p>
        <Clock className="h-4 w-4 text-signal" />
      </div>
      <ul className="divide-y divide-[#292824] text-[10px]">
        {runs.slice(0, 12).map((run) => (
          <li key={run.id} className="flex items-center justify-between py-2">
            <span className="text-dim">{DETECTOR_LABELS[run.detector_kind]}</span>
            <span className="flex items-center gap-2">
              <span className="text-dim">{run.findings_created} found</span>
              <RunStatusBadge status={run.status} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunStatusBadge({ status }: { status: MaintenanceRun["status"] }) {
  const styles: Record<MaintenanceRun["status"], string> = {
    running: "text-signal",
    succeeded: "text-phosphor",
    failed: "text-orange-300",
    skipped: "text-dim",
  };
  return <span className={`font-bold uppercase ${styles[status]}`}>{status}</span>;
}

export function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
