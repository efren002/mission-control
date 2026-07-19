"use client";

import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";

const VISIBILITY_THRESHOLD = 480;

export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateVisibility = () => {
      setVisible(window.scrollY > VISIBILITY_THRESHOLD);
    };

    updateVisibility();
    window.addEventListener("scroll", updateVisibility, { passive: true });

    return () => window.removeEventListener("scroll", updateVisibility);
  }, []);

  if (!visible) {
    return null;
  }

  const scrollToTop = () => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    window.scrollTo({
      top: 0,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  return (
    <button
      type="button"
      aria-label="Back to top"
      title="Back to top"
      onClick={scrollToTop}
      className="fixed bottom-4 right-4 z-30 grid h-11 w-11 place-items-center border border-signal/60 bg-[#0a0a09]/95 text-signal shadow-glow backdrop-blur transition-colors hover:border-signal hover:bg-signal hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal sm:bottom-6 sm:right-6"
    >
      <ArrowUp className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
