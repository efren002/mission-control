"use client";

import { CircleHelp, Radio } from "lucide-react";

import { NotificationCenter } from "@/components/layout/notification-center";
import { StatusPill } from "@/components/status/status-pill";
import { useRealtimeEvents } from "@/features/system/use-realtime-events";
import { AdminTokenControl } from "@/components/layout/admin-token-control";
import { MobileNavigation } from "@/components/layout/sidebar";
import { openOnboardingTour } from "@/features/onboarding/onboarding-state";

export function Topbar() {
  const { connectionState, lastEvent } = useRealtimeEvents();
  const connected = connectionState === "connected";

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-[#292824] bg-[#0a0a09]/95 px-3 backdrop-blur md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <MobileNavigation />
        <AdminTokenControl />
        <div className="hidden h-5 border-r border-[#292824] lg:block" />
        <Radio className="hidden h-3.5 w-3.5 shrink-0 text-signal sm:block" />
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-terminal">
            Command uplink
          </p>
          <p className="hidden truncate text-[9px] text-dim sm:block">
            droid -- mission control -- local
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          aria-label="Open guide"
          onClick={openOnboardingTour}
          className="inline-flex h-9 items-center gap-2 border border-[#292824] px-2.5 text-[10px] uppercase tracking-wider text-dim transition hover:border-signal/40 hover:text-signal"
        >
          <CircleHelp className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Guide</span>
        </button>
        <div className="hidden sm:block">
          <StatusPill label={connectionState} active={connected} />
        </div>
        <NotificationCenter
          connectionState={connectionState}
          lastEvent={lastEvent}
        />
      </div>
    </header>
  );
}
