"use client";

import { KeyRound } from "lucide-react";
import { useAdminToken } from "@/features/auth/use-admin-token";
import { cn } from "@/lib/cn";

export function AdminTokenControl({ className }: { className?: string }) {
  const { token, updateToken } = useAdminToken();
  return <label className={cn("hidden items-center gap-2 text-[9px] uppercase tracking-[0.12em] text-dim lg:flex", className)}>
    <KeyRound className="h-3 w-3 text-signal" />
    <input aria-label="Local admin token" value={token} onChange={(event) => updateToken(event.target.value)} placeholder="admin token" type="password" className="min-w-0 flex-1 border-b border-[#292824] bg-transparent px-1 py-1 text-[10px] normal-case tracking-normal text-terminal outline-none focus:border-signal lg:w-44 lg:flex-none" />
  </label>;
}
