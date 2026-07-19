"use client";

import { useCallback, useState } from "react";
import { Pencil, Play, Save, Target, Trash2, X } from "lucide-react";

import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAdminToken } from "@/features/auth/use-admin-token";
import { catalogApi, type Objective, type Project } from "@/features/catalog/api";
import { useVisiblePolling } from "@/lib/use-visible-polling";

const editableStatuses = new Set(["draft", "failed", "rejected"]);

export default function ObjectivesPage() {
  const { token } = useAdminToken();
  const { confirm, confirmDialog } = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!token) return setError("Enter the local admin token in the top bar.");
    try {
      const [loadedProjects, loadedObjectives] = await Promise.all([
        catalogApi.projects(token),
        catalogApi.objectives(token),
      ]);
      setProjects(loadedProjects);
      setObjectives(loadedObjectives);
      if (!projectId && loadedProjects[0]) setProjectId(loadedProjects[0].id);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load objectives");
    }
  }, [token, projectId]);

  useVisiblePolling(load, 5_000, Boolean(token));

  const create = async () => {
    try {
      await catalogApi.createObjective(token, projectId, title, description);
      setTitle("");
      setDescription("");
      setMessage("Objective created.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create objective");
    }
  };

  const plan = async (objectiveId: string) => {
    try {
      await catalogApi.startPlanning(token, objectiveId);
      setMessage("Planning started.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start planning");
    }
  };

  const edit = (objective: Objective) => {
    setEditingId(objective.id);
    setDraftTitle(objective.title);
    setDraftDescription(objective.description ?? "");
  };

  const save = async (objective: Objective) => {
    if (!draftTitle.trim()) return setError("Objective title is required.");
    try {
      await catalogApi.updateObjective(token, objective.id, {
        title: draftTitle.trim(),
        description: draftDescription.trim() || null,
      });
      setEditingId(null);
      setMessage("Objective updated.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update objective");
    }
  };

  const remove = async (objective: Objective) => {
    const accepted = await confirm({
      title: `Delete “${objective.title}”?`,
      message: objective.status === "draft"
        ? "This objective will be permanently deleted."
        : "Its runs, tasks, approvals, events, and invocation links will also be permanently deleted.",
      confirmLabel: "Delete objective",
    });
    if (!accepted) return;
    try {
      await catalogApi.deleteObjective(token, objective.id);
      if (editingId === objective.id) setEditingId(null);
      setMessage("Objective deleted.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete objective");
    }
  };

  if (!token) return <ModulePlaceholder eyebrow="Strategy" title="Objectives" description="High-level outcomes awaiting planning and controlled execution." icon={Target} />;

  return <div>
    <p className="eyebrow mb-3">Strategy</p>
    <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Objectives</h1>
    <p className="mt-2 text-xs text-dim">Turn a business outcome into a controlled planner run.</p>
    <section className="control-panel mt-6 p-3 sm:p-5">
      <div className="grid gap-2">
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="field"><option value="">select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="objective title" className="field" />
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="describe the outcome and acceptance criteria" rows={3} className="field" />
        <button onClick={() => void create()} disabled={!projectId || !title.trim()} className="w-fit bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-40">Create objective</button>
      </div>
      {error && <p className="mt-3 text-xs text-orange-300">{error}</p>}
      {message && <p className="mt-3 text-xs text-signal">{message}</p>}
      <div className="mt-6 space-y-3">
        {objectives.map((objective) => {
          const canEdit = editableStatuses.has(objective.status);
          return <article key={objective.id} className="border-t border-[#292824] py-4">
            {editingId === objective.id ? <div className="grid gap-2"><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} className="field" aria-label="Objective title" /><textarea value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} rows={3} className="field" aria-label="Objective description" /><div className="flex flex-wrap gap-2"><button onClick={() => void save(objective)} className="inline-flex items-center gap-1 border border-signal/50 px-3 py-2 text-[9px] uppercase text-signal"><Save className="h-3 w-3" /> Save</button><button onClick={() => setEditingId(null)} className="inline-flex items-center gap-1 border border-[#292824] px-3 py-2 text-[9px] uppercase text-dim"><X className="h-3 w-3" /> Cancel</button></div></div> : <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-xs font-bold text-terminal">{objective.title}</p><p className="mt-1 break-words text-[10px] text-dim">{objective.description || "No description"}</p><p className="mt-2 text-[9px] text-[#55524c]">{projects.find((project) => project.id === objective.project_id)?.name ?? "Unknown project"}</p></div><div className="flex flex-wrap items-center gap-2"><span className="mr-2 text-[10px] uppercase text-dim">{objective.status}</span>{objective.status === "failed" && <a href="/runs" className="border border-[#292824] px-2 py-2 text-[9px] uppercase text-dim hover:border-signal hover:text-signal">Details</a>}{canEdit && <button onClick={() => edit(objective)} className="border border-[#292824] p-2 text-dim hover:border-signal hover:text-signal" title="Edit objective"><Pencil className="h-3.5 w-3.5" /></button>}{canEdit && <button onClick={() => void plan(objective.id)} className="inline-flex items-center gap-1 border border-signal/50 px-2 py-2 text-[9px] uppercase text-signal hover:bg-signal hover:text-black"><Play className="h-3 w-3" /> {objective.status === "draft" ? "Plan" : "Retry"}</button>}{objective.status !== "planning" && <button onClick={() => void remove(objective)} className="border border-[#292824] p-2 text-dim hover:border-red-700 hover:text-red-400" title="Delete objective"><Trash2 className="h-3.5 w-3.5" /></button>}</div></div>}
          </article>;
        })}
        {objectives.length === 0 && <p className="py-10 text-center text-xs text-dim">No objectives yet.</p>}
      </div>
    </section>
    {confirmDialog}
  </div>;
}
