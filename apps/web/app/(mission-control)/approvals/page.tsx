"use client";

import {
  Check,
  CheckCircle2,
  Clock3,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";

import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useAdminToken } from "@/features/auth/use-admin-token";
import {
  catalogApi,
  type Approval,
  type RunDetail,
} from "@/features/catalog/api";
import { cn } from "@/lib/cn";
import { useVisiblePolling } from "@/lib/use-visible-polling";

type Decision = "approve" | "reject";

const statusStyles = {
  pending: "border-signal/30 bg-signal/[0.07] text-signal",
  approved: "border-phosphor/30 bg-phosphor/[0.07] text-phosphor",
  rejected: "border-orange-400/30 bg-orange-400/[0.07] text-orange-300",
} as const;

export default function ApprovalsPage() {
  const { token } = useAdminToken();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<Approval | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);

  const open = useCallback(
    async (approval: Approval, showLoading = true) => {
      setSelected(approval);
      if (showLoading) setLoadingRun(true);
      try {
        setRun(await catalogApi.run(token, approval.run_id));
        setError("");
      } catch (cause) {
        setRun(null);
        setError(
          cause instanceof Error ? cause.message : "Unable to load approval",
        );
      } finally {
        setLoadingRun(false);
      }
    },
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const loaded = await catalogApi.approvals(token);
      setApprovals(loaded);
      const target =
        loaded.find((item) => item.id === selected?.id) ??
        loaded.find((item) => item.status === "pending") ??
        loaded[0];

      if (target) {
        await open(target, target.id !== selected?.id);
      } else {
        setSelected(null);
        setRun(null);
      }
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load approvals",
      );
    }
  }, [token, selected?.id, open]);

  useVisiblePolling(load, 5_000, Boolean(token));

  const decide = async (decision: Decision) => {
    if (!selected) return;
    setBusy(true);
    try {
      await catalogApi.decideApproval(token, selected.id, decision, reason);
      setReason("");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to decide approval",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <ModulePlaceholder
        eyebrow="Human control"
        title="Approvals"
        description="Enter the local admin token to review workflow gates."
        icon={CheckCircle2}
      />
    );
  }

  const pendingCount = approvals.filter(
    (item) => item.status === "pending",
  ).length;

  return (
    <div>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-2">Human control</p>
          <h1 className="text-xl font-bold tracking-[-0.035em] text-terminal sm:text-2xl">
            Approvals
          </h1>
          <p className="mt-1.5 max-w-xl text-[11px] leading-5 text-dim">
            Review proposed work before agents can change a repository.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="group flex h-8 items-center gap-2 self-start border border-[#292824] px-3 text-[9px] font-bold uppercase tracking-wider text-dim transition hover:border-signal/50 hover:text-signal sm:self-auto"
        >
          <RefreshCw className="h-3 w-3 transition-transform group-active:rotate-180" />
          Refresh
        </button>
      </header>

      {error && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 border border-orange-700/40 bg-orange-900/10 px-3 py-2.5 text-[11px] leading-4 text-orange-200"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <section className="mt-5 grid items-start gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <ApprovalQueue
          approvals={approvals}
          pendingCount={pendingCount}
          selectedId={selected?.id}
          onSelect={open}
        />
        <ApprovalReview
          approval={selected}
          run={run}
          reason={reason}
          busy={busy}
          loading={loadingRun}
          onReasonChange={setReason}
          onDecide={decide}
        />
      </section>
    </div>
  );
}

function ApprovalQueue({
  approvals,
  pendingCount,
  selectedId,
  onSelect,
}: {
  approvals: Approval[];
  pendingCount: number;
  selectedId?: string;
  onSelect: (approval: Approval) => Promise<void>;
}) {
  return (
    <aside className="control-panel overflow-hidden lg:sticky lg:top-20">
      <div className="flex h-11 items-center justify-between border-b border-[#292824] px-3.5">
        <div className="flex items-center gap-2">
          <ListChecks className="h-3.5 w-3.5 text-signal" />
          <h2 className="text-[9px] font-bold uppercase tracking-[0.16em] text-terminal">
            Review queue
          </h2>
        </div>
        <span className="text-[8px] uppercase tracking-wider text-dim">
          {pendingCount} pending
        </span>
      </div>

      <div className="max-h-[calc(100vh-10rem)] space-y-1.5 overflow-y-auto p-2">
        {approvals.map((approval) => {
          const active = selectedId === approval.id;
          return (
            <button
              type="button"
              key={approval.id}
              onClick={() => void onSelect(approval)}
              aria-pressed={active}
              className={cn(
                "w-full border px-3 py-2.5 text-left transition",
                active
                  ? "border-signal/50 bg-signal/[0.045]"
                  : "border-transparent hover:border-[#34322d] hover:bg-white/[0.02]",
              )}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <span className="min-w-0 truncate text-[11px] font-semibold leading-4 text-terminal">
                  {approval.objective_title}
                </span>
                <StatusBadge status={approval.status} />
              </div>
              <p className="mt-1.5 text-[8px] uppercase tracking-[0.12em] text-dim">
                {approval.kind} · {approval.task_count}{" "}
                {approval.task_count === 1 ? "task" : "tasks"}
              </p>
            </button>
          );
        })}

        {approvals.length === 0 && (
          <div className="grid min-h-44 place-items-center px-4 text-center">
            <div>
              <CheckCircle2 className="mx-auto h-5 w-5 text-[#55524c]" />
              <p className="mt-2 text-[11px] text-terminal">Queue is clear</p>
              <p className="mt-1 text-[9px] text-dim">
                New approval requests will appear here.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function ApprovalReview({
  approval,
  run,
  reason,
  busy,
  loading,
  onReasonChange,
  onDecide,
}: {
  approval: Approval | null;
  run: RunDetail | null;
  reason: string;
  busy: boolean;
  loading: boolean;
  onReasonChange: (reason: string) => void;
  onDecide: (decision: Decision) => Promise<void>;
}) {
  if (!approval) {
    return (
      <article className="control-panel grid min-h-[28rem] place-items-center p-6 text-center">
        <div>
          <ListChecks className="mx-auto h-6 w-6 text-[#55524c]" />
          <p className="mt-3 text-xs text-terminal">Select an approval</p>
          <p className="mt-1 text-[10px] text-dim">
            Choose a request from the review queue.
          </p>
        </div>
      </article>
    );
  }

  if (loading || !run) {
    return (
      <article className="control-panel min-h-[28rem] p-4 sm:p-5">
        <div className="h-2.5 w-24 skeleton" />
        <div className="mt-4 h-5 w-52 skeleton" />
        <div className="mt-8 space-y-3">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="border-t border-[#292824] py-3">
              <div className="h-3 w-2/5 skeleton" />
              <div className="mt-2 h-2.5 w-4/5 skeleton" />
            </div>
          ))}
        </div>
      </article>
    );
  }

  const isExecution = approval.kind === "execution";

  return (
    <article className="control-panel min-h-[28rem] overflow-hidden">
      <div className="border-b border-[#292824] px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">
              {isExecution ? "Execution review" : "Plan review"}
            </p>
            <h2 className="mt-2 break-words text-base font-semibold leading-6 text-terminal">
              {approval.objective_title}
            </h2>
            <p className="mt-1 truncate font-mono text-[8px] text-dim">
              Run {approval.run_id}
            </p>
          </div>
          <StatusBadge status={approval.status} />
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        {isExecution && (
          <div className="flex gap-3 border border-orange-700/40 bg-orange-900/10 p-3">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-300" />
            <p className="text-[10px] leading-[1.125rem] text-orange-100/90">
              Approval grants assigned agents permission to edit the registered
              repository and run project commands.
            </p>
          </div>
        )}

        <section className="mt-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h3 className="text-[9px] font-bold uppercase tracking-[0.16em] text-terminal">
                {isExecution ? "Execution tasks" : "Proposed tasks"}
              </h3>
              <p className="mt-1 text-[9px] text-dim">
                {run.tasks.length} {run.tasks.length === 1 ? "step" : "steps"}{" "}
                included in this request
              </p>
            </div>
          </div>

          <div className="mt-3 border-y border-[#292824]">
            {run.tasks.map((task, index) => (
              <div
                key={task.id}
                className="grid gap-2 border-b border-[#292824] py-3 last:border-b-0 sm:grid-cols-[1.5rem_minmax(0,1fr)]"
              >
                <span className="hidden pt-0.5 font-mono text-[9px] text-[#55524c] sm:block">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h4 className="break-words text-[11px] font-medium leading-4 text-terminal">
                      {task.title}
                    </h4>
                    <span className="border border-[#34322d] px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-wider text-signal">
                      {task.agent_role}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-[9px] leading-4 text-dim">
                    {task.description || "No description provided."}
                  </p>
                </div>
              </div>
            ))}

            {run.tasks.length === 0 && (
              <div className="flex items-start gap-2 py-4 text-[10px] text-orange-300">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This run contains no tasks and cannot be approved.
              </div>
            )}
          </div>
        </section>

        {approval.status === "pending" ? (
          <section className="mt-5">
            <label
              htmlFor="approval-reason"
              className="text-[9px] font-bold uppercase tracking-[0.14em] text-terminal"
            >
              Decision note{" "}
              <span className="font-normal normal-case tracking-normal text-dim">
                (optional)
              </span>
            </label>
            <textarea
              id="approval-reason"
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              rows={3}
              placeholder="Add context for this decision…"
              className="field mt-2 resize-y text-[10px] leading-4"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || run.tasks.length === 0}
                onClick={() => void onDecide("approve")}
                className="flex h-8 items-center gap-2 bg-signal px-3.5 text-[9px] font-bold uppercase tracking-wider text-black transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="h-3 w-3" />
                {busy ? "Working…" : `Approve ${approval.kind}`}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onDecide("reject")}
                className="flex h-8 items-center gap-2 border border-orange-700/70 px-3.5 text-[9px] font-bold uppercase tracking-wider text-orange-300 transition hover:border-orange-500 hover:bg-orange-900/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-3 w-3" />
                Reject {approval.kind}
              </button>
            </div>
          </section>
        ) : (
          <DecisionSummary approval={approval} />
        )}
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: Approval["status"] }) {
  const Icon =
    status === "approved" ? Check : status === "rejected" ? X : Clock3;
  const style =
    status === "approved"
      ? statusStyles.approved
      : status === "rejected"
        ? statusStyles.rejected
        : statusStyles.pending;

  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 border px-1.5 text-[8px] font-bold uppercase tracking-[0.1em]",
        style,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {status}
    </span>
  );
}

function DecisionSummary({ approval }: { approval: Approval }) {
  return (
    <section className="mt-5 border-t border-[#292824] pt-4">
      <div className="flex items-center gap-2">
        <StatusBadge status={approval.status} />
        {approval.decided_at && (
          <time className="text-[9px] text-dim">
            {new Date(approval.decided_at).toLocaleString()}
          </time>
        )}
      </div>
      {approval.decision_reason && (
        <p className="mt-2 text-[10px] leading-4 text-dim">
          {approval.decision_reason}
        </p>
      )}
    </section>
  );
}
