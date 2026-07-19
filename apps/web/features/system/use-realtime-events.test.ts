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

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
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
    const { result } = renderHook(() => useRealtimeEvents("local-token"));
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
    const { result } = renderHook(() => useRealtimeEvents("local-token"));
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
    const first = renderHook(() => useRealtimeEvents("local-token"));
    const second = renderHook(() => useRealtimeEvents("local-token"));
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
      const first = renderHook(() => useRealtimeEvents("local-token"));
      first.unmount();
      renderHook(() => useRealtimeEvents("local-token"));
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("authenticates without putting the token in the websocket URL", () => {
    renderHook(() => useRealtimeEvents("secret token"));
    const socket = FakeWebSocket.instances[0];

    expect(socket.url).not.toContain("secret");
    expect(socket.protocols).toEqual([
      "mission-control",
      "bearer.c2VjcmV0IHRva2Vu",
    ]);
  });
});
