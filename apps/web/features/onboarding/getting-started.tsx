"use client";

import { BookOpenCheck, CheckCircle2, Circle, ListChecks, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useAdminToken } from "@/features/auth/use-admin-token";
import { catalogApi } from "@/features/catalog/api";
import { cn } from "@/lib/cn";

import {
  dismissChecklist,
  isChecklistDismissed,
  openOnboardingTour,
} from "./onboarding-state";

interface ChecklistProgress {
  providerConnected: boolean;
  missionStarted: boolean;
  planApproved: boolean;
  projectBuilt: boolean;
}

const emptyProgress: ChecklistProgress = {
  providerConnected: false,
  missionStarted: false,
  planApproved: false,
  projectBuilt: false,
};

interface ChecklistStep {
  key: keyof ChecklistProgress;
  title: string;
  detail: string;
  href: string;
  action: string;
}

const checklistSteps: ChecklistStep[] = [
  {
    key: "providerConnected",
    title: "Connect an AI provider",
    detail: "Press Connect on the Codex or Claude card and finish the sign-in link.",
    href: "/settings",
    action: "Open Settings",
  },
  {
    key: "missionStarted",
    title: "Start your first mission",
    detail: "Describe what you want to build and let the planner draft the tasks.",
    href: "/missions",
    action: "Open Missions",
  },
  {
    key: "planApproved",
    title: "Approve the generated plan",
    detail: "Review the drafted tasks inline and approve them on the mission screen.",
    href: "/missions",
    action: "Review plan",
  },
  {
    key: "projectBuilt",
    title: "Build the project",
    detail: "Press Build project and watch the tasks complete with live output.",
    href: "/missions",
    action: "Open Missions",
  },
];

export function GettingStarted() {
  const { token } = useAdminToken();
  const [dismissed, setDismissed] = useState(true);
  const [progress, setProgress] = useState<ChecklistProgress | null>(null);

  useEffect(() => {
    setDismissed(isChecklistDismissed());
  }, []);

  useEffect(() => {
    if (!token || dismissed) return;
    let active = true;
    const load = async () => {
      try {
        const [providerData, objectives, approvals, runs] = await Promise.all([
          catalogApi.providers(token),
          catalogApi.objectives(token),
          catalogApi.approvals(token),
          catalogApi.runs(token),
        ]);
        if (!active) return;
        setProgress({
          providerConnected: Object.values(providerData.providers).some(
            (provider) => provider.authenticated === true,
          ),
          missionStarted: objectives.length > 0,
          planApproved: approvals.some(
            (approval) => approval.status === "approved",
          ),
          projectBuilt: runs.some((run) => run.status === "completed"),
        });
      } catch {
        // The checklist stays hidden until protected telemetry is reachable.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [token, dismissed]);

  const shown = progress ?? emptyProgress;
  const completedCount = checklistSteps.filter((step) => shown[step.key]).length;
  const allComplete = completedCount === checklistSteps.length;

  // Stay out of the way once setup is finished, dismissed, or still loading.
  if (dismissed || !token || progress === null || allComplete) return null;

  return (
    <section
      aria-label="Getting started checklist"
      className="control-panel mb-8 p-5"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Getting started</p>
          <h2 className="mt-2 text-lg font-semibold text-white">
            First mission checklist
          </h2>
          <p className="mt-1 text-[10px] text-dim">
            {completedCount} of {checklistSteps.length} steps complete
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ListChecks className="hidden h-4 w-4 text-signal sm:block" />
          <button
            type="button"
            aria-label="Dismiss checklist"
            onClick={() => {
              dismissChecklist();
              setDismissed(true);
            }}
            className="grid h-7 w-7 place-items-center border border-[#292824] text-dim hover:border-signal/40 hover:text-signal"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mb-4 h-0.5 w-full bg-signal/10">
        <div
          className="h-full bg-signal transition-all"
          style={{
            width: `${Math.round((completedCount / checklistSteps.length) * 100)}%`,
          }}
        />
      </div>

      <div>
        {checklistSteps.map((step, index) => {
          const done = shown[step.key];
          return (
            <div
              key={step.key}
              className="flex items-center gap-3 border-t border-[#292824] py-3 first:border-t-0"
            >
              {done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-phosphor" />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-[#55524c]" />
              )}
              <span className="hidden w-6 shrink-0 font-mono text-[10px] text-[#55524c] sm:block">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-xs",
                    done ? "text-dim line-through" : "text-terminal",
                  )}
                >
                  {step.title}
                </p>
                {!done && (
                  <p className="mt-0.5 hidden text-[10px] leading-4 text-dim sm:block">
                    {step.detail}
                  </p>
                )}
              </div>
              {!done && (
                <Link
                  href={step.href}
                  className="shrink-0 border border-[#292824] px-3 py-1.5 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal"
                >
                  {step.action}
                </Link>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={openOnboardingTour}
        className="mt-4 inline-flex items-center gap-2 text-[10px] uppercase tracking-wider text-dim hover:text-signal"
      >
        <BookOpenCheck className="h-3.5 w-3.5" />
        Replay the guide
      </button>
    </section>
  );
}
