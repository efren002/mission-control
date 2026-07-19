"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Download, GitBranch, Pencil, Plus, Save, Trash2, X } from "lucide-react";

import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAdminToken } from "@/features/auth/use-admin-token";
import { catalogApi, type Project, type Repository } from "@/features/catalog/api";
import { OpenInVsCode } from "@/features/catalog/open-in-vscode";

export default function RepositoriesPage() {
  const { token } = useAdminToken();
  const { confirm, confirmDialog } = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [projectId, setProjectId] = useState("");
  const [path, setPath] = useState("");
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftBranch, setDraftBranch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return setError("Enter the local admin token in the top bar.");
    try {
      const [loadedProjects, loadedRepos] = await Promise.all([
        catalogApi.projects(token),
        catalogApi.repositories(token),
      ]);
      setProjects(loadedProjects);
      setRepos(loadedRepos);
      if (!projectId && loadedProjects[0]) setProjectId(loadedProjects[0].id);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load repositories");
    }
  }, [token, projectId]);

  useEffect(() => { void load(); }, [load]);

  const register = async () => {
    try {
      await catalogApi.registerRepository(token, projectId, path);
      setPath("");
      setMessage("Repository registered.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to register repository");
    }
  };

  const create = async () => {
    try {
      await catalogApi.createRepository(token, projectId, newName);
      setNewName("");
      setMessage("Empty Git repository created and registered.");
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create repository");
    }
  };

  const edit = (repository: Repository) => {
    setEditingId(repository.id);
    setDraftName(repository.name);
    setDraftBranch(repository.default_branch);
  };

  const save = async (repository: Repository) => {
    if (!draftName.trim() || !draftBranch.trim()) return setError("Name and default branch are required.");
    try {
      await catalogApi.updateRepository(token, repository.id, {
        name: draftName.trim(),
        default_branch: draftBranch.trim(),
      });
      setEditingId(null);
      setMessage("Repository metadata updated.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update repository");
    }
  };

  const download = async (repository: Repository) => {
    setDownloadingId(repository.id);
    try {
      const blob = await catalogApi.repositoryArchive(token, repository.id);
      const slug = repository.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${slug}.zip`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setMessage(`${repository.name} exported as zip (tracked files only, no history).`);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to download repository archive");
    } finally {
      setDownloadingId(null);
    }
  };

  const copyPath = async (repository: Repository) => {
    const localPath = repository.host_path ?? repository.path;
    try {
      await navigator.clipboard.writeText(localPath);
      setMessage(`Path copied: ${localPath}`);
      setError("");
    } catch {
      setError("Unable to copy the path to the clipboard.");
    }
  };

  const remove = async (repository: Repository) => {
    const accepted = await confirm({
      title: `Unregister ${repository.name}?`,
      message: "This removes only the Mission Control record; files on disk are not deleted.",
      confirmLabel: "Unregister",
    });
    if (!accepted) return;
    try {
      await catalogApi.deleteRepository(token, repository.id);
      if (editingId === repository.id) setEditingId(null);
      setMessage(`${repository.name} unregistered.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to unregister repository");
    }
  };

  return <div>
    <p className="eyebrow mb-3">Source control</p>
    <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Repositories</h1>
    <p className="mt-2 text-xs text-dim">Optional advanced setup. Build project creates a repository automatically when needed.</p>
    <section className="control-panel mt-6 p-3 sm:p-5">
      <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-signal">Create a project repository</p>
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="field"><option value="">select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="repository name, e.g. product-crud" className="field" />
        <button onClick={() => void create()} disabled={!projectId || !newName.trim()} className="inline-flex items-center justify-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-40"><Plus className="h-3 w-3" /> Create</button>
      </div>
      <p className="mb-3 mt-7 text-[10px] font-bold uppercase tracking-wider text-dim">Or register an existing repository</p>
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="field"><option value="">select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="relative path, e.g. my-app" className="field" />
        <button onClick={() => void register()} disabled={!projectId || !path} className="inline-flex items-center justify-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-40"><Plus className="h-3 w-3" /> Register</button>
      </div>
      {error && <p className="mt-3 text-xs text-orange-300">{error}</p>}
      {message && <p className="mt-3 text-xs text-signal">{message}</p>}
      <div className="mt-6 space-y-2">
        {repos.map((repository) => <article key={repository.id} className="border-t border-[#292824] py-4">
          {editingId === repository.id ? <div className="grid gap-3 md:grid-cols-[1fr_14rem_auto]"><label className="text-[9px] uppercase text-dim">Display name<input value={draftName} onChange={(event) => setDraftName(event.target.value)} className="field mt-1" /></label><label className="text-[9px] uppercase text-dim">Default branch<input value={draftBranch} onChange={(event) => setDraftBranch(event.target.value)} className="field mt-1" /></label><div className="flex items-end gap-2"><button onClick={() => void save(repository)} className="border border-signal/50 p-2 text-signal" title="Save repository"><Save className="h-3.5 w-3.5" /></button><button onClick={() => setEditingId(null)} className="border border-[#292824] p-2 text-dim" title="Cancel"><X className="h-3.5 w-3.5" /></button></div></div> : <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="flex items-center gap-2 text-xs text-terminal"><GitBranch className="h-4 w-4 text-phosphor" />{repository.name}</span><p className="mt-1 flex items-center gap-1.5 text-[10px] text-dim" title="Path inside the Mission Control containers. On this machine the files live in the repositories folder of your Mission Control directory.">{repository.host_path ?? repository.path}<button onClick={() => void copyPath(repository)} className="text-[#55524c] hover:text-signal" title="Copy path"><Copy className="h-3 w-3" /></button></p><p className="mt-1 text-[9px] text-[#55524c]">{projects.find((project) => project.id === repository.project_id)?.name ?? "Unknown project"} · {repository.default_branch}</p></div><div className="flex gap-2"><OpenInVsCode hostPath={repository.host_path} iconOnly /><button onClick={() => void download(repository)} disabled={downloadingId === repository.id} className="border border-[#292824] p-2 text-dim hover:border-signal hover:text-signal disabled:opacity-40" title="Download zip of tracked files"><Download className="h-3.5 w-3.5" /></button><button onClick={() => edit(repository)} className="border border-[#292824] p-2 text-dim hover:border-signal hover:text-signal" title="Edit repository"><Pencil className="h-3.5 w-3.5" /></button><button onClick={() => void remove(repository)} className="border border-[#292824] p-2 text-dim hover:border-red-700 hover:text-red-400" title="Unregister repository"><Trash2 className="h-3.5 w-3.5" /></button></div></div>}
        </article>)}
        {repos.length === 0 && <p className="py-12 text-center text-xs text-dim">No repositories registered.</p>}
      </div>
    </section>
    {confirmDialog}
  </div>;
}
