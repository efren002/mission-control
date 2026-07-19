"use client";

import { useCallback, useState } from "react";
import { ListChecks } from "lucide-react";
import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useAdminToken } from "@/features/auth/use-admin-token";
import { catalogApi, type Agent, type Task } from "@/features/catalog/api";
import { useVisiblePolling } from "@/lib/use-visible-polling";

export default function TasksPage() {
  const { token } = useAdminToken();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [loadedTasks, loadedAgents] = await Promise.all([
        catalogApi.tasks(token),
        catalogApi.agents(token),
      ]);
      setTasks(loadedTasks);
      setAgents(loadedAgents);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load tasks");
    }
  }, [token]);

  useVisiblePolling(load, 5_000, Boolean(token));

  if (!token) return <ModulePlaceholder eyebrow="Execution" title="Tasks" description="Generated implementation work assigned to controlled agents." icon={ListChecks} />;

  return <div><div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="eyebrow mb-3">Execution</p><h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Tasks</h1><p className="mt-2 text-xs text-dim">Live build progress. Agent assignment is automatic.</p></div><button onClick={load} className="border border-[#292824] px-4 py-2 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal">Refresh</button></div><section className="control-panel mt-6 p-3 sm:p-5">{error && <p className="mb-4 text-xs text-orange-300">{error}</p>}<div className="space-y-2">{tasks.map((task) => { const assigned = agents.find((agent) => agent.id === task.assigned_agent_id); return <div key={task.id} className="grid gap-4 border-t border-[#292824] py-4 md:grid-cols-[1fr_13rem] md:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><span className="break-words text-xs text-terminal">{task.title}</span><span className="text-[9px] uppercase text-signal">{task.agent_role}</span><span className={`text-[9px] uppercase ${task.status === "completed" ? "text-phosphor" : task.status === "failed" || task.status === "blocked" ? "text-orange-300" : task.status === "in_progress" ? "text-signal" : "text-dim"}`}>{task.status.replaceAll("_", " ")}</span></div><p className="mt-1 break-words text-[10px] leading-4 text-dim">{task.description || "No description"}</p></div><div><p className="text-[9px] uppercase tracking-wider text-dim">Agent</p><p className="mt-2 text-xs text-terminal">{assigned?.name ?? "Automatic assignment pending"}</p></div></div>; })}{tasks.length === 0 && <p className="py-12 text-center text-xs text-dim">No generated tasks yet.</p>}</div></section></div>;
}
