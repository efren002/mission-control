"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const SAFETY_TIMEOUT_MS = 10_000;

function isNavigatingLink(event: MouseEvent, pathname: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return false;
  }

  const target = event.target;
  if (!(target instanceof Element)) return false;

  const anchor = target.closest("a");
  if (
    !anchor ||
    anchor.target === "_blank" ||
    anchor.hasAttribute("download")
  ) {
    return false;
  }

  const destination = new URL(anchor.href, window.location.href);
  return (
    destination.origin === window.location.origin &&
    destination.pathname !== pathname
  );
}

export function NavigationFeedback() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (previousPathname.current !== pathname) {
      previousPathname.current = pathname;
      setLoading(false);
    }
  }, [pathname]);

  useEffect(() => {
    let safetyTimeout: number | undefined;

    const startLoading = (event: MouseEvent) => {
      if (!isNavigatingLink(event, pathname)) return;

      setLoading(true);
      window.clearTimeout(safetyTimeout);
      safetyTimeout = window.setTimeout(
        () => setLoading(false),
        SAFETY_TIMEOUT_MS,
      );
    };

    document.addEventListener("click", startLoading);
    return () => {
      document.removeEventListener("click", startLoading);
      window.clearTimeout(safetyTimeout);
    };
  }, [pathname]);

  if (!loading) return null;

  return (
    <>
      <div
        className="route-progress fixed inset-x-0 top-0 z-[80] h-0.5 overflow-hidden bg-signal/15"
        role="progressbar"
        aria-label="Loading page"
      >
        <span className="block h-full bg-signal shadow-[0_0_10px_#ff5a0a]" />
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        Loading page
      </span>
    </>
  );
}
