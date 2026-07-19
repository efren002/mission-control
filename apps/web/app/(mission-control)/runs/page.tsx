"use client";

import { useCallback, useState } from "react";
import { Activity } from "lucide-react";

import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useAdminToken } from "@/features/auth/use-admin-token";
import { catalogApi, type Repository, type Run, type RunDetail } from "@/features/catalog/api";
import { useVisiblePolling } from "@/lib/use-visible-polling";

export default function RunsPage() {
  const { token } = useAdminToken();
  const [runs, setRuns] = useState<Run[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [error, setError] = useState("");

  const openRun = useCallback(async (runId: string) => {
    try {
      setDetail(await catalogApi.run(token, runId));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load run");
    }
  }, [token]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [loaded, loadedRepositories] = await Promise.all([
        catalogApi.runs(token),
        catalogApi.repositories(token),
      ]);
      setRuns(loaded);
      setRepositories(loadedRepositories);
      if (loaded[0]) await openRun(detail?.id ?? loaded[0].id);
      else setDetail(null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load runs");
    }
  }, [token, openRun, detail?.id]);

  useVisiblePolling(load, 5_000, Boolean(token));

  if (!token) return <ModulePlaceholder eyebrow="Operations" title="Runs" description="Enter the local admin token to inspect workflow history." icon={Activity} />;

  return <div>
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="eyebrow mb-3">Operations</p><h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Runs</h1><p className="mt-2 text-xs text-dim">Durable planning timelines, tasks, approvals, and provider activity.</p></div><button onClick={() => void load()} className="border border-[#292824] px-4 py-2 text-[10px] uppercase text-dim hover:border-signal hover:text-signal">Refresh</button></div>
    {error && <p className="mt-4 text-xs text-orange-300">{error}</p>}
    <section className="mt-6 grid gap-4 xl:grid-cols-[22rem_1fr]">
      <article className="control-panel p-4"><p className="eyebrow">Run history</p><div className="mt-4 space-y-2">{runs.map((run) => <button key={run.id} onClick={() => void openRun(run.id)} className={`w-full border p-3 text-left ${detail?.id === run.id ? "border-signal/60 bg-signal/[0.04]" : "border-[#292824] hover:border-[#55524c]"}`}><div className="flex items-start justify-between gap-3"><span className="text-xs font-semibold text-terminal">{run.objective_title}</span><Status value={run.status} /></div><p className="mt-2 font-mono text-[9px] text-dim">{run.task_count} tasks · {new Date(run.created_at).toLocaleString()}</p></button>)}{runs.length === 0 && <p className="py-10 text-center text-xs text-dim">No runs yet.</p>}</div></article>
      <article className="control-panel min-h-[28rem] p-3 sm:p-5">{detail ? <RunView key={detail.id} run={detail} repositories={repositories.filter((item) => item.project_id === detail.project_id)} token={token} reload={() => load()} /> : <p className="grid min-h-[24rem] place-items-center text-xs text-dim">Select a run.</p>}</article>
    </section>
  </div>;
}

function RunView({ run, repositories, token, reload }: { run: RunDetail; repositories: Repository[]; token: string; reload: () => Promise<void> }) {
  const [repositoryId, setRepositoryId] = useState(run.repository_id ?? repositories[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = async () => {
    setBusy(true);
    try {
      await catalogApi.startExecution(token, run.id, repositoryId || null);
      setError("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start execution");
    } finally {
      setBusy(false);
    }
  };
  return <div>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="eyebrow">Run detail</p><h2 className="mt-2 break-words text-lg font-semibold text-terminal">{run.objective_title}</h2><p className="mt-1 break-all font-mono text-[9px] text-dim">{run.id}</p></div><div className="text-left sm:text-right"><Status value={run.status} /><p className="mt-2 text-[9px] uppercase text-dim">{run.current_step ?? "No current step"}</p></div></div>
    {run.status === "completed" && run.current_step === "planned" && <section className="mt-6 border border-signal/30 bg-signal/[0.03] p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-signal">Ready to build</p><p className="mt-2 text-[10px] text-dim">This starts the assigned agents and authorizes them to edit the project files. Progress will appear below automatically.</p><div className="mt-3 flex flex-wrap items-center gap-3">{repositories.length > 1 ? <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} className="field max-w-sm">{repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select> : <span className="text-[10px] text-terminal">{repositories[0] ? `Repository: ${repositories[0].name}` : "A project repository will be created automatically."}</span>}<button disabled={busy} onClick={() => void start()} className="bg-signal px-5 py-2 text-[10px] font-bold uppercase text-black disabled:opacity-40">{busy ? "Starting build…" : "Build project"}</button></div>{error && <p className="mt-3 text-xs text-orange-300">{error}</p>}</section>}
    {run.status === "awaiting_execution_approval" && <p className="mt-6 border border-signal/30 p-4 text-xs text-signal">Execution is waiting for approval. Open Approvals to authorize repository changes.</p>}
    {run.repository_id && <p className="mt-4 text-[10px] text-dim">Repository: <span className="text-terminal">{repositories.find((item) => item.id === run.repository_id)?.path ?? run.repository_id}</span></p>}
    <Section title={`Tasks (${run.tasks.length})`}>{run.tasks.length ? run.tasks.map((task) => <div key={task.id} className="border-t border-[#292824] py-3"><div className="flex flex-wrap gap-3"><span className="text-xs text-terminal">{task.title}</span><span className="text-[9px] uppercase text-signal">{task.agent_role}</span><span className="text-[9px] uppercase text-dim">{task.status}</span>{task.checkpoint_sha && <span className="font-mono text-[9px] text-dim" title="Checkpoint commit">{task.checkpoint_sha.slice(0, 10)}</span>}</div><p className="mt-1 text-[10px] leading-4 text-dim">{task.description || "No description"}</p></div>) : <Empty text="No tasks were generated." />}</Section>
    <Section title={`Timeline (${run.events.length})`}>{run.events.length ? run.events.map((event) => <div key={event.id} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-t border-[#292824] py-3 text-[10px] sm:grid-cols-[2rem_minmax(0,1fr)_auto]"><span className="font-mono text-dim">{event.sequence}</span><div className="min-w-0"><p className="break-words uppercase text-terminal">{event.event_type.replaceAll(".", " ")}</p>{Object.keys(event.payload).length > 0 && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-dim">{JSON.stringify(event.payload, null, 2)}</pre>}</div><span className="col-start-2 text-dim sm:col-start-auto">{new Date(event.created_at).toLocaleString()}</span></div>) : <Empty text="No persisted events for this run." />}</Section>
    <Section title={`Provider activity (${run.invocations.length})`}>{run.invocations.length ? run.invocations.map((item) => <details key={item.id} className="border-t border-[#292824] py-3 text-[10px]"><summary className="cursor-pointer text-terminal">{item.agent_name} · {item.purpose.replaceAll("_", " ")} · <span className="text-dim">{item.status}</span></summary>{item.input_excerpt && <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap border-l border-[#292824] pl-3 text-dim">INPUT{"\n"}{item.input_excerpt}</pre>}{item.output_excerpt && <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap border-l border-[#292824] pl-3 text-dim">OUTPUT{"\n"}{item.output_excerpt}</pre>}{item.error && <p className="mt-3 text-orange-300">{item.error}</p>}</details>) : <Empty text="No provider invocations are linked to this run." />}</Section>
  </div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-7"><h3 className="text-[10px] font-bold uppercase tracking-wider text-signal">{title}</h3><div className="mt-2">{children}</div></section>;
}

function Empty({ text }: { text: string }) { return <p className="border-t border-[#292824] py-5 text-xs text-dim">{text}</p>; }
function Status({ value }: { value: string }) { return <span className={`text-[9px] font-bold uppercase ${value === "completed" || value === "approved" ? "text-phosphor" : value === "failed" || value === "rejected" ? "text-orange-300" : "text-signal"}`}>{value.replaceAll("_", " ")}</span>; }
