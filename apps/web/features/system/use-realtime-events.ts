"use client";

import { useEffect, useSyncExternalStore } from "react";

import { applicationConfig } from "@/lib/config";

import type { FeedEvent, RealtimeEvent } from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected";

interface RealtimeSnapshot {
  connectionState: ConnectionState;
  lastEvent: RealtimeEvent | null;
  events: FeedEvent[];
}

const FEED_LIMIT = 20;
// Keep the socket open briefly after the last subscriber unmounts so route
// transitions and StrictMode remounts reuse the connection instead of
// reconnecting (which would spam the feed with system.connected events).
const CLOSE_LINGER_MS = 2_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;

const INITIAL_SNAPSHOT: RealtimeSnapshot = {
  connectionState: "connecting",
  lastEvent: null,
  events: [],
};

let snapshot = INITIAL_SNAPSHOT;
let socket: WebSocket | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let retryAttempt = 0;
let adminToken = "";
const listeners = new Set<() => void>();

function publish(next: Partial<RealtimeSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function connect() {
  if (socket || !adminToken) {
    if (!adminToken) publish({ connectionState: "disconnected" });
    return;
  }
  publish({ connectionState: "connecting" });
  const encodedToken = btoa(
    String.fromCharCode(...new TextEncoder().encode(adminToken)),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const ws = new WebSocket(applicationConfig.websocketUrl, [
    "mission-control",
    `bearer.${encodedToken}`,
  ]);
  socket = ws;
  ws.onopen = () => {
    retryAttempt = 0;
    publish({ connectionState: "connected" });
  };
  ws.onmessage = (event: MessageEvent<string>) => {
    let parsed: RealtimeEvent;
    try {
      parsed = JSON.parse(event.data) as RealtimeEvent;
    } catch {
      return;
    }
    if (parsed.type === "system.keepalive") {
      publish({ lastEvent: parsed });
      return;
    }
    publish({
      lastEvent: parsed,
      events: [{ ...parsed, receivedAt: Date.now() }, ...snapshot.events].slice(
        0,
        FEED_LIMIT,
      ),
    });
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    publish({ connectionState: "disconnected" });
    if (listeners.size === 0) return;
    const backoff = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_MAX_MS);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, backoff + Math.random() * 500);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  if (!socket && !retryTimer) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      retryAttempt = 0;
      const ws = socket;
      socket = undefined;
      ws?.close();
    }, CLOSE_LINGER_MS);
  };
}

function getSnapshot(): RealtimeSnapshot {
  return snapshot;
}

function getServerSnapshot(): RealtimeSnapshot {
  return INITIAL_SNAPSHOT;
}

function setAdminToken(token: string) {
  if (adminToken === token) return;
  adminToken = token;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  retryAttempt = 0;
  const previous = socket;
  socket = undefined;
  previous?.close();
  if (listeners.size > 0) connect();
}

/**
 * Subscribes to the shared realtime event stream. All callers share a single
 * WebSocket connection and see the same feed.
 */
export function useRealtimeEvents(token: string): RealtimeSnapshot {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => setAdminToken(token), [token]);
  return state;
}

/** Tears down the shared connection and state. Test use only. */
export function resetRealtimeEventsForTesting() {
  listeners.clear();
  if (retryTimer) clearTimeout(retryTimer);
  if (closeTimer) clearTimeout(closeTimer);
  retryTimer = undefined;
  closeTimer = undefined;
  retryAttempt = 0;
  adminToken = "";
  const ws = socket;
  socket = undefined;
  ws?.close();
  snapshot = INITIAL_SNAPSHOT;
}
