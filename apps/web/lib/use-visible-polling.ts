"use client";

import { useEffect, useRef } from "react";

export function useVisiblePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
  refreshKey = "",
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let running = false;

    const run = async () => {
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true;
      try {
        await callbackRef.current();
      } finally {
        running = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void run();
    };

    void run();
    const timer = window.setInterval(() => void run(), intervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs, refreshKey]);
}
