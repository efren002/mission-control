"use client";

import { Radar } from "lucide-react";
import { useCallback, useState } from "react";

import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { useAdminToken } from "@/features/auth/use-admin-token";
import {
  catalogApi,
  type MaintenanceFinding,
  type MaintenanceRun,
  type MaintenanceSchedule,
  type MaintenanceScheduleInput,
  type OperationsOverview,
  type Project,
} from "@/features/catalog/api";
import {
  FindingsInbox,
  OverviewTiles,
  RunsList,
  SchedulesList,
} from "@/features/operations/operations-board";
import { ScheduleForm } from "@/features/operations/schedule-form";
import { useVisiblePolling } from "@/lib/use-visible-polling";

export default function OperationsPage() {
  const { token } = useAdminToken();
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [schedules, setSchedules] = useState<MaintenanceSchedule[]>([]);
  const [findings, setFindings] = useState<MaintenanceFinding[]>([]);
  const [runs, setRuns] = useState<MaintenanceRun[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [continuousEnabled, setContinuousEnabled] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [overviewData, scheduleData, findingData, runData, projectData, workflow] =
        await Promise.all([
          catalogApi.operationsOverview(token),
          catalogApi.maintenanceSchedules(token),
          catalogApi.maintenanceFindings(token, "proposed"),
          catalogApi.maintenanceRuns(token),
          catalogApi.projects(token),
          catalogApi.workflowSettings(token),
        ]);
      setOverview(overviewData);
      setSchedules(scheduleData);
      setFindings(findingData);
      setRuns(runData);
      setProjects(projectData);
      setContinuousEnabled(workflow.enable_continuous_operations);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load operations");
    }
  }, [token]);

  useVisiblePolling(load, 8_000, Boolean(token));

  const runAction = useCallback(
    async (id: string, action: () => Promise<void>, success: string) => {
      setBusyId(id);
      setError("");
      setMessage("");
      try {
        await action();
        setMessage(success);
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const approve = (finding: MaintenanceFinding) =>
    runAction(
      finding.id,
      () => catalogApi.approveMaintenanceFinding(token, finding.id).then(() => undefined),
      "Objective created and planning started. Review it under Missions.",
    );

  const dismiss = (finding: MaintenanceFinding) =>
    runAction(
      finding.id,
      () => catalogApi.dismissMaintenanceFinding(token, finding.id).then(() => undefined),
      "Finding dismissed.",
    );

  const runNow = (schedule: MaintenanceSchedule) =>
    runAction(
      schedule.id,
      () => catalogApi.runMaintenanceScheduleNow(token, schedule.id).then(() => undefined),
      "Check queued. Findings appear here when it completes.",
    );

  const toggle = (schedule: MaintenanceSchedule) =>
    runAction(
      schedule.id,
      () =>
        catalogApi
          .updateMaintenanceSchedule(token, schedule.id, { enabled: !schedule.enabled })
          .then(() => undefined),
      schedule.enabled ? "Schedule paused." : "Schedule enabled.",
    );

  const remove = (schedule: MaintenanceSchedule) =>
    runAction(
      schedule.id,
      () => catalogApi.deleteMaintenanceSchedule(token, schedule.id),
      "Schedule deleted.",
    );

  const createSchedule = async (input: MaintenanceScheduleInput) => {
    setError("");
    setMessage("");
    try {
      await catalogApi.createMaintenanceSchedule(token, input);
      setMessage("Schedule created.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create schedule");
    }
  };

  if (!token)
    return (
      <ModulePlaceholder
        eyebrow="Continuous operations"
        title="Operations"
        description="Enter the local admin token to review autonomous maintenance findings."
        icon={Radar}
      />
    );

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow mb-3">Continuous operations</p>
        <h1 className="text-2xl font-bold tracking-[-0.04em] text-terminal">Operations</h1>
        <p className="mt-2 text-xs text-dim">
          Scheduled maintenance checks find valuable work and propose it here. Nothing runs
          unattended, and no change is made until you approve a finding.
        </p>
      </div>
      {!continuousEnabled && (
        <p className="border border-orange-800/60 bg-orange-950/20 px-4 py-3 text-[11px] text-orange-200">
          Continuous operations is off. Schedules will not run on their own until you enable it in
          Settings. You can still trigger a check with Run.
        </p>
      )}
      {error && <p className="text-xs text-orange-300">{error}</p>}
      {message && <p className="text-xs text-signal">{message}</p>}

      <OverviewTiles overview={overview} continuousEnabled={continuousEnabled} />
      <FindingsInbox findings={findings} busyId={busyId} onApprove={approve} onDismiss={dismiss} />
      <div className="grid gap-6 xl:grid-cols-2">
        <SchedulesList
          schedules={schedules}
          busyId={busyId}
          onRunNow={runNow}
          onToggle={toggle}
          onDelete={remove}
        />
        <ScheduleForm projects={projects} onCreate={createSchedule} />
      </div>
      <RunsList runs={runs} />
    </div>
  );
}
