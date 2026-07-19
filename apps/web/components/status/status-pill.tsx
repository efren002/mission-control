import { cn } from "@/lib/cn";

interface StatusPillProps {
  label: string;
  active?: boolean;
}

export function StatusPill({ label, active = false }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em]",
        active
          ? "border-signal/30 bg-signal/[0.08] text-signal"
          : "border-[#292824] bg-white/[0.02] text-dim",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5",
          active ? "bg-signal shadow-[0_0_8px_#ff5a0a]" : "bg-[#55524c]",
        )}
      />
      {label}
    </span>
  );
}
