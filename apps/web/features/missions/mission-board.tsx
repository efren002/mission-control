"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hammer, Loader2, Pencil, Play, RotateCw, Rocket, Search, Trash2, Undo2 } from "lucide-react";

import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAdminToken } from "@/features/auth/use-admin-token";
import {
  catalogApi,
  type Objective,
  type Agent,
  type Project,
  type Repository,
  type RunDetail,
  type RunInvocation,
} from "@/features/catalog/api";
import { ProviderConnectionBanner } from "@/features/catalog/provider-connection";
import {
  acceptMissionImages,
  filesFromDrop,
  MissionAttachments,
  MissionImagePicker,
} from "@/features/missions/mission-attachments";
import { ProjectRuntimePanel } from "@/features/missions/project-runtime-panel";
import { useVisiblePolling } from "@/lib/use-visible-polling";

const NEW_PROJECT = "__new__";

const stageLabels: Record<string, { label: string; tone: "idle" | "active" | "good" | "bad" }> = {
  draft: { label: "Ready to plan", tone: "idle" },
  planning: { label: "Planning", tone: "active" },
  awaiting_approval: { label: "Plan ready for review", tone: "active" },
  planned: { label: "Ready to build", tone: "active" },
  awaiting_execution_approval: { label: "Build needs approval", tone: "active" },
  executing: { label: "Building", tone: "active" },
  completed: { label: "Done", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  rejected: { label: "Plan rejected", tone: "bad" },
};

const toneClass: Record<string, string> = {
  idle: "text-dim",
  active: "text-signal",
  good: "text-phosphor",
  bad: "text-orange-300",
};

function stageOf(status: string) {
  return stageLabels[status] ?? { label: status.replaceAll("_", " "), tone: "idle" as const };
}

type StageFilter = "all" | "active" | "done" | "failed";

const stageFilters: { value: StageFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

function matchesStageFilter(status: string, filter: StageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "done") return status === "completed";
  if (filter === "failed") return status === "failed" || status === "rejected";
  return !["completed", "failed", "rejected"].includes(status);
}

const STALLED_QUEUE_MS = 2 * 60 * 1000;
const STALLED_EXECUTION_MS = 5 * 60 * 1000;

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function lastActivityOf(detail: RunDetail): { label: string; at: number } | null {
  const lastEvent = detail.events[detail.events.length - 1];
  const lastInvocation = detail.invocations[detail.invocations.length - 1];
  const eventAt = lastEvent ? new Date(lastEvent.created_at).getTime() : 0;
  const invocationAt = lastInvocation
    ? new Date(lastInvocation.updated_at || lastInvocation.created_at).getTime()
    : 0;
  if (lastEvent && eventAt >= invocationAt) {
    return {
      label: lastEvent.event_type.replaceAll(".", ": ").replaceAll("_", " "),
      at: eventAt,
    };
  }
  if (lastInvocation) {
    return {
      label:
        lastInvocation.updated_at !== lastInvocation.created_at
          ? `agent activity (${lastInvocation.agent_name})`
          : `agent started (${lastInvocation.agent_name})`,
      at: invocationAt,
    };
  }
  return null;
}

export function MissionBoard() {
  const { token } = useAdminToken();
  const { confirm, confirmDialog } = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectChoice, setProjectChoice] = useState(NEW_PROJECT);
  const [images, setImages] = useState<File[]>([]);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const addImages = (incoming: File[]) => {
    const { accepted, rejected } = acceptMissionImages(incoming, images.length);
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
    if (rejected.length > 0) setError(rejected.join(" "));
  };

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [loadedProjects, loadedObjectives, loadedRuns, loadedRepositories] =
        await Promise.all([
          catalogApi.projects(token),
          catalogApi.objectives(token),
          catalogApi.runs(token),
          catalogApi.repositories(token),
        ]);
      setProjects(loadedProjects);
      setObjectives(loadedObjectives);
      setRepositories(loadedRepositories);
      const selected =
        loadedObjectives.find((item) => item.id === selectedId) ?? loadedObjectives[0];
      setSelectedId(selected?.id ?? "");
      const latestRun = selected
        ? loadedRuns.find((run) => run.objective_id === selected.id)
        : undefined;
      setDetail(latestRun ? await catalogApi.run(token, latestRun.id) : null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load missions");
    }
  }, [token, selectedId]);

  useVisiblePolling(load, 5_000, Boolean(token), selectedId);

  const startMission = async () => {
    setBusy(true);
    try {
      const projectId =
        projectChoice === NEW_PROJECT
          ? (await catalogApi.createProject(token, title.trim())).id
          : projectChoice;
      const objective = await catalogApi.createObjective(
        token,
        projectId,
        title.trim(),
        description.trim(),
      );
      setTitle("");
      setDescription("");
      setSelectedId(objective.id);
      try {
        for (const image of images) {
          await catalogApi.uploadAttachment(token, objective.id, image);
        }
        setImages([]);
      } catch (cause) {
        setMessage("");
        setError(
          cause instanceof Error
            ? `Mission saved, but an image could not be uploaded: ${cause.message}. Add it again from the mission below, then press Plan mission.`
            : "Mission saved, but an image could not be uploaded. Add it again from the mission below, then press Plan mission.",
        );
        setImages([]);
        await load();
        return;
      }
      try {
        await catalogApi.startPlanning(token, objective.id);
        setMessage("Mission started. The planner is drafting tasks.");
      } catch (cause) {
        setMessage("");
        setError(
          cause instanceof Error
            ? `Mission saved, but planning could not start: ${cause.message}`
            : "Mission saved, but planning could not start.",
        );
        await load();
        return;
      }
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the mission");
    } finally {
      setBusy(false);
    }
  };

  const plan = async (objectiveId: string) => {
    setBusy(true);
    try {
      await catalogApi.startPlanning(token, objectiveId);
      setMessage("Planning started.");
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start planning");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (objective: Objective) => {
    const accepted = await confirm({
      title: `Delete “${objective.title}”?`,
      message: "The mission and all of its runs, tasks, and approvals will be permanently deleted.",
      confirmLabel: "Delete mission",
    });
    if (!accepted) return;
    try {
      await catalogApi.deleteObjective(token, objective.id);
      if (selectedId === objective.id) setSelectedId("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete the mission");
    }
  };

  if (!token)
    return (
      <ModulePlaceholder
        eyebrow="Build"
        title="Missions"
        description="Describe what you want, review the plan, and watch agents build it."
        icon={Rocket}
      />
    );

  const selected = objectives.find((item) => item.id === selectedId) ?? null;
  const query = search.trim().toLowerCase();
  const visibleObjectives = objectives.filter(
    (objective) =>
      matchesStageFilter(objective.status, stageFilter) &&
      (!query ||
        objective.title.toLowerCase().includes(query) ||
        (objective.description ?? "").toLowerCase().includes(query)),
  );

  return (
    <div>
      <p className="eyebrow mb-3">Build</p>
      <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Missions</h1>
      <p className="mt-2 text-xs text-dim">
        Describe what you want, review the plan, and watch agents build it. Everything for one
        mission happens on this screen.
      </p>

      <ProviderConnectionBanner token={token} />

      <section
        className="control-panel mt-6 p-3 sm:p-5"
        onPaste={(event) => {
          if (event.defaultPrevented) return;
          const pasted = Array.from(event.clipboardData?.files ?? []).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (pasted.length === 0) return;
          event.preventDefault();
          addImages(pasted);
        }}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.defaultPrevented) return;
          const dropped = filesFromDrop(event);
          if (dropped.length === 0) return;
          event.preventDefault();
          addImages(dropped);
        }}
      >
        <p className="eyebrow">New mission</p>
        <div className="mt-4 grid gap-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What do you want to build?"
            className="field"
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe the outcome: the features, who uses it, and what done looks like"
            rows={3}
            className="field"
          />
          {projects.length > 0 && (
            <select
              value={projectChoice}
              onChange={(event) => setProjectChoice(event.target.value)}
              className="field"
            >
              <option value={NEW_PROJECT}>Create a new project for this mission</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  Existing project: {project.name}
                </option>
              ))}
            </select>
          )}
          <MissionImagePicker files={images} onChange={setImages} disabled={busy} />
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void startMission()}
              disabled={busy || !title.trim()}
              className="inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-40"
            >
              <Rocket className="h-3 w-3" /> Start mission
            </button>
            <span className="text-[10px] text-dim">
              {projectChoice === NEW_PROJECT
                ? "A project and repository are created for you. Planning starts immediately."
                : "Planning starts immediately in the selected project."}
            </span>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-orange-300">{error}</p>}
        {message && <p className="mt-3 text-xs text-signal">{message}</p>}
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <article className="control-panel p-4">
          <p className="eyebrow">Missions</p>
          {objectives.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-dim" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search missions"
                  className="field w-full pl-7"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {stageFilters.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setStageFilter(option.value)}
                    className={`border px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${
                      stageFilter === option.value
                        ? "border-signal/60 text-signal"
                        : "border-[#292824] text-dim hover:border-[#55524c]"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 space-y-2">
            {visibleObjectives.map((objective) => {
              const stage = stageOf(objective.status);
              return (
                <button
                  key={objective.id}
                  onClick={() => setSelectedId(objective.id)}
                  className={`w-full border p-3 text-left ${
                    selectedId === objective.id
                      ? "border-signal/60 bg-signal/[0.04]"
                      : "border-[#292824] hover:border-[#55524c]"
                  }`}
                >
                  <span className="break-words text-xs font-semibold text-terminal">
                    {objective.title}
                  </span>
                  <p className={`mt-2 text-[9px] font-bold uppercase ${toneClass[stage.tone]}`}>
                    {stage.label}
                  </p>
                </button>
              );
            })}
            {objectives.length === 0 && (
              <p className="py-10 text-center text-xs text-dim">
                No missions yet. Describe one above to get started.
              </p>
            )}
            {objectives.length > 0 && visibleObjectives.length === 0 && (
              <p className="py-10 text-center text-xs text-dim">
                No missions match the current search or filter.
              </p>
            )}
          </div>
        </article>

        <article className="control-panel min-w-0 min-h-[24rem] p-3 sm:p-5">
          {selected ? (
            <MissionDetail
              objective={selected}
              detail={detail}
              repositories={repositories.filter(
                (item) => item.project_id === selected.project_id,
              )}
              projectName={
                projects.find((project) => project.id === selected.project_id)?.name ?? ""
              }
              token={token}
              busy={busy}
              onPlan={() => void plan(selected.id)}
              onDelete={() => void remove(selected)}
              reload={load}
            />
          ) : (
            <p className="grid min-h-[20rem] place-items-center text-xs text-dim">
              Select a mission.
            </p>
          )}
        </article>
      </section>
      {confirmDialog}
    </div>
  );
}

const missionSteps = ["Plan", "Review", "Build", "Done"] as const;

function stepProgressOf(
  objective: Objective,
  detail: RunDetail | null,
): { current: number; failed: boolean } {
  switch (objective.status) {
    case "planning":
      return { current: 0, failed: false };
    case "awaiting_approval":
      return { current: 1, failed: false };
    case "rejected":
      return { current: 1, failed: true };
    case "planned":
    case "awaiting_execution_approval":
    case "executing":
      return { current: 2, failed: false };
    case "completed":
      return { current: 3, failed: false };
    case "failed":
      return {
        current:
          detail?.current_step?.startsWith("execution") ||
          detail?.current_step?.startsWith("verification")
            ? 2
            : 0,
        failed: true,
      };
    default:
      return { current: 0, failed: false };
  }
}

function MissionProgress({
  objective,
  detail,
}: {
  objective: Objective;
  detail: RunDetail | null;
}) {
  const { current, failed } = stepProgressOf(objective, detail);
  const complete = objective.status === "completed";
  return (
    <ol className="mt-4 flex flex-wrap items-center gap-2" aria-label="Mission progress">
      {missionSteps.map((step, index) => {
        const state = complete
          ? "done"
          : index < current
            ? "done"
            : index === current
              ? failed
                ? "failed"
                : "active"
              : "upcoming";
        const color =
          state === "done"
            ? "text-phosphor"
            : state === "active"
              ? "text-signal"
              : state === "failed"
                ? "text-orange-300"
                : "text-dim";
        return (
          <li key={step} className="flex items-center gap-2">
            {index > 0 && <span className="h-px w-4 bg-[#292824]" aria-hidden />}
            <span
              className={`text-[9px] font-bold uppercase tracking-wider ${color}`}
              aria-current={state === "active" || state === "failed" ? "step" : undefined}
            >
              {state === "done" ? "✓ " : ""}
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function MissionDetail({
  objective,
  detail,
  repositories,
  projectName,
  token,
  busy,
  onPlan,
  onDelete,
  reload,
}: {
  objective: Objective;
  detail: RunDetail | null;
  repositories: Repository[];
  projectName: string;
  token: string;
  busy: boolean;
  onPlan: () => void;
  onDelete: () => void;
  reload: () => Promise<void>;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [reason, setReason] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");

  useEffect(() => setEditing(false), [objective.id]);

  const stage = stageOf(objective.status);
  const pendingApproval = detail?.approvals.find((item) => item.status === "pending") ?? null;
  const canEdit =
    ["draft", "failed", "rejected"].includes(objective.status) &&
    pendingApproval?.kind !== "task_integration";
  const runFinished = detail?.status === "completed" || detail?.status === "failed";
  const readyToBuild =
    detail?.status === "completed" && detail.current_step === "planned";
  const building =
    detail?.status === "queued_for_execution" || detail?.status === "executing";
  const lastActivity = detail ? lastActivityOf(detail) : null;
  const stalledInQueue =
    detail?.status === "queued_for_execution" &&
    lastActivity !== null &&
    Date.now() - lastActivity.at > STALLED_QUEUE_MS;
  const stalledInExecution =
    detail?.status === "executing" &&
    lastActivity !== null &&
    Date.now() - lastActivity.at > STALLED_EXECUTION_MS;
  const built =
    detail?.status === "completed" &&
    ["executed", "verified"].includes(detail.current_step ?? "");
  const canPlan =
    ["draft", "failed", "rejected"].includes(objective.status) &&
    pendingApproval?.kind !== "task_integration";
  const canRetryTask =
    detail?.status === "failed" && detail.current_step === "execution_failed";
  const canRetryVerification =
    detail?.status === "failed" && detail.current_step === "verification_failed";
  const lastError =
    [...(detail?.invocations ?? [])].reverse().find((item) => item.error)?.error ?? null;
  const selectedRepository =
    repositories.find((item) => item.id === detail?.repository_id) ?? null;
  const repositoryPath =
    selectedRepository?.host_path ?? selectedRepository?.path ?? null;

  const decide = async (decision: "approve" | "reject") => {
    if (!pendingApproval) return;
    setActionBusy(true);
    try {
      await catalogApi.decideApproval(token, pendingApproval.id, decision, reason);
      setReason("");
      setError("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to record the decision");
    } finally {
      setActionBusy(false);
    }
  };

  const build = async () => {
    if (!detail) return;
    setActionBusy(true);
    try {
      await catalogApi.startExecution(token, detail.id, repositoryId || null);
      setError("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the build");
    } finally {
      setActionBusy(false);
    }
  };

  const resume = async () => {
    if (!detail) return;
    setActionBusy(true);
    try {
      await catalogApi.resumeExecution(token, detail.id);
      setError("");
      setReason("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to resume the build");
    } finally {
      setActionBusy(false);
    }
  };

  const saveEdit = async () => {
    setActionBusy(true);
    try {
      await catalogApi.updateObjective(token, objective.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
      });
      setEditing(false);
      setError("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the mission");
    } finally {
      setActionBusy(false);
    }
  };

  const retryVerification = async () => {
    if (!detail) return;
    setActionBusy(true);
    try {
      await catalogApi.retryVerification(token, detail.id);
      setError("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to retry verification");
    } finally {
      setActionBusy(false);
    }
  };

  const retryTask = async (taskId: string) => {
    setActionBusy(true);
    try {
      await catalogApi.retryTask(token, taskId);
      setError("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to retry the task");
    } finally {
      setActionBusy(false);
    }
  };

  const undo = async (taskId: string, title: string) => {
    const accepted = await confirm({
      title: `Undo “${title}”?`,
      message:
        "A new Git commit will revert this task's changes in the repository. Later tasks that touched the same files may conflict; the undo is cancelled if that happens.",
      confirmLabel: "Undo task",
    });
    if (!accepted) return;
    setActionBusy(true);
    try {
      await catalogApi.revertTask(token, taskId);
      setError("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to undo the task");
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Mission</p>
          <h2 className="mt-2 break-words text-lg font-semibold text-terminal">
            {objective.title}
          </h2>
          {projectName && <p className="mt-1 text-[10px] text-dim">Project: {projectName}</p>}
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[10px] font-bold uppercase ${toneClass[stage.tone]}`}>
            {stage.label}
          </span>
          {canEdit && !editing && (
            <button
              onClick={() => {
                setEditTitle(objective.title);
                setEditDescription(objective.description ?? "");
                setEditing(true);
              }}
              title="Edit mission"
              className="border border-[#292824] p-2 text-dim hover:border-[#55524c] hover:text-terminal"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {!["planning", "executing"].includes(objective.status) && (
            <button
              onClick={onDelete}
              title="Delete mission"
              className="border border-[#292824] p-2 text-dim hover:border-red-700 hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <MissionProgress objective={objective} detail={detail} />
      {editing ? (
        <div className="mt-4 grid gap-2">
          <input
            value={editTitle}
            onChange={(event) => setEditTitle(event.target.value)}
            placeholder="Mission title"
            className="field"
          />
          <textarea
            value={editDescription}
            onChange={(event) => setEditDescription(event.target.value)}
            rows={3}
            placeholder="Describe the outcome: the features, who uses it, and what done looks like"
            className="field"
          />
          <div className="flex flex-wrap gap-3">
            <button
              disabled={actionBusy || !editTitle.trim()}
              onClick={() => void saveEdit()}
              className="bg-signal px-4 py-2 text-[10px] font-bold uppercase text-black disabled:opacity-40"
            >
              Save changes
            </button>
            <button
              disabled={actionBusy}
              onClick={() => setEditing(false)}
              className="border border-[#292824] px-4 py-2 text-[10px] font-bold uppercase text-dim hover:border-[#55524c] disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        objective.description && (
          <p className="mt-3 break-words text-[10px] leading-4 text-dim">
            {objective.description}
          </p>
        )
      )}
      {error && <p className="mt-3 text-xs text-orange-300">{error}</p>}

      <MissionAttachments token={token} objectiveId={objective.id} />

      {canRetryVerification && detail && (
        <section className="mt-6 border border-signal/30 bg-signal/[0.03] p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-signal">
            Retry verification
          </p>
          <p className="mt-2 text-[10px] leading-4 text-dim">
            Every task already completed successfully; only the deterministic tests and reviewer
            step failed. This re-runs just that step against the existing build — no tasks are
            redone, so it costs far less than replanning.
          </p>
          <button
            disabled={actionBusy}
            onClick={() => void retryVerification()}
            className="mt-3 inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase text-black disabled:opacity-40"
          >
            <RotateCw className="h-3 w-3" />{" "}
            {actionBusy ? "Retrying verification" : "Retry verification"}
          </button>
        </section>
      )}

      {canPlan && (
        <section className="mt-6 border border-signal/30 bg-signal/[0.03] p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-signal">
            {objective.status === "draft" ? "Ready to plan" : "Try planning again"}
          </p>
          {lastError && objective.status !== "draft" && (
            <p className="mt-2 break-words text-[10px] leading-4 text-orange-300">{lastError}</p>
          )}
          {canRetryTask && (
            <p className="mt-2 text-[10px] leading-4 text-orange-200">
              This mission failed while building, not while planning. Replanning regenerates every
              task and discards completed work — to retry only the task that failed, use{" "}
              <span className="font-bold">Retry task</span> below instead.
            </p>
          )}
          {canRetryVerification && (
            <p className="mt-2 text-[10px] leading-4 text-orange-200">
              Every task already completed; only verification failed. Replanning discards that
              completed work — use <span className="font-bold">Retry verification</span> above
              instead unless the plan itself needs to change.
            </p>
          )}
          <button
            disabled={busy}
            onClick={onPlan}
            className="mt-3 inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase text-black disabled:opacity-40"
          >
            <Play className="h-3 w-3" /> {objective.status === "draft" ? "Plan mission" : "Retry planning"}
          </button>
        </section>
      )}

      {objective.status === "planning" && (
        <p className="mt-6 inline-flex items-center gap-2 border border-signal/30 p-4 text-xs text-signal">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> The planner is drafting tasks. This
          usually takes a minute or two.
        </p>
      )}

      {pendingApproval && detail && (
        <section className="mt-6 border border-signal/30 bg-signal/[0.03] p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-signal">
            {pendingApproval.kind === "plan"
              ? "Review the proposed plan"
              : pendingApproval.kind === "task_integration"
                ? "Review task merge conflict"
                : "Approve repository changes"}
          </p>
          {pendingApproval.kind === "execution" && (
            <p className="mt-2 text-[10px] leading-4 text-orange-200">
              Approving allows the assigned agents to edit the project repository and run
              project commands.
            </p>
          )}
          {pendingApproval.kind === "task_integration" && (
            <p className="mt-2 text-[10px] leading-4 text-orange-200">
              The task branch was preserved because Git could not merge it safely. Inspect the
              conflicting files below and run assisted resolution. Retry is allowed only after
              its verification passes; approval never chooses conflict content automatically.
            </p>
          )}
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder="Optional note, or the reason if you reject"
            className="field mt-3"
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              disabled={actionBusy || detail.tasks.length === 0}
              onClick={() => void decide("approve")}
              className="bg-signal px-4 py-2 text-[10px] font-bold uppercase text-black disabled:opacity-40"
            >
              {pendingApproval.kind === "task_integration" ? "Retry merge" : "Approve"}
            </button>
            <button
              disabled={actionBusy}
              onClick={() => void decide("reject")}
              className="border border-orange-700 px-4 py-2 text-[10px] font-bold uppercase text-orange-300 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </section>
      )}

      {readyToBuild && detail && (
        <section className="mt-6 border border-signal/30 bg-signal/[0.03] p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-signal">
            Ready to build
          </p>
          <p className="mt-2 text-[10px] leading-4 text-dim">
            This starts the agents and authorizes them to edit the project files. Progress
            appears below automatically.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {repositories.length > 1 ? (
              <select
                value={repositoryId}
                onChange={(event) => setRepositoryId(event.target.value)}
                className="field max-w-sm"
              >
                <option value="">Choose a repository</option>
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[10px] text-terminal">
                {repositories[0]
                  ? `Repository: ${repositories[0].name}`
                  : "A repository is created for you."}
              </span>
            )}
            <button
              disabled={actionBusy}
              onClick={() => void build()}
              className="inline-flex items-center gap-2 bg-signal px-5 py-2 text-[10px] font-bold uppercase text-black disabled:opacity-40"
            >
              <Hammer className="h-3 w-3" /> {actionBusy ? "Starting build" : "Build project"}
            </button>
          </div>
        </section>
      )}

      {building && detail && (
        <section className="mt-6 min-w-0 overflow-hidden border border-signal/30 p-4">
          <p className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-signal">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Building
          </p>
          <p className="mt-2 text-[10px] text-dim">
            {detail.current_step?.startsWith("verification")
              ? "Implementation finished. An independent reviewer is checking the acceptance criteria."
              : detail.current_step
                ? `Current step: ${detail.current_step}`
                : "Starting up."}
          </p>
          {detail.worktree_branch && (
            <p className="mt-1 break-all text-[10px] text-dim">
              Isolated branch: {detail.worktree_branch}
            </p>
          )}
          {lastActivity && (
            <p className="mt-1 text-[10px] text-dim">
              Last activity: {lastActivity.label}, {relativeTime(lastActivity.at)}
            </p>
          )}
          {stalledInQueue && (
            <div className="mt-2 border-l-2 border-orange-300 pl-2 text-[10px] leading-4 text-orange-300">
              <p>
                The build has been waiting for a worker for a while. Restart the worker if
                needed, then retry delivery without rebuilding completed tasks.
              </p>
              <button
                disabled={actionBusy}
                onClick={() => void resume()}
                className="mt-2 border border-orange-700 px-3 py-1.5 font-bold uppercase text-orange-200 hover:border-orange-400 disabled:opacity-40"
              >
                {actionBusy ? "Retrying queue" : "Retry queue"}
              </button>
            </div>
          )}
          {stalledInExecution && (
            <div className="mt-2 border-l-2 border-orange-300 pl-2 text-[10px] leading-4 text-orange-300">
              <p>
                This build appears stale: no worker or agent activity has been recorded for more
                than five minutes. Resume preserves completed task checkpoints and requeues only
                the interrupted task.
              </p>
              <button
                disabled={actionBusy}
                onClick={() => void resume()}
                className="mt-2 border border-orange-700 px-3 py-1.5 font-bold uppercase text-orange-200 hover:border-orange-400 disabled:opacity-40"
              >
                {actionBusy ? "Resuming build" : "Resume build"}
              </button>
            </div>
          )}
          <LiveActivity invocations={detail.invocations} />
        </section>
      )}

      {built && (
        <section className="mt-6 border border-phosphor/40 bg-phosphor/[0.04] p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-phosphor">
            Mission complete
          </p>
          <p className="mt-2 text-[10px] leading-4 text-dim">
            {repositoryPath
              ? `Open the project on your computer at ${repositoryPath}.`
              : "The project files are in the mission repository."}{" "}
            Each completed task was saved as a Git checkpoint commit, so you can review every
            step below or roll back with normal Git tools.
          </p>
          {detail?.integration_sha && (
            <p className="mt-2 break-all text-[10px] text-phosphor">
              Verified branch integrated at {detail.integration_sha.slice(0, 12)}.
            </p>
          )}
          {detail?.worktree_status === "cleanup_pending" && (
            <p className="mt-2 text-[10px] text-orange-300">
              Integration succeeded, but automatic worktree cleanup is still pending.
            </p>
          )}
        </section>
      )}

      {built && detail?.repository_id && (
        <ProjectRuntimePanel
          projectId={objective.project_id}
          repositoryId={detail.repository_id}
          repositoryHostPath={selectedRepository?.host_path ?? null}
          token={token}
        />
      )}

      {objective.status === "failed" && lastError && !canPlan && (
        <p className="mt-6 break-words border border-orange-700/50 bg-orange-900/10 p-4 text-[10px] leading-4 text-orange-200">
          {lastError}
        </p>
      )}

      {detail?.worktree_status === "preserved" && (
        <p className="mt-3 break-words border border-orange-700/50 bg-orange-900/10 p-4 text-[10px] leading-4 text-orange-200">
          The failed mission remains isolated on {detail.worktree_branch}. The registered
          repository was not changed, so the branch can be inspected or recovered safely.
        </p>
      )}

      {detail && (detail.verification_criteria?.length ?? 0) > 0 && (
        <EvidenceReport detail={detail} />
      )}

      {detail && detail.tasks.length > 0 && (
        <section className="mt-7">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-signal">
            Tasks ({detail.tasks.filter((task) => task.status === "completed").length}/
            {detail.tasks.length} done)
          </h3>
          <div className="mt-2">
            {detail.tasks.map((task) => (
              <div key={task.id} className="border-t border-[#292824] py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="break-words text-xs text-terminal">{task.title}</span>
                  <span className="text-[9px] uppercase text-signal">{task.agent_role}</span>
                  <span className="text-[9px] uppercase text-dim">
                    #{task.position}
                    {task.depends_on_positions.length > 0
                      ? ` after ${task.depends_on_positions.join(", ")}`
                      : " independent"}
                  </span>
                  <span
                    className={`text-[9px] font-bold uppercase ${
                      task.status === "completed"
                        ? "text-phosphor"
                        : task.status === "failed" || task.status === "blocked"
                          ? "text-orange-300"
                          : task.status === "in_progress"
                            ? "text-signal"
                            : "text-dim"
                    }`}
                  >
                    {task.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="mt-1 break-words text-[10px] leading-4 text-dim">
                  {task.description || "No description"}
                </p>
                {task.worktree_status === "preserved" && task.worktree_branch && (
                  <p className="mt-1 break-all text-[10px] text-orange-300">
                    Conflicting or failed task branch preserved: {task.worktree_branch}
                  </p>
                )}
                {task.conflict_files.length > 0 && (
                  <TaskConflictReview token={token} taskId={task.id} />
                )}
                {canRetryTask &&
                  task.status === "failed" &&
                  task.conflict_files.length === 0 && (
                  <button
                    disabled={actionBusy}
                    onClick={() => void retryTask(task.id)}
                    className="mt-2 mr-4 inline-flex items-center gap-1 bg-signal px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-black disabled:opacity-40"
                  >
                    <RotateCw className="h-3 w-3" />{" "}
                    {actionBusy ? "Retrying task" : "Retry task"}
                  </button>
                )}
                {task.worktree_status === "cleanup_pending" && (
                  <p className="mt-1 text-[10px] text-orange-300">
                    Task integration succeeded; branch cleanup is pending.
                  </p>
                )}
                {runFinished &&
                  ["completed", "failed"].includes(task.status) &&
                  task.checkpoint_sha && (
                  <button
                    disabled={actionBusy}
                    onClick={() => void undo(task.id, task.title)}
                    className="mt-2 mr-4 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-dim hover:text-orange-300 disabled:opacity-40"
                  >
                    <Undo2 className="h-3 w-3" /> Undo this task
                  </button>
                )}
                {task.checkpoint_sha && <TaskChanges token={token} taskId={task.id} />}
              </div>
            ))}
          </div>
        </section>
      )}

      {detail && (
        <p className="mt-7 border-t border-[#292824] pt-4 text-[10px] text-dim">
          Need the full timeline, agent output, or errors? Open{" "}
          <a href="/runs" className="text-signal hover:underline">
            the advanced run view
          </a>
          .
        </p>
      )}
      {confirmDialog}
    </div>
  );
}

function EvidenceReport({ detail }: { detail: RunDetail }) {
  const criteria = detail.verification_criteria ?? [];
  const testEvidence = (detail.verification_evidence ?? []).find(
    (evidence) => evidence.kind === "test",
  );
  const passed = criteria.filter(
    (criterion) => criterion.status === "passed",
  ).length;
  const failed = criteria.filter(
    (criterion) => criterion.status === "failed",
  ).length;
  return (
    <section className="mt-7" aria-label="Acceptance evidence">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-signal">
          Acceptance evidence
        </h3>
        <span
          className={`text-[9px] font-bold uppercase ${
            failed > 0
              ? "text-orange-300"
              : passed === criteria.length
                ? "text-phosphor"
                : "text-dim"
          }`}
        >
          {passed}/{criteria.length} verified
        </span>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-dim">
        The approved plan defines these completion conditions. Mission completion is blocked
        until an independent reviewer verifies every condition.
      </p>
      {testEvidence && (
        <div className="mt-3 border border-[#292824] bg-white/[0.015] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-terminal">
              Project tests
            </p>
            <span
              className={`text-[9px] font-bold uppercase ${
                testEvidence.status === "passed"
                  ? "text-phosphor"
                  : testEvidence.status === "failed" || testEvidence.status === "error"
                    ? "text-orange-300"
                    : testEvidence.status === "running"
                      ? "text-signal"
                      : "text-dim"
              }`}
            >
              {testEvidence.status}
              {testEvidence.exit_code !== null ? ` · exit ${testEvidence.exit_code}` : ""}
            </span>
          </div>
          <p className="mt-2 break-all font-mono text-[10px] text-dim">
            {testEvidence.command || "No configured or detected test command"}
          </p>
          {testEvidence.error && (
            <p className="mt-2 break-words text-[10px] leading-4 text-orange-200">
              {testEvidence.error}
            </p>
          )}
          {testEvidence.output_excerpt && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[9px] font-bold uppercase tracking-wider text-signal">
                Test output
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-[#292824] bg-black/30 p-3 text-[10px] leading-4 text-dim">
                {testEvidence.output_excerpt}
              </pre>
            </details>
          )}
        </div>
      )}
      <ol className="mt-3">
        {criteria.map((criterion) => (
          <li key={criterion.id} className="border-t border-[#292824] py-3">
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 text-[10px] font-bold ${
                  criterion.status === "passed"
                    ? "text-phosphor"
                    : criterion.status === "failed"
                      ? "text-orange-300"
                      : "text-dim"
                }`}
                aria-label={criterion.status}
              >
                {criterion.status === "passed"
                  ? "✓"
                  : criterion.status === "failed"
                    ? "×"
                    : "○"}
              </span>
              <div className="min-w-0">
                <p className="break-words text-xs text-terminal">
                  {criterion.description}
                </p>
                {criterion.evidence && (
                  <p className="mt-1 break-words text-[10px] leading-4 text-dim">
                    Evidence: {criterion.evidence}
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LiveActivity({ invocations }: { invocations: RunInvocation[] }) {
  const running = [...invocations].reverse().find((item) => item.status === "running");
  const output = running?.output_excerpt ?? "";
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  if (!output) {
    return (
      <p className="mt-3 text-[10px] text-dim">
        Waiting for agent output. It appears here as the agent works.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <p className="text-[9px] uppercase tracking-wider text-dim">
        Live agent activity (raw provider output)
        {running?.provider
          ? ` · ${running.provider} · attempt ${running.attempt}`
          : ""}
      </p>
      <pre
        ref={scrollRef}
        className="mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all border-l border-[#292824] pl-3 text-[9px] leading-4 text-dim"
      >
        {output.slice(-3000)}
      </pre>
    </div>
  );
}

function TaskConflictReview({ token, taskId }: { token: string; taskId: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Awaited<
    ReturnType<typeof catalogApi.taskConflict>
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [starting, setStarting] = useState(false);

  const loadReport = useCallback(async () => {
    const loaded = await catalogApi.taskConflict(token, taskId);
    setReport(loaded);
    return loaded;
  }, [token, taskId]);

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (report || loading) return;
    setLoading(true);
    try {
      const [loadedReport, loadedAgents] = await Promise.all([
        loadReport(),
        catalogApi.agents(token),
      ]);
      const eligible = loadedAgents.filter(
        (agent) => agent.enabled && agent.role !== "planner",
      );
      setAgents(eligible);
      setAgentId(
        loadedReport.latest_resolution?.agent_id ??
          eligible.find((agent) => agent.role === "reviewer")?.id ??
          eligible[0]?.id ??
          "",
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to inspect the conflict");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (
      !open ||
      !report?.latest_resolution ||
      !["queued", "running"].includes(report.latest_resolution.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadReport().catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Unable to refresh resolution");
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadReport, open, report?.latest_resolution]);

  const startResolution = async () => {
    if (!agentId) return;
    setStarting(true);
    try {
      const attempt = await catalogApi.resolveTaskConflict(
        token,
        taskId,
        agentId,
        instructions,
      );
      setReport((current) =>
        current ? { ...current, latest_resolution: attempt } : current,
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start resolution");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mt-2 border-l-2 border-orange-700 pl-3">
      <button
        onClick={() => void toggle()}
        className="text-[9px] font-bold uppercase tracking-wider text-orange-300 hover:underline"
      >
        {open ? "Hide conflict report" : "Inspect conflict"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {loading && <p className="text-[10px] text-dim">Loading conflict report.</p>}
          {error && <p className="text-[10px] text-orange-300">{error}</p>}
          {report && (
            <>
              <p className="text-[10px] text-orange-200">
                Conflicting files: {report.conflict_files.join(", ")}
              </p>
              <p className="break-all text-[9px] text-dim">
                Preserved workspace: {report.workspace}
              </p>
              <div className="border border-orange-700/40 bg-orange-900/10 p-3">
                <p className="text-[9px] font-bold uppercase tracking-wider text-orange-200">
                  Assisted resolution
                </p>
                {report.latest_resolution && (
                  <div className="mt-2 space-y-1 text-[10px] text-dim">
                    <p>
                      {report.latest_resolution.agent_name} ·{" "}
                      <span
                        className={
                          report.latest_resolution.status === "passed"
                            ? "text-phosphor"
                            : report.latest_resolution.status === "failed"
                              ? "text-orange-300"
                              : "text-signal"
                        }
                      >
                        {report.latest_resolution.status}
                      </span>
                    </p>
                    <p>
                      Verification: {report.latest_resolution.test_status}
                      {report.latest_resolution.test_command
                        ? ` · ${report.latest_resolution.test_command}`
                        : ""}
                    </p>
                    {report.latest_resolution.resolution_sha && (
                      <p>
                        Resolution checkpoint:{" "}
                        {report.latest_resolution.resolution_sha.slice(0, 12)}
                      </p>
                    )}
                    {report.latest_resolution.error && (
                      <p className="text-orange-300">
                        {report.latest_resolution.error}
                      </p>
                    )}
                    {report.latest_resolution.test_output_excerpt && (
                      <details>
                        <summary className="cursor-pointer text-[9px] font-bold uppercase text-signal">
                          Verification output
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border-l border-[#292824] pl-3 text-[9px]">
                          {report.latest_resolution.test_output_excerpt}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
                {!["queued", "running", "passed"].includes(
                  report.latest_resolution?.status ?? "",
                ) && (
                  <>
                    <select
                      value={agentId}
                      onChange={(event) => setAgentId(event.target.value)}
                      className="field mt-3"
                      aria-label="Conflict resolver"
                    >
                      <option value="">Choose a resolver agent</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.role} · {agent.provider}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                      rows={2}
                      maxLength={8000}
                      placeholder="Optional guidance about the intended resolution"
                      className="field mt-2"
                    />
                    <button
                      disabled={starting || !agentId}
                      onClick={() => void startResolution()}
                      className="mt-2 bg-orange-300 px-3 py-2 text-[9px] font-bold uppercase text-black disabled:opacity-40"
                    >
                      {starting ? "Queueing resolver" : "Run assisted resolution"}
                    </button>
                  </>
                )}
                {report.latest_resolution?.status === "passed" && (
                  <p className="mt-2 text-[10px] text-phosphor">
                    Resolution and verification passed. Review the patch, then use Retry merge
                    in the approval panel.
                  </p>
                )}
              </div>
              <details>
                <summary className="cursor-pointer text-[9px] font-bold uppercase text-signal">
                  Task and mission file changes
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-[#292824] p-3 text-[10px] text-dim">
                  {`Task branch:\n${report.task_changes || "(none)"}\nMission branch:\n${report.mission_changes || "(none)"}`}
                </pre>
              </details>
              <details>
                <summary className="cursor-pointer text-[9px] font-bold uppercase text-signal">
                  Task patch
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words border border-[#292824] p-3 text-[10px] text-dim">
                  {report.diff || "(No patch output)"}
                  {report.truncated && "\n[Patch truncated.]"}
                </pre>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TaskChanges({ token, taskId }: { token: string; taskId: string }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (diff || loading) return;
    setLoading(true);
    try {
      const loaded = await catalogApi.taskDiff(token, taskId);
      setDiff(loaded.diff);
      setTruncated(loaded.truncated);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load the changes");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2">
      <button
        onClick={() => void toggle()}
        className="text-[9px] font-bold uppercase tracking-wider text-signal hover:underline"
      >
        {open ? "Hide changes" : "View changes"}
      </button>
      {open && (
        <div className="mt-2">
          {loading && <p className="text-[10px] text-dim">Loading changes.</p>}
          {error && <p className="text-[10px] text-orange-300">{error}</p>}
          {diff && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-l border-[#292824] pl-3 text-[10px] leading-4 text-dim">
              {diff}
              {truncated && "\n[Diff truncated. Use git show in the repository for the rest.]"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
