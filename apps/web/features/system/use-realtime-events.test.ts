import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetRealtimeEventsForTesting,
  useRealtimeEvents,
} from "@/features/system/use-realtime-events";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.onclose?.();
  }

  receive(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

describe("useRealtimeEvents", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    resetRealtimeEventsForTesting();
    vi.unstubAllGlobals();
  });

  it("collects a newest-first feed and skips keepalives", () => {
    const { result } = renderHook(() => useRealtimeEvents());
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.onopen?.();
      socket.receive({ type: "system.connected", source: "api" });
      socket.receive({ type: "system.keepalive", source: "api" });
      socket.receive({ type: "run.created", source: "workflow" });
    });

    expect(result.current.connectionState).toBe("connected");
    expect(result.current.lastEvent?.type).toBe("run.created");
    expect(result.current.events.map((event) => event.type)).toEqual([
      "run.created",
      "system.connected",
    ]);
    expect(result.current.events[0].receivedAt).toBeTypeOf("number");
  });

  it("caps the feed at twenty events", () => {
    const { result } = renderHook(() => useRealtimeEvents());
    const socket = FakeWebSocket.instances[0];

    act(() => {
      for (let index = 0; index < 25; index += 1) {
        socket.receive({ type: `task.started.${index}`, source: "workflow" });
      }
    });

    expect(result.current.events).toHaveLength(20);
    expect(result.current.events[0].type).toBe("task.started.24");
  });

  it("shares one connection across consumers", () => {
    const first = renderHook(() => useRealtimeEvents());
    const second = renderHook(() => useRealtimeEvents());
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.onopen?.();
      socket.receive({ type: "run.created", source: "workflow" });
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(first.result.current.events).toHaveLength(1);
    expect(second.result.current.events).toEqual(first.result.current.events);
  });

  it("keeps the connection open across a quick remount", () => {
    vi.useFakeTimers();
    try {
      const first = renderHook(() => useRealtimeEvents());
      first.unmount();
      renderHook(() => useRealtimeEvents());
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
