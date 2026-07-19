"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import type { DetectorKind, MaintenanceScheduleInput, Project } from "@/features/catalog/api";

import { DETECTOR_LABELS } from "./operations-board";

const INTERVAL_PRESETS: { label: string; seconds: number }[] = [
  { label: "Hourly", seconds: 3_600 },
  { label: "Every 6 hours", seconds: 21_600 },
  { label: "Daily", seconds: 86_400 },
  { label: "Weekly", seconds: 604_800 },
];

const DETECTOR_ORDER: DetectorKind[] = [
  "failing_test_diagnosis",
  "dependency_maintenance",
  "security_health",
  "repo_health",
  "documentation_drift",
  "issue_triage",
  "mission_template",
];

export function ScheduleForm({
  projects,
  onCreate,
}: {
  projects: Project[];
  onCreate: (input: MaintenanceScheduleInput) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState("");
  const [detectorKind, setDetectorKind] = useState<DetectorKind>("failing_test_diagnosis");
  const [name, setName] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(86_400);
  const [objectiveTitle, setObjectiveTitle] = useState("");
  const [objectiveDescription, setObjectiveDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const isTemplate = detectorKind === "mission_template";
  const canSubmit =
    Boolean(projectId) &&
    name.trim().length > 0 &&
    (!isTemplate || objectiveTitle.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const config = isTemplate
        ? { objective_title: objectiveTitle.trim(), objective_description: objectiveDescription.trim() }
        : {};
      await onCreate({
        project_id: projectId,
        name: name.trim(),
        detector_kind: detectorKind,
        interval_seconds: intervalSeconds,
        config,
        enabled,
      });
      setName("");
      setObjectiveTitle("");
      setObjectiveDescription("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="control-panel p-6">
      <div className="mb-5">
        <p className="eyebrow">New automation</p>
        <h2 className="mt-2 text-lg font-semibold text-white">Create schedule</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-[10px] uppercase text-dim">
          Project
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="field mt-2"
          >
            <option value="">Select a project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[10px] uppercase text-dim">
          Check type
          <select
            value={detectorKind}
            onChange={(event) => setDetectorKind(event.target.value as DetectorKind)}
            className="field mt-2"
          >
            {DETECTOR_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {DETECTOR_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[10px] uppercase text-dim">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nightly test check"
            className="field mt-2"
          />
        </label>
        <label className="block text-[10px] uppercase text-dim">
          Frequency
          <select
            value={intervalSeconds}
            onChange={(event) => setIntervalSeconds(Number(event.target.value))}
            className="field mt-2"
          >
            {INTERVAL_PRESETS.map((preset) => (
              <option key={preset.seconds} value={preset.seconds}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isTemplate && (
        <div className="mt-4 grid gap-4">
          <label className="block text-[10px] uppercase text-dim">
            Objective title
            <input
              value={objectiveTitle}
              onChange={(event) => setObjectiveTitle(event.target.value)}
              placeholder="Weekly dependency sweep"
              className="field mt-2"
            />
          </label>
          <label className="block text-[10px] uppercase text-dim">
            Objective description
            <textarea
              value={objectiveDescription}
              onChange={(event) => setObjectiveDescription(event.target.value)}
              rows={4}
              placeholder="What the recurring mission should accomplish."
              className="field mt-2 leading-5"
            />
          </label>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between">
        <label className="flex items-center gap-2 text-[10px] uppercase text-dim">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="accent-signal"
          />
          Enabled
        </label>
        <button
          onClick={submit}
          disabled={!canSubmit || submitting}
          className="inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black disabled:opacity-40"
        >
          <Plus className="h-3 w-3" /> Create schedule
        </button>
      </div>
    </section>
  );
}
