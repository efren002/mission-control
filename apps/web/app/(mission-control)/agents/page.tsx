"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  Clock3,
  History,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Terminal,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAdminToken } from "@/features/auth/use-admin-token";
import {
  catalogApi,
  type Agent,
  type AgentInput,
  type AgentInvocation,
} from "@/features/catalog/api";
import { cn } from "@/lib/cn";

const emptyAgent: AgentInput = {
  name: "",
  role: "developer",
  provider: "codex",
  model: null,
  instructions: "",
  enabled: true,
};

const roleDescriptions: Record<AgentInput["role"], string> = {
  planner: "Turns objectives into scoped, ordered execution plans.",
  developer: "Implements assigned work inside the configured repository.",
  qa: "Validates behavior, regressions, and acceptance criteria.",
  reviewer: "Inspects changes for quality, risk, and completeness.",
};

export default function AgentsPage() {
  const { token } = useAdminToken();
  const { confirm, confirmDialog } = useConfirm();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<AgentInput>(emptyAgent);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [history, setHistory] = useState<AgentInvocation[]>([]);
  const [historyAgent, setHistoryAgent] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setAgents(await catalogApi.agents(token));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load agents",
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () => ({
      online: agents.filter((agent) => agent.status === "online").length,
      assignments: agents.reduce(
        (total, agent) => total + agent.assignment_count,
        0,
      ),
      invocations: agents.reduce(
        (total, agent) => total + agent.invocation_count,
        0,
      ),
    }),
    [agents],
  );

  const edit = (agent: Agent) => {
    setEditingId(agent.id);
    setDraft({
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      instructions: agent.instructions,
      enabled: agent.enabled,
    });
    setHistory([]);
    setHistoryAgent("");
    setError("");
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const reset = () => {
    setEditingId(null);
    setDraft(emptyAgent);
    setError("");
  };

  const save = async () => {
    if (!draft.name.trim()) return setError("Agent name is required.");
    setSaving(true);
    try {
      if (editingId) await catalogApi.updateAgent(token, editingId, draft);
      else await catalogApi.createAgent(token, draft);
      setMessage(
        editingId ? "Agent profile updated." : "Agent added to the roster.",
      );
      setError("");
      reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save agent");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (agent: Agent) => {
    const accepted = await confirm({
      title: `Delete ${agent.name}?`,
      message: "Existing task assignments will be cleared.",
      confirmLabel: "Delete agent",
    });
    if (!accepted) return;
    try {
      await catalogApi.deleteAgent(token, agent.id);
      if (editingId === agent.id) reset();
      if (historyAgent === agent.name) setHistoryAgent("");
      setMessage(`${agent.name} removed from the roster.`);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to delete agent",
      );
    }
  };

  const showHistory = async (agent: Agent) => {
    try {
      setHistory(await catalogApi.agentInvocations(token, agent.id));
      setHistoryAgent(agent.name);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to load invocation history",
      );
    }
  };

  const test = async (agent: Agent) => {
    setTestingId(agent.id);
    setMessage(`Opening a test session with ${agent.name}...`);
    try {
      const result = await catalogApi.testAgent(token, agent.id);
      setMessage(
        result.status === "completed"
          ? `${agent.name} responded successfully.`
          : `${agent.name} test failed.`,
      );
      await load();
      await showHistory(agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to test agent");
    } finally {
      setTestingId(null);
    }
  };

  if (!token)
    return (
      <ModulePlaceholder
        eyebrow="Workforce"
        title="Agents"
        description="Enter the local admin token to configure and monitor agents."
        icon={Bot}
      />
    );

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-5 border-b border-[#292824] pb-5 md:flex-row md:items-end">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <p className="eyebrow">Workforce</p>
            <span className="h-px w-8 bg-signal/40" />
            <span className="font-mono text-[9px] uppercase tracking-widest text-[#55524c]">
              Agent registry
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal md:text-3xl">
            Agents
          </h1>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-dim">
            Configure the specialists that plan, build, validate, and review
            work across your missions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex w-fit items-center gap-2 border border-[#34322d] bg-white/[0.015] px-3.5 py-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-dim transition hover:border-signal/60 hover:text-signal disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          {loading ? "Syncing roster" : "Refresh status"}
        </button>
      </header>

      <section
        aria-label="Agent fleet summary"
        className="grid gap-px border border-[#292824] bg-[#292824] sm:grid-cols-2 xl:grid-cols-4"
      >
        <Metric
          label="Configured"
          value={agents.length}
          detail="Specialists in roster"
          icon={Users}
        />
        <Metric
          label="Online now"
          value={totals.online}
          detail={`${agents.length ? Math.round((totals.online / agents.length) * 100) : 0}% availability`}
          icon={Activity}
          active
        />
        <Metric
          label="Assignments"
          value={totals.assignments}
          detail="Current workload"
          icon={Terminal}
        />
        <Metric
          label="Invocations"
          value={totals.invocations}
          detail="Lifetime provider calls"
          icon={Sparkles}
        />
      </section>

      {(error || message) && (
        <div
          role="status"
          className={cn(
            "flex items-center justify-between gap-4 border px-4 py-3 text-xs",
            error
              ? "border-orange-700/40 bg-orange-500/[0.05] text-orange-200"
              : "border-phosphor/25 bg-phosphor/[0.04] text-phosphor",
          )}
        >
          <span className="flex items-center gap-2">
            {error ? (
              <span className="h-1.5 w-1.5 bg-orange-400" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {error || message}
          </span>
          <button
            type="button"
            onClick={() => {
              setError("");
              setMessage("");
            }}
            className="shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <section className="grid items-start gap-4 xl:grid-cols-[minmax(310px,0.72fr)_minmax(560px,1.28fr)]">
        <article className="control-panel overflow-hidden xl:sticky xl:top-20">
          <div className="flex items-start justify-between border-b border-[#292824] bg-white/[0.012] p-4 sm:p-5">
            <div className="flex gap-3">
              <span className="font-mono text-[10px] text-signal">01</span>
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-dim">
                  Agent profile
                </p>
                <h2 className="mt-1.5 text-sm font-semibold text-terminal">
                  {editingId ? "Edit specialist" : "Add a specialist"}
                </h2>
              </div>
            </div>
            {editingId && (
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-dim transition hover:text-signal"
              >
                <Plus className="h-3 w-3" />
                New profile
              </button>
            )}
          </div>

          <div className="p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <Field label="Display name" htmlFor="agent-name">
                <input
                  id="agent-name"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="e.g. Implementation Agent"
                  className="field"
                />
              </Field>
              <Field label="Role" htmlFor="agent-role">
                <select
                  id="agent-role"
                  value={draft.role}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      role: event.target.value as AgentInput["role"],
                    })
                  }
                  className="field"
                >
                  <option value="planner">Planner</option>
                  <option value="developer">Developer</option>
                  <option value="qa">Quality assurance</option>
                  <option value="reviewer">Reviewer</option>
                </select>
              </Field>
              <Field label="Provider" htmlFor="agent-provider">
                <select
                  id="agent-provider"
                  value={draft.provider}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      provider: event.target.value as AgentInput["provider"],
                    })
                  }
                  className="field"
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </Field>
              <Field label="Model override" htmlFor="agent-model">
                <input
                  id="agent-model"
                  value={draft.model ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      model: event.target.value || null,
                    })
                  }
                  placeholder="Provider default"
                  className="field font-mono"
                />
              </Field>
            </div>

            <p className="mt-3 border-l border-signal/40 pl-3 text-[10px] leading-4 text-dim">
              {roleDescriptions[draft.role]}
            </p>

            <Field
              label="Operating instructions"
              htmlFor="agent-instructions"
              className="mt-5"
              hint={`${draft.instructions.length} characters`}
            >
              <textarea
                id="agent-instructions"
                value={draft.instructions}
                onChange={(event) =>
                  setDraft({ ...draft, instructions: event.target.value })
                }
                rows={8}
                placeholder="Define expertise, constraints, working style, and expected outputs..."
                className="field resize-y font-mono leading-5"
              />
            </Field>

            <label className="mt-4 flex cursor-pointer items-center justify-between gap-4 border border-[#292824] bg-white/[0.012] p-3">
              <span>
                <span className="block text-xs text-terminal">
                  Eligible for work
                </span>
                <span className="mt-1 block text-[9px] text-dim">
                  Allow new assignments and provider invocations.
                </span>
              </span>
              <span className="relative shrink-0">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft({ ...draft, enabled: event.target.checked })
                  }
                  className="peer sr-only"
                />
                <span className="block h-5 w-9 border border-[#3a3833] bg-[#151513] transition peer-checked:border-signal/70 peer-checked:bg-signal/15" />
                <span className="absolute left-1 top-1 h-3 w-3 bg-[#55524c] transition-transform peer-checked:translate-x-4 peer-checked:bg-signal" />
              </span>
            </label>

            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !draft.name.trim()}
                className="inline-flex items-center gap-2 bg-signal px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-black transition hover:bg-[#ff6b22] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : editingId ? (
                  <Save className="h-3.5 w-3.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {saving
                  ? "Saving"
                  : editingId
                    ? "Save changes"
                    : "Create agent"}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={reset}
                  className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-dim transition hover:text-terminal"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </article>

        <article className="control-panel overflow-hidden">
          <div className="flex items-start justify-between border-b border-[#292824] bg-white/[0.012] p-4 sm:p-5">
            <div className="flex gap-3">
              <span className="font-mono text-[10px] text-signal">02</span>
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-dim">
                  Active roster
                </p>
                <h2 className="mt-1.5 text-sm font-semibold text-terminal">
                  Configured specialists
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-dim">
              <span className="h-1.5 w-1.5 bg-phosphor shadow-[0_0_7px_#9bbd86]" />
              {totals.online} online
            </div>
          </div>

          <div className="divide-y divide-[#292824]">
            {loading && agents.length === 0
              ? Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="p-4 sm:p-5">
                    <div className="skeleton h-4 w-44" />
                    <div className="skeleton mt-3 h-2.5 w-64" />
                    <div className="skeleton mt-5 h-7 w-full" />
                  </div>
                ))
              : agents.map((agent, index) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    index={index}
                    selected={editingId === agent.id}
                    testing={testingId === agent.id}
                    onEdit={() => edit(agent)}
                    onTest={() => void test(agent)}
                    onHistory={() => void showHistory(agent)}
                    onRemove={() => void remove(agent)}
                  />
                ))}
            {!loading && agents.length === 0 && (
              <div className="px-5 py-16 text-center">
                <span className="mx-auto grid h-12 w-12 place-items-center border border-[#292824] bg-white/[0.015] text-[#55524c]">
                  <Bot className="h-5 w-5" />
                </span>
                <p className="mt-4 text-sm font-semibold text-terminal">
                  Your roster is empty
                </p>
                <p className="mx-auto mt-2 max-w-xs text-[10px] leading-5 text-dim">
                  Start with a planner and developer, then add QA and review
                  coverage as your workflow grows.
                </p>
              </div>
            )}
          </div>
        </article>
      </section>

      {historyAgent && (
        <HistoryPanel
          agentName={historyAgent}
          history={history}
          onClose={() => setHistoryAgent("")}
        />
      )}
      {confirmDialog}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  active = false,
}: {
  label: string;
  value: number;
  detail: string;
  icon: typeof Bot;
  active?: boolean;
}) {
  return (
    <article className="group relative overflow-hidden bg-panel p-4">
      <div className="absolute right-0 top-0 h-12 w-12 bg-signal/[0.025] transition group-hover:bg-signal/[0.05]" />
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-dim">
          {label}
        </p>
        <Icon className="h-3.5 w-3.5 text-signal" />
      </div>
      <div className="mt-5 flex items-end justify-between gap-3">
        <p
          className={cn(
            "font-mono text-2xl font-bold tracking-[-0.06em]",
            active ? "text-phosphor" : "text-terminal",
          )}
        >
          {String(value).padStart(2, "0")}
        </p>
        <p className="pb-0.5 text-right text-[9px] text-dim">{detail}</p>
      </div>
    </article>
  );
}

function AgentCard({
  agent,
  index,
  selected,
  testing,
  onEdit,
  onTest,
  onHistory,
  onRemove,
}: {
  agent: Agent;
  index: number;
  selected: boolean;
  testing: boolean;
  onEdit: () => void;
  onTest: () => void;
  onHistory: () => void;
  onRemove: () => void;
}) {
  const online = agent.status === "online";
  const disabled = agent.status === "disabled";

  return (
    <div
      className={cn(
        "relative p-4 transition-colors sm:p-5",
        selected ? "bg-signal/[0.045]" : "hover:bg-white/[0.012]",
      )}
    >
      {selected && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="relative grid h-10 w-10 shrink-0 place-items-center border border-[#34322d] bg-[#11110f] font-mono text-[10px] font-bold text-terminal">
            {agent.role.slice(0, 2).toUpperCase()}
            <span
              className={cn(
                "absolute -bottom-px -right-px h-2.5 w-2.5 border-2 border-panel",
                online
                  ? "bg-phosphor shadow-[0_0_7px_#9bbd86]"
                  : disabled
                    ? "bg-[#55524c]"
                    : "bg-orange-400",
              )}
            />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onEdit}
                className="truncate text-left text-sm font-semibold text-terminal transition hover:text-signal"
              >
                {agent.name}
              </button>
              {selected && (
                <span className="border border-signal/30 bg-signal/[0.06] px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-signal">
                  Editing
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[9px] font-bold uppercase tracking-[0.13em] text-dim">
              {String(index + 1).padStart(2, "0")} / {agent.role}
              <span className="mx-2 text-[#3d3b36]">·</span>
              {agent.provider}
              <span className="mx-2 text-[#3d3b36]">·</span>
              <span
                className={cn(
                  online
                    ? "text-phosphor"
                    : disabled
                      ? "text-[#66625b]"
                      : "text-orange-300",
                )}
              >
                {agent.status}
              </span>
            </p>
            {agent.provider_version && (
              <p className="mt-1.5 font-mono text-[9px] text-[#55524c]">
                {agent.provider_version}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <ActionButton
            label={testing ? "Testing agent" : "Test agent"}
            onClick={onTest}
            disabled={testing || disabled}
            prominent
          >
            {testing ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </ActionButton>
          <ActionButton label="Edit agent" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton label="Invocation history" onClick={onHistory}>
            <History className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton label="Delete agent" onClick={onRemove} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </ActionButton>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-px border border-[#292824] bg-[#292824]">
        <div className="flex items-center justify-between bg-[#0b0b0a] px-3 py-2">
          <span className="text-[8px] uppercase tracking-widest text-[#66625b]">
            Assignments
          </span>
          <span className="font-mono text-[11px] text-terminal">
            {String(agent.assignment_count).padStart(2, "0")}
          </span>
        </div>
        <div className="flex items-center justify-between bg-[#0b0b0a] px-3 py-2">
          <span className="text-[8px] uppercase tracking-widest text-[#66625b]">
            Invocations
          </span>
          <span className="font-mono text-[11px] text-terminal">
            {String(agent.invocation_count).padStart(2, "0")}
          </span>
        </div>
      </div>

      {agent.capabilities.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[8px] font-bold uppercase tracking-[0.14em] text-[#55524c]">
            Capabilities
          </span>
          {agent.capabilities.map((capability) => (
            <span
              key={capability}
              className="border border-[#292824] bg-white/[0.012] px-2 py-1 text-[8px] uppercase tracking-wider text-dim"
            >
              {capability.replaceAll("_", " ")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  children,
  disabled = false,
  danger = false,
  prominent = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  prominent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid h-8 w-8 place-items-center border transition disabled:cursor-not-allowed disabled:opacity-35",
        danger
          ? "border-[#292824] text-dim hover:border-red-700 hover:text-red-400"
          : prominent
            ? "border-signal/35 bg-signal/[0.05] text-signal hover:bg-signal hover:text-black"
            : "border-[#292824] text-dim hover:border-signal/60 hover:text-signal",
      )}
    >
      {children}
    </button>
  );
}

function HistoryPanel({
  agentName,
  history,
  onClose,
}: {
  agentName: string;
  history: AgentInvocation[];
  onClose: () => void;
}) {
  return (
    <section className="control-panel overflow-hidden">
      <div className="flex items-start justify-between border-b border-[#292824] bg-white/[0.012] p-4 sm:p-5">
        <div className="flex gap-3">
          <span className="font-mono text-[10px] text-signal">03</span>
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-dim">
              Invocation log
            </p>
            <h2 className="mt-1.5 text-sm font-semibold text-terminal">
              {agentName}
            </h2>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center border border-[#292824] text-dim transition hover:border-signal/60 hover:text-signal"
          aria-label="Close invocation history"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="divide-y divide-[#292824]">
        {history.map((item, index) => (
          <div
            key={item.id}
            className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[44px_minmax(0,1fr)_auto]"
          >
            <span className="font-mono text-[10px] text-[#55524c]">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-terminal">
                  {item.purpose.replaceAll("_", " ")}
                </p>
                <span
                  className={cn(
                    "border px-1.5 py-0.5 text-[8px] uppercase tracking-wider",
                    item.status === "completed"
                      ? "border-phosphor/25 text-phosphor"
                      : item.status === "failed"
                        ? "border-orange-700/40 text-orange-300"
                        : "border-signal/30 text-signal",
                  )}
                >
                  {item.status}
                </span>
              </div>
              {item.run_id && (
                <p className="mt-1.5 font-mono text-[9px] text-dim">
                  Run {item.run_id}
                </p>
              )}
              {item.input_excerpt && (
                <HistoryDetails label="Input sent" value={item.input_excerpt} />
              )}
              {item.output_excerpt && (
                <HistoryDetails
                  label="Provider output"
                  value={item.output_excerpt}
                />
              )}
              {item.error && (
                <p className="mt-3 border-l border-orange-500/40 pl-3 text-[10px] leading-5 text-orange-200">
                  {item.error}
                </p>
              )}
              {!item.input_excerpt && !item.output_excerpt && !item.error && (
                <p className="mt-2 text-[9px] text-[#55524c]">
                  No request details were retained.
                </p>
              )}
            </div>
            <div className="flex items-center gap-4 text-[9px] text-dim lg:flex-col lg:items-end lg:gap-1.5">
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="h-3 w-3" />
                {item.duration_ms === null ? "—" : `${item.duration_ms} ms`}
              </span>
              <span>{new Date(item.created_at).toLocaleString()}</span>
            </div>
          </div>
        ))}
        {history.length === 0 && (
          <p className="px-5 py-12 text-center text-xs text-dim">
            No invocations recorded for this agent.
          </p>
        )}
      </div>
    </section>
  );
}

function HistoryDetails({ label, value }: { label: string; value: string }) {
  return (
    <details className="group mt-3 border border-[#292824] bg-[#0a0a09]">
      <summary className="cursor-pointer list-none px-3 py-2 text-[8px] font-bold uppercase tracking-[0.14em] text-dim transition hover:text-signal">
        <span className="inline-flex items-center gap-2">
          <Plus className="h-3 w-3 transition-transform group-open:rotate-45" />
          {label}
        </span>
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-[#292824] p-3 font-mono text-[9px] leading-5 text-dim">
        {value}
      </pre>
    </details>
  );
}

function Field({
  label,
  htmlFor,
  className = "",
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block", className)} htmlFor={htmlFor}>
      <span className="mb-2 flex items-center justify-between text-[9px] font-bold uppercase tracking-[0.13em] text-dim">
        {label}
        {hint && (
          <span className="font-mono text-[8px] font-normal normal-case tracking-normal text-[#55524c]">
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
