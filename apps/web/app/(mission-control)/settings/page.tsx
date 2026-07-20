"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Cpu, Plus, Radar, RefreshCw, Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useAdminToken } from "@/features/auth/use-admin-token";
import {
  catalogApi,
  type ProviderStatus,
  type SandboxStatus,
  type WorkflowSettings,
} from "@/features/catalog/api";
import { ProviderConnectionCard } from "@/features/catalog/provider-connection";
import { CustomProviderForm } from "@/features/catalog/custom-provider-form";
import {
  buildProviderOptions,
  ProviderSelect,
  type ProviderOption,
} from "@/features/catalog/provider-options";

const defaults: WorkflowSettings = {
  planner_provider: "codex",
  planner_model: null,
  require_plan_approval: true,
  require_execution_approval: true,
  auto_assign_tasks: true,
  max_planning_tasks: 20,
  max_parallel_tasks: 3,
  provider_timeout_seconds: 1800,
  enable_provider_fallback: true,
  allow_repository_writes: false,
  retain_invocation_output: true,
  enable_continuous_operations: false,
  scheduler_poll_seconds: 30,
};

export default function SettingsPage() {
  const { token } = useAdminToken();
  const [standards, setStandards] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowSettings>(defaults);
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [sandboxes, setSandboxes] = useState<SandboxStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // null = closed; "create" = new provider; {edit} = editing an existing HTTP provider.
  const [form, setForm] = useState<null | "create" | { edit: string }>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [coding, configured, providerData, sandboxData] = await Promise.all([
        catalogApi.codingStandards(token),
        catalogApi.workflowSettings(token),
        catalogApi.providers(token),
        catalogApi.sandboxes(token).catch(() => null),
      ]);
      setStandards(coding.value);
      setWorkflow(configured);
      setProviders(providerData.providers);
      setSandboxes(sandboxData);
      setError("");
      setMessage("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load settings");
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const refreshProviders = useCallback(async () => {
    if (!token) return;
    try {
      setProviders((await catalogApi.providers(token)).providers);
    } catch {
      // Keep the last known provider status when the gateway is briefly unreachable.
    }
  }, [token]);

  const deleteProvider = useCallback(async (name: string) => {
    if (!token) return;
    if (!window.confirm(`Delete custom provider "${name}"? This cannot be undone.`)) return;
    try {
      setProviders((await catalogApi.deleteCustomProvider(token, name)).providers);
      setMessage(`Deleted ${name}.`);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete provider");
    }
  }, [token]);

  const save = async () => {
    try {
      const [coding, configured] = await Promise.all([
        catalogApi.updateCodingStandards(token, standards),
        catalogApi.updateWorkflowSettings(token, workflow),
      ]);
      setStandards(coding.value);
      setWorkflow(configured);
      setMessage("All settings saved.");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save settings");
    }
  };

  if (!token) return <ModulePlaceholder eyebrow="Configuration" title="Settings" description="Enter the local admin token to manage Mission Control." icon={SlidersHorizontal} />;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow mb-3">Configuration</p><h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Settings</h1><p className="mt-2 text-xs text-dim">Provider routing, workflow limits, safety gates, retention, and organization standards.</p></div><div className="flex gap-2"><button onClick={load} className="inline-flex items-center gap-2 border border-[#292824] px-4 py-2 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal"><RefreshCw className="h-3 w-3" /> Reload</button><button onClick={save} className="inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black"><Save className="h-3 w-3" /> Save all</button></div></div>
      {error && <p className="mt-4 text-xs text-orange-300">{error}</p>}
      {message && <p className="mt-4 text-xs text-signal">{message}</p>}

      <section className="mt-6 grid gap-4 xl:grid-cols-2">
        <Panel icon={Cpu} eyebrow="Providers" title="Routing and models">
          <div className="grid gap-4 sm:grid-cols-2">
            <ProviderFields title="Planning" provider={workflow.planner_provider} model={workflow.planner_model} options={buildProviderOptions(providers)} onProvider={(planner_provider) => setWorkflow({ ...workflow, planner_provider })} onModel={(planner_model) => setWorkflow({ ...workflow, planner_model })} />
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <ProviderConnectionCard provider="codex" status={providers.codex} token={token} onAuthenticated={refreshProviders} />
            <ProviderConnectionCard provider="claude" status={providers.claude} token={token} onAuthenticated={refreshProviders} />
            {httpProviderEntries(providers).map(({ name, status }) => (
              <ProviderConnectionCard
                key={name}
                provider={name}
                status={status}
                token={token}
                onAuthenticated={refreshProviders}
                onEdit={() => setForm({ edit: name })}
                onDelete={() => void deleteProvider(name)}
              />
            ))}
          </div>
          {form ? (
            <div className="mt-5">
              <CustomProviderForm
                mode={form === "create" ? "create" : "update"}
                initial={form === "create" ? undefined : httpProviderInitial(providers, form.edit)}
                token={token}
                onSaved={() => { setForm(null); void refreshProviders(); }}
                onCancel={() => setForm(null)}
              />
            </div>
          ) : (
            <button onClick={() => setForm("create")} className="mt-5 inline-flex items-center gap-2 border border-[#292824] px-4 py-2 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal">
              <Plus className="h-3 w-3" /> Add custom provider
            </button>
          )}
          <p className="mt-4 text-[10px] leading-5 text-dim">Connect starts the provider&apos;s own sign-in flow inside the gateway container. Credentials stay in the gateway volume and survive rebuilds; they are never displayed or stored by the dashboard.</p>
        </Panel>

        <Panel icon={SlidersHorizontal} eyebrow="Workflow" title="Planning and execution">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label="Maximum plan tasks" value={workflow.max_planning_tasks} min={1} max={50} onChange={(max_planning_tasks) => setWorkflow({ ...workflow, max_planning_tasks })} />
            <NumberField label="Parallel task limit" value={workflow.max_parallel_tasks} min={1} max={5} onChange={(max_parallel_tasks) => setWorkflow({ ...workflow, max_parallel_tasks })} />
            <NumberField label="Provider timeout (sec)" value={workflow.provider_timeout_seconds} min={30} max={1800} onChange={(provider_timeout_seconds) => setWorkflow({ ...workflow, provider_timeout_seconds })} />
          </div>
          <div className="mt-5 space-y-3"><Toggle label="Automatically assign generated tasks" detail="Match each task role to the first enabled agent with that role." checked={workflow.auto_assign_tasks} onChange={(auto_assign_tasks) => setWorkflow({ ...workflow, auto_assign_tasks })} /><Toggle label="Provider fallback" detail="Try the other connected provider once when the primary provider fails or returns unusable structured output." checked={workflow.enable_provider_fallback} onChange={(enable_provider_fallback) => setWorkflow({ ...workflow, enable_provider_fallback })} /><Toggle label="Retain provider output excerpts" detail="Store up to 4,000 characters with invocation history for diagnostics." checked={workflow.retain_invocation_output} onChange={(retain_invocation_output) => setWorkflow({ ...workflow, retain_invocation_output })} /></div>
        </Panel>

        <Panel icon={ShieldCheck} eyebrow="Safety" title="Execution controls">
          <div className="space-y-3">
            <Toggle label="Require plan approval" detail="Review the generated plan before the Build project action becomes available." checked={workflow.require_plan_approval} onChange={(require_plan_approval) => setWorkflow({ ...workflow, require_plan_approval })} />
            <Toggle label="Allow repository writes" detail="Global kill switch for agent edits. Builds are refused while this is disabled." checked={workflow.allow_repository_writes} onChange={(allow_repository_writes) => setWorkflow({ ...workflow, allow_repository_writes })} warning />
            <Toggle label="Require execution approval" detail="After Build project is pressed, require a separate approval before agents can edit files." checked={workflow.require_execution_approval} onChange={(require_execution_approval) => setWorkflow({ ...workflow, require_execution_approval })} />
          </div>
          <p className="mt-4 text-[10px] leading-5 text-dim">Agent profiles control the provider and model used for their assigned tasks.</p>
        </Panel>

        <Panel icon={Box} eyebrow="Isolation" title="Disposable execution containers">
          <div className="flex items-center justify-between border border-[#292824] p-3">
            <span className="text-xs text-terminal">Sandbox supervisor</span>
            <span className={`text-[9px] font-bold uppercase ${sandboxes?.status === "operational" ? "text-phosphor" : "text-orange-300"}`}>
              {sandboxes?.status ?? "unavailable"}
            </span>
          </div>
          <p className="mt-3 text-[10px] leading-5 text-dim">
            Every provider invocation and project command starts in a fresh container and is
            removed on completion, timeout, or disconnect. Runtime commands are offline and
            credential-free; provider sandboxes receive only the provider credential volumes.
          </p>
          {sandboxes?.limits && (
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="border border-[#292824] p-2"><dt className="text-[9px] uppercase text-dim">Memory</dt><dd className="mt-1 text-xs text-terminal">{sandboxes.limits.memory}</dd></div>
              <div className="border border-[#292824] p-2"><dt className="text-[9px] uppercase text-dim">CPUs</dt><dd className="mt-1 text-xs text-terminal">{sandboxes.limits.cpus}</dd></div>
              <div className="border border-[#292824] p-2"><dt className="text-[9px] uppercase text-dim">PIDs</dt><dd className="mt-1 text-xs text-terminal">{sandboxes.limits.pids}</dd></div>
            </dl>
          )}
          <p className="mt-3 text-[10px] text-dim">
            Active containers: {sandboxes?.activeSandboxes.length ?? 0}. Limits are controlled
            by SANDBOX_MEMORY, SANDBOX_CPUS, and SANDBOX_PIDS in the deployment environment.
          </p>
        </Panel>

        <Panel icon={Radar} eyebrow="Continuous operations" title="Unattended maintenance">
          <div className="space-y-3">
            <Toggle label="Enable continuous operations" detail="Let scheduled maintenance checks run unattended and propose work. Findings still require your approval before anything executes." checked={workflow.enable_continuous_operations} onChange={(enable_continuous_operations) => setWorkflow({ ...workflow, enable_continuous_operations })} warning />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <NumberField label="Scheduler poll (sec)" value={workflow.scheduler_poll_seconds} min={5} max={3600} onChange={(scheduler_poll_seconds) => setWorkflow({ ...workflow, scheduler_poll_seconds })} />
          </div>
          <p className="mt-4 text-[10px] leading-5 text-dim">Configure and review schedules and findings on the Operations page. Continuous operations is off by default; nothing runs unattended until you enable it here.</p>
        </Panel>

        <Panel icon={Save} eyebrow="Standards" title="Global coding standards">
          <p className="mb-3 text-[10px] leading-5 text-dim">Applied to all agents and projects. Project memory and agent-specific instructions take precedence when they are more specific.</p>
          <textarea value={standards} onChange={(event) => setStandards(event.target.value)} placeholder={"- Add tests for changed behavior\n- Prefer small, typed functions\n- Never commit secrets\n- Use conventional commits"} rows={15} className="field font-mono leading-5" />
        </Panel>
      </section>
    </div>
  );
}

function Panel({ icon: Icon, eyebrow, title, children }: { icon: React.ComponentType<{ className?: string }>; eyebrow: string; title: string; children: React.ReactNode }) { return <article className="control-panel p-5"><div className="mb-5 flex items-center justify-between"><div><p className="eyebrow">{eyebrow}</p><h2 className="mt-2 text-sm font-semibold text-terminal">{title}</h2></div><Icon className="h-4 w-4 text-signal" /></div>{children}</article>; }

function httpProviderEntries(providers: Record<string, ProviderStatus>): { name: string; status: ProviderStatus }[] {
  return Object.entries(providers)
    .filter(([, status]) => status?.kind === "http")
    .map(([name, status]) => ({ name, status }));
}

function httpProviderInitial(
  providers: Record<string, ProviderStatus>,
  name: string,
) {
  const status = providers[name];
  return {
    name,
    format: (status?.format === "anthropic" ? "anthropic" : "openai") as "openai" | "anthropic",
    base_url: status?.base_url ?? "",
    model: status?.model ?? "",
    max_tokens: status?.max_tokens ?? null,
  };
}

function ProviderFields({ title, provider, model, options, onProvider, onModel }: { title: string; provider: string; model: string | null; options: ProviderOption[]; onProvider: (value: string) => void; onModel: (value: string | null) => void }) {
  return (
    <div>
      <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-terminal">{title}</p>
      <label className="block text-[10px] uppercase text-dim">Provider
        <ProviderSelect options={options} value={provider} onChange={onProvider} className="field mt-2" />
      </label>
      <label className="mt-3 block text-[10px] uppercase text-dim">Model override<input value={model ?? ""} onChange={(event) => onModel(event.target.value || null)} placeholder="Provider default" className="field mt-2" /></label>
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) { return <label className="block text-[10px] uppercase leading-4 text-dim">{label}<input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} className="field mt-2" /></label>; }

function Toggle({ label, detail, checked, onChange, warning = false }: { label: string; detail: string; checked: boolean; onChange: (value: boolean) => void; warning?: boolean }) { return <label className={`flex cursor-pointer items-start justify-between gap-4 border p-3 ${warning && checked ? "border-orange-700/70 bg-orange-950/20" : "border-[#292824] bg-white/[0.015]"}`}><span><span className="block text-xs text-terminal">{label}</span><span className="mt-1 block text-[10px] leading-4 text-dim">{detail}</span></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 accent-signal" /></label>; }
