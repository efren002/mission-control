"use client";

import { Bell, Check, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RealtimeEvent } from "@/features/system/types";

type ConnectionState = "connecting" | "connected" | "disconnected";

interface Notification extends RealtimeEvent {
  id: number;
  receivedAt: string;
}

const ignoredEventTypes = new Set(["system.keepalive", "system.heartbeat"]);

function eventTitle(type: string) {
  const titles: Record<string, string> = {
    "system.connected": "Command uplink connected",
    "planner.started": "Planning started",
    "planner.completed": "Planning completed",
    "planner.failed": "Planning failed",
  };

  return titles[type] ?? type.replaceAll(".", " ");
}

function eventDetail(event: RealtimeEvent) {
  if (typeof event.detail === "string") return event.detail;
  if (typeof event.title === "string") return event.title;
  if (typeof event.task_count === "number") {
    return `${event.task_count} task${event.task_count === 1 ? "" : "s"} generated`;
  }
  return event.source ? `Source: ${event.source}` : "Mission Control event";
}

export function NotificationCenter({
  connectionState,
  lastEvent,
}: {
  connectionState: ConnectionState;
  lastEvent: RealtimeEvent | null;
}) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const nextId = useRef(0);
  const openRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lastEvent || ignoredEventTypes.has(lastEvent.type)) return;

    const notification: Notification = {
      ...lastEvent,
      id: nextId.current++,
      receivedAt: lastEvent.timestamp ?? new Date().toISOString(),
    };
    setNotifications((current) => [notification, ...current].slice(0, 20));
    if (!openRef.current) setUnreadCount((current) => current + 1);
  }, [lastEvent]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        openRef.current = false;
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        openRef.current = false;
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggle = () => {
    setOpen((current) => {
      if (!current) setUnreadCount(0);
      openRef.current = !current;
      return openRef.current;
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
        className="relative grid h-8 w-8 place-items-center border border-[#292824] text-dim transition hover:border-signal/30 hover:text-signal"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center bg-signal px-1 font-mono text-[8px] font-bold text-black">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <section
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-10 z-50 w-[min(22rem,calc(100vw-2rem))] border border-[#34322d] bg-[#0a0a09] shadow-[0_18px_60px_rgba(0,0,0,0.65)]"
        >
          <div className="flex items-center justify-between border-b border-[#292824] px-4 py-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-terminal">
                Notifications
              </p>
              <p className="mt-1 text-[9px] text-dim">
                Uplink {connectionState}
              </p>
            </div>
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setNotifications([]);
                  setUnreadCount(0);
                }}
                className="inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-dim transition hover:text-signal"
              >
                <Trash2 className="h-3 w-3" /> Clear
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.map((notification) => (
              <article
                key={notification.id}
                className="border-b border-[#292824] px-4 py-3 last:border-b-0"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center border border-signal/30 bg-signal/[0.06]">
                    <Check className="h-3 w-3 text-signal" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] capitalize text-terminal">
                      {eventTitle(notification.type)}
                    </p>
                    <p className="mt-1 truncate text-[9px] text-dim">
                      {eventDetail(notification)}
                    </p>
                    <time className="mt-2 block font-mono text-[8px] uppercase text-[#55524c]">
                      {new Date(notification.receivedAt).toLocaleString()}
                    </time>
                  </div>
                </div>
              </article>
            ))}
            {notifications.length === 0 && (
              <div className="px-5 py-10 text-center">
                <Bell className="mx-auto h-4 w-4 text-[#55524c]" />
                <p className="mt-3 text-[10px] text-dim">No notifications yet.</p>
                <p className="mt-1 text-[9px] text-[#55524c]">
                  Workflow activity will appear here.
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
