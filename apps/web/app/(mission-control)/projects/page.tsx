"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderKanban, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAdminToken } from "@/features/auth/use-admin-token";
import { catalogApi, type Project } from "@/features/catalog/api";

type CommandDraft = { test: string; app: string };

function commandDraftFor(project: Project): CommandDraft {
  return { test: project.test_command ?? "", app: project.app_command ?? "" };
}

export default function ProjectsPage() {
  const { token } = useAdminToken();
  const { confirm, confirmDialog } = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [commandDrafts, setCommandDrafts] = useState<Record<string, CommandDraft>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return setError("Enter the local admin token in the top bar.");
    }
    setLoading(true);
    try {
      const loaded = await catalogApi.projects(token);
      setProjects(loaded);
      setDrafts(Object.fromEntries(loaded.map((project) => [project.id, project.memory])));
      setNameDrafts(Object.fromEntries(loaded.map((project) => [project.id, project.name])));
      setCommandDrafts(Object.fromEntries(loaded.map((project) => [project.id, commandDraftFor(project)])));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load projects");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) void load();
  }, [load, token]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  const create = async () => {
    if (!token) return setError("Enter the local admin token in the top bar.");
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const created = await catalogApi.createProject(token, name.trim());
      setName("");
      setMessage(`${created.name} created.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create project");
    } finally {
      setCreating(false);
    }
  };

  const saveMemory = async (project: Project) => {
    if (!token) return setError("Enter the local admin token in the top bar.");
    setSavingKey(`${project.id}:memory`);
    try {
      const updated = await catalogApi.updateProjectMemory(
        token,
        project.id,
        drafts[project.id] ?? "",
      );
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage(`${project.name} memory saved.`);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save project memory");
    } finally {
      setSavingKey(null);
    }
  };

  const saveProject = async (project: Project) => {
    if (!token) return setError("Enter the local admin token in the top bar.");
    const nextName = (nameDrafts[project.id] ?? project.name).trim();
    if (!nextName) return setError("Project name is required.");
    setSavingKey(`${project.id}:name`);
    try {
      const updated = await catalogApi.updateProject(token, project.id, nextName);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNameDrafts((current) => ({ ...current, [updated.id]: updated.name }));
      setMessage(`${updated.name} updated.`);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update project");
    } finally {
      setSavingKey(null);
    }
  };

  const saveCommands = async (project: Project) => {
    if (!token) return setError("Enter the local admin token in the top bar.");
    const commands = commandDrafts[project.id] ?? { test: "", app: "" };
    setSavingKey(`${project.id}:commands`);
    try {
      const runtime = await catalogApi.updateRuntimeCommands(token, project.id, {
        test_command: commands.test.trim() || null,
        app_command: commands.app.trim() || null,
      });
      setProjects((current) => current.map((item) => item.id === project.id ? {
        ...item,
        test_command: runtime.configured_test_command,
        app_command: runtime.configured_app_command,
      } : item));
      setCommandDrafts((current) => ({
        ...current,
        [project.id]: {
          test: runtime.configured_test_command ?? "",
          app: runtime.configured_app_command ?? "",
        },
      }));
      setMessage(`${project.name} runtime commands saved.`);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save runtime commands");
    } finally {
      setSavingKey(null);
    }
  };

  const removeProject = async (project: Project) => {
    const accepted = await confirm({
      title: `Delete ${project.name}?`,
      message: "This permanently deletes its repositories, objectives, runs, tasks, approvals, and invocation links.",
      confirmLabel: "Delete project",
    });
    if (!accepted) return;
    try {
      await catalogApi.deleteProject(token, project.id);
      setMessage(`${project.name} deleted.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete project");
    }
  };

  const dirtySaveButton = (dirty: boolean, saving: boolean) =>
    `inline-flex items-center gap-2 border px-3 py-2 text-[10px] uppercase tracking-wider disabled:opacity-40 ${
      dirty
        ? "border-signal/60 text-signal hover:border-signal"
        : "border-[#292824] text-dim"
    } ${saving ? "opacity-60" : ""}`;

  return (
    <div>
      <p className="eyebrow mb-3">Portfolio</p>
      <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Projects</h1>
      <p className="mt-2 text-xs text-dim">
        Store project decisions, constraints, conventions, and rules for every future run.
      </p>
      <section className="control-panel mt-6 p-3 sm:p-5">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="project name" className="w-full min-w-0 flex-1 border border-[#292824] bg-[#0d0d0c] px-3 py-2 text-xs text-terminal outline-none focus:border-signal sm:min-w-64" />
          <button type="submit" disabled={!name.trim() || creating} className="inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-40"><Plus className="h-3 w-3" /> {creating ? "Creating" : "Create"}</button>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 border border-[#292824] px-4 py-2 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal disabled:opacity-40"><RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh</button>
        </form>
        {error && <p className="mt-3 text-xs text-orange-300" role="alert">{error}</p>}
        {message && <p className="mt-3 text-xs text-signal" role="status">{message}</p>}
        <div className="mt-6 space-y-4">
          {loading && projects.length === 0 && (
            <div className="space-y-4" aria-hidden>
              <div className="skeleton h-9 w-full" />
              <div className="skeleton h-40 w-full" />
              <div className="skeleton h-9 w-2/3" />
            </div>
          )}
          {projects.map((project) => {
            const nameDraft = nameDrafts[project.id] ?? project.name;
            const memoryDraft = drafts[project.id] ?? project.memory;
            const commandDraft = commandDrafts[project.id] ?? commandDraftFor(project);
            const nameDirty = nameDraft.trim() !== project.name;
            const memoryDirty = memoryDraft !== project.memory;
            const commandsDirty =
              commandDraft.test.trim() !== (project.test_command ?? "") ||
              commandDraft.app.trim() !== (project.app_command ?? "");
            return (
            <article key={project.id} className="border-t border-[#292824] pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <span className="flex w-full min-w-0 flex-1 items-center gap-2 text-terminal sm:min-w-64"><FolderKanban className="h-4 w-4 shrink-0 text-signal" /><input value={nameDraft} onChange={(event) => setNameDrafts((current) => ({ ...current, [project.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && nameDirty) void saveProject(project); }} className="field min-w-0" aria-label={`${project.name} name`} /></span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-2 uppercase text-dim">{project.status}</span>
                  <button onClick={() => void saveProject(project)} disabled={!nameDirty || savingKey === `${project.id}:name`} className={dirtySaveButton(nameDirty, savingKey === `${project.id}:name`)}><Save className="h-3 w-3" /> Save name</button>
                  <button onClick={() => void removeProject(project)} className="border border-[#292824] p-2 text-dim hover:border-red-700 hover:text-red-400" title="Delete project"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <label className="mt-4 block text-[10px] uppercase tracking-wider text-dim" htmlFor={`memory-${project.id}`}>
                Project memory
                {memoryDirty && <span className="ml-2 normal-case tracking-normal text-signal">unsaved changes</span>}
              </label>
              <textarea
                id={`memory-${project.id}`}
                value={memoryDraft}
                onChange={(event) => setDrafts((current) => ({ ...current, [project.id]: event.target.value }))}
                placeholder={"Examples:\n- Use PostgreSQL, never SQLite\n- API responses use snake_case\n- Keep backward compatibility with v1\n- Decision: authentication uses OAuth"}
                rows={7}
                className="mt-2 w-full border border-[#292824] bg-[#0d0d0c] px-3 py-2 font-mono text-xs leading-5 text-terminal outline-none focus:border-signal"
              />
              <button onClick={() => void saveMemory(project)} disabled={!memoryDirty || savingKey === `${project.id}:memory`} className={`mt-2 ${dirtySaveButton(memoryDirty, savingKey === `${project.id}:memory`)}`}><Save className="h-3 w-3" /> Save memory</button>
              <div className="mt-5 grid gap-3 border-t border-[#292824] pt-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-dim" htmlFor={`test-command-${project.id}`}>Test command</label>
                  <input
                    id={`test-command-${project.id}`}
                    value={commandDraft.test}
                    onChange={(event) => setCommandDrafts((current) => ({
                      ...current,
                      [project.id]: {
                        test: event.target.value,
                        app: current[project.id]?.app ?? "",
                      },
                    }))}
                    placeholder="Auto-detect from the repository"
                    className="field mt-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-dim" htmlFor={`app-command-${project.id}`}>App command</label>
                  <input
                    id={`app-command-${project.id}`}
                    value={commandDraft.app}
                    onChange={(event) => setCommandDrafts((current) => ({
                      ...current,
                      [project.id]: {
                        test: current[project.id]?.test ?? "",
                        app: event.target.value,
                      },
                    }))}
                    placeholder="Auto-detect from the repository"
                    className="field mt-2 font-mono"
                  />
                </div>
                <p className="text-[9px] leading-4 text-dim">
                  Leave a command empty to use the repository&apos;s detected default. Use $PORT in the app command for the assigned preview port.
                </p>
                <button onClick={() => void saveCommands(project)} disabled={!commandsDirty || savingKey === `${project.id}:commands`} className={`w-fit ${dirtySaveButton(commandsDirty, savingKey === `${project.id}:commands`)}`}><Save className="h-3 w-3" /> Save commands</button>
              </div>
            </article>
            );
          })}
          {!loading && projects.length === 0 && (
            <p className="py-12 text-center text-xs text-dim">
              {token
                ? "No projects yet. Create your first project above."
                : "Enter the local admin token in the top bar, then refresh."}
            </p>
          )}
        </div>
      </section>
      {confirmDialog}
    </div>
  );
}
