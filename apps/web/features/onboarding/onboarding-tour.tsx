"use client";

import {
  CheckCircle2,
  Compass,
  Eye,
  Plug,
  Rocket,
  Satellite,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/cn";

import {
  isTourCompleted,
  markTourCompleted,
  OPEN_TOUR_EVENT,
} from "./onboarding-state";

const tourSteps = [
  {
    icon: Satellite,
    title: "Welcome to Mission Control",
    body: "Mission Control orchestrates AI coding agents on your own machine. You describe the outcome, agents plan and build it, and every repository edit waits for your explicit approval first.",
    link: null,
  },
  {
    icon: Plug,
    title: "Connect a provider",
    body: "Open Settings and press Connect on the Codex or Claude card, then finish the sign-in link it shows. The Missions screen displays a reminder banner while any provider is disconnected.",
    link: { label: "Open Settings", href: "/settings" },
  },
  {
    icon: Rocket,
    title: "Start a mission",
    body: "Missions is the one-screen guided workflow. Describe what you want to build and press Start mission. A project is created automatically and the planner drafts tasks for your review.",
    link: { label: "Open Missions", href: "/missions" },
  },
  {
    icon: CheckCircle2,
    title: "Approve the plan, then build",
    body: "Review the drafted tasks inline and approve the plan, then press Build project. Nothing edits a repository until you give this explicit go-ahead.",
    link: null,
  },
  {
    icon: Eye,
    title: "Watch, verify, and undo",
    body: "Agent output streams live while tasks run, and every completed task saves a Git checkpoint. Use View changes to inspect a task, Undo this task to roll it back, and Run tests or Run app to verify the finished build.",
    link: null,
  },
  {
    icon: Compass,
    title: "Explore at your own pace",
    body: "The Dashboard tracks your setup checklist, and the Advanced sidebar section (Objectives, Runs, Approvals, Tasks) gives step-by-step control. Reopen this guide anytime from the Guide button in the top bar.",
    link: null,
  },
] as const;

export function OnboardingTour() {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!isTourCompleted()) setOpen(true);
    const reopen = () => {
      setStepIndex(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_TOUR_EVENT, reopen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, reopen);
  }, []);

  const close = useCallback(() => {
    markTourCompleted();
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  if (!open) return null;

  const step = tourSteps[stepIndex];
  const lastStep = stepIndex === tourSteps.length - 1;
  const Icon = step.icon;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Mission Control guide"
        className="w-full max-w-lg border border-[#292824] bg-[#0d0d0c] shadow-[0_0_40px_rgba(0,0,0,0.8)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#292824] px-5 py-3.5">
          <p className="eyebrow">Field guide</p>
          <div className="flex items-center gap-3">
            <p className="font-mono text-[10px] text-dim">
              {String(stepIndex + 1).padStart(2, "0")} /{" "}
              {String(tourSteps.length).padStart(2, "0")}
            </p>
            <button
              type="button"
              aria-label="Close guide"
              onClick={close}
              className="grid h-7 w-7 place-items-center border border-[#292824] text-dim hover:border-signal/40 hover:text-signal"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="p-5">
          <div className="mb-4 grid h-10 w-10 place-items-center border border-signal/40 bg-signal/[0.06]">
            <Icon className="h-4 w-4 text-signal" />
          </div>
          <h2 className="text-base font-semibold text-terminal">{step.title}</h2>
          <p className="mt-2 text-xs leading-5 text-dim">{step.body}</p>
          {step.link && (
            <Link
              href={step.link.href}
              onClick={close}
              className="mt-4 inline-flex border border-[#292824] px-3 py-1.5 text-[10px] uppercase tracking-wider text-terminal hover:border-signal hover:text-signal"
            >
              {step.link.label}
            </Link>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[#292824] px-5 py-3.5">
          <div className="flex items-center gap-1.5">
            {tourSteps.map((entry, index) => (
              <button
                key={entry.title}
                type="button"
                aria-label={`Go to step ${index + 1}`}
                aria-current={index === stepIndex}
                onClick={() => setStepIndex(index)}
                className={cn(
                  "h-1.5 w-1.5",
                  index === stepIndex
                    ? "bg-signal"
                    : index < stepIndex
                      ? "bg-signal/40"
                      : "bg-[#34322d]",
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {!lastStep && (
              <button
                type="button"
                onClick={close}
                className="px-3 py-2 text-[10px] uppercase tracking-wider text-dim hover:text-terminal"
              >
                Skip tour
              </button>
            )}
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => setStepIndex(stepIndex - 1)}
                className="border border-[#292824] px-4 py-2 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal"
              >
                Back
              </button>
            )}
            {lastStep ? (
              <Link
                href="/missions"
                onClick={close}
                className="bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black"
              >
                Start building
              </Link>
            ) : (
              <button
                type="button"
                autoFocus
                onClick={() => setStepIndex(stepIndex + 1)}
                className="bg-signal px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-black"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
