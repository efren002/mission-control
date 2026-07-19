"use client";

import { useEffect, useState } from "react";

import { applicationConfig } from "@/lib/config";

import type { FeedEvent, RealtimeEvent } from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected";

const FEED_LIMIT = 20;

export function useRealtimeEvents() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [lastEvent, setLastEvent] = useState<RealtimeEvent | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setConnectionState("connecting");
      socket = new WebSocket(applicationConfig.websocketUrl);
      socket.onopen = () => setConnectionState("connected");
      socket.onmessage = (event: MessageEvent<string>) => {
        const parsed = JSON.parse(event.data) as RealtimeEvent;
        setLastEvent(parsed);
        if (parsed.type !== "system.keepalive") {
          setEvents((current) =>
            [{ ...parsed, receivedAt: Date.now() }, ...current].slice(
              0,
              FEED_LIMIT,
            ),
          );
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        setConnectionState("disconnected");
        if (!disposed) retryTimer = setTimeout(connect, 3_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return { connectionState, lastEvent, events };
}
