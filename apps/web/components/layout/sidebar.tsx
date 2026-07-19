"use client";

import {
  Activity,
  Bot,
  CheckCircle2,
  Database,
  FolderKanban,
  Gauge,
  GitBranch,
  ListTodo,
  Menu,
  Radar,
  Rocket,
  Settings,
  Target,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { AdminTokenControl } from "@/components/layout/admin-token-control";
import { cn } from "@/lib/cn";

const navigationSections = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", href: "/", icon: Gauge }],
  },
  {
    label: "Build",
    items: [
      { label: "Missions", href: "/missions", icon: Rocket },
      { label: "Operations", href: "/operations", icon: Radar },
    ],
  },
  {
    label: "Setup",
    items: [
      { label: "Projects", href: "/projects", icon: FolderKanban },
      { label: "Repositories", href: "/repositories", icon: GitBranch },
      { label: "Agents", href: "/agents", icon: Bot },
      { label: "Settings", href: "/settings", icon: Settings },
    ],
  },
  {
    label: "Advanced",
    items: [
      { label: "Objectives", href: "/objectives", icon: Target },
      { label: "Runs", href: "/runs", icon: Activity },
      { label: "Approvals", href: "/approvals", icon: CheckCircle2 },
      { label: "Tasks", href: "/tasks", icon: ListTodo },
    ],
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-[#292824] bg-[#0a0a09] lg:flex">
      <Brand />
      <Navigation pathname={pathname} />
      <NodeStatus />
    </aside>
  );
}

export function MobileNavigation() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="grid h-9 w-9 shrink-0 place-items-center border border-[#292824] text-dim transition hover:border-signal/40 hover:text-signal lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>
      {/* Portaled to <body>: the topbar's backdrop-blur creates a containing
          block for fixed descendants, which would clip this overlay to the
          64px header. */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[60] lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label="Mobile navigation"
              className="relative flex h-full w-[min(19rem,88vw)] flex-col overflow-y-auto border-r border-[#34322d] bg-[#0a0a09] shadow-[20px_0_60px_rgba(0,0,0,0.65)]"
            >
              <div className="relative">
                <Brand />
                <button
                  type="button"
                  aria-label="Close navigation panel"
                  onClick={() => setOpen(false)}
                  className="absolute right-4 top-3.5 grid h-9 w-9 place-items-center border border-[#292824] text-dim hover:text-signal"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="border-b border-[#292824] p-4">
                <AdminTokenControl className="flex w-full lg:hidden" />
              </div>
              <Navigation
                pathname={pathname}
                onNavigate={() => setOpen(false)}
              />
              <NodeStatus />
            </aside>
          </div>,
          document.body,
        )}
    </>
  );
}

function Brand() {
  return (
    <div className="flex h-16 shrink-0 items-center gap-3 border-b border-[#292824] px-5">
      <div className="grid h-8 w-8 place-items-center border border-signal/40 bg-signal/[0.06]">
        <Database className="h-3.5 w-3.5 text-signal" />
      </div>
      <div>
        <p className="font-mono text-[11px] font-bold tracking-[0.12em] text-terminal">
          MISSION
        </p>
        <p className="font-mono text-[8px] tracking-[0.28em] text-signal">
          CONTROL
        </p>
      </div>
    </div>
  );
}

function Navigation({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 space-y-5 p-3">
      {navigationSections.map((section) => (
        <div key={section.label}>
          <p className="mb-2 px-2 text-[8px] font-bold uppercase tracking-[0.18em] text-[#55524c]">
            {section.label}
          </p>
          <div className="space-y-0.5">
            {section.items.map(({ label, href, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={onNavigate}
                  className={cn(
                    "group flex items-center gap-3 border-l-2 px-2.5 py-2 text-xs transition-colors",
                    active
                      ? "border-l-signal bg-signal/[0.07] text-terminal"
                      : "border-l-transparent text-dim hover:bg-white/[0.025] hover:text-terminal",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function NodeStatus() {
  return (
    <div className="border-t border-[#292824] p-3">
      <div className="border border-[#292824] bg-white/[0.015] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-[0.14em] text-dim">
            Local node
          </span>
          <span className="h-1.5 w-1.5 bg-phosphor shadow-[0_0_7px_#9bbd86]" />
        </div>
        <p className="font-mono text-[11px] text-terminal">MC-PRIMARY</p>
      </div>
    </div>
  );
}
