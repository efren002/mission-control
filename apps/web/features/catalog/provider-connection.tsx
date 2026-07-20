"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, KeyRound, LoaderCircle, X } from "lucide-react";

import { catalogApi, type ProviderLoginSession, type ProviderStatus } from "@/features/catalog/api";
import { providerLabel } from "@/features/catalog/provider-options";

const ACTIVE_STATUSES = new Set(["starting", "awaiting_browser", "awaiting_input", "verifying"]);
const POLL_INTERVAL_MS = 2_000;

// Only CLI providers own a sign-in flow; HTTP providers authenticate via an
// environment variable configured in providers.json and never need a banner.
const CLI_LOGIN_PROVIDERS = ["codex", "claude"] as const;

export function ProviderConnectionBanner({ token }: { token: string }) {
  const [disconnected, setDisconnected] = useState<string[]>([]);

  useEffect(() => {
    if (!token) return;
    let disposed = false;
    const check = async () => {
      try {
        // Only CLI providers that are actually in use (the planner provider or
        // any enabled agent's provider) can block planning. A user running on a
        // custom HTTP provider shouldn't be nagged to sign in to codex/claude.
        const [{ providers }, { planner_provider: planner }, agents] = await Promise.all([
          catalogApi.providers(token),
          catalogApi.workflowSettings(token),
          catalogApi.agents(token),
        ]);
        if (disposed) return;
        const inUse = new Set<string>([planner, ...agents.map((agent) => agent.provider)]);
        setDisconnected(
          CLI_LOGIN_PROVIDERS.filter(
            (name) => inUse.has(name) && providers[name] && providers[name].authenticated !== true,
          ),
        );
      } catch {
        // Leave the banner unchanged while the gateway is unreachable.
      }
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [token]);

  if (disconnected.length === 0) return null;
  const names = disconnected.map((name) => providerLabel(name)).join(" and ");
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border border-orange-700/70 bg-orange-950/20 px-4 py-3">
      <p className="text-xs text-orange-200">{names} {disconnected.length === 1 ? "is" : "are"} not connected. Agents cannot plan or build until every provider you use is signed in.</p>
      <Link href="/settings" className="border border-orange-700/70 px-3 py-1.5 text-[10px] uppercase tracking-wider text-orange-200 hover:border-orange-400 hover:text-orange-100">Connect in Settings</Link>
    </div>
  );
}

export function ProviderConnectionCard({ provider, status, token, onAuthenticated, onEdit, onDelete }: {
  provider: string;
  status: ProviderStatus | undefined;
  token: string;
  onAuthenticated: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [session, setSession] = useState<ProviderLoginSession | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<{ ok: boolean; models?: string[]; error?: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const notifiedRef = useRef(false);

  const authenticated = status?.authenticated === true;
  const active = session !== null && ACTIVE_STATUSES.has(session.status);

  // The HTTP render branch below returns before any login call runs, so when
  // we reach the CLI login API (typed "codex" | "claude") provider is CLI.
  const cliProvider = provider as "codex" | "claude";

  const applySession = useCallback((next: ProviderLoginSession | null) => {
    setSession(next);
    if (next?.status === "succeeded" && !notifiedRef.current) {
      notifiedRef.current = true;
      onAuthenticated();
    }
  }, [onAuthenticated]);

  // Resume a login that is already in progress, for example after a page reload.
  useEffect(() => {
    if (authenticated || status?.kind === "http") return;
    let disposed = false;
    void catalogApi.providerLoginStatus(token, cliProvider).then((existing) => {
      if (!disposed && existing && ACTIVE_STATUSES.has(existing.status)) setSession(existing);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [authenticated, cliProvider, token, status]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void catalogApi.providerLoginStatus(token, cliProvider).then(applySession).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, applySession, cliProvider, token]);

  const begin = async () => {
    setBusy(true);
    setError("");
    notifiedRef.current = false;
    try {
      // A 409 also returns the already-running session, so this resumes it.
      applySession(await catalogApi.startProviderLogin(token, cliProvider));
      setCode("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start sign-in");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      applySession(await catalogApi.submitProviderLoginCode(token, cliProvider, code.trim()));
      setCode("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to submit the code");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      applySession(await catalogApi.cancelProviderLogin(token, cliProvider));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel sign-in");
    } finally {
      setBusy(false);
    }
  };

  // HTTP providers authenticate via the env var named in providers.json and
  // have no interactive sign-in flow, so none of the CLI login UI applies.
  if (status?.kind === "http") {
    const runProbe = async () => {
      setProbing(true);
      setProbe(null);
      try {
        setProbe(await catalogApi.testCustomProvider(token, provider));
      } catch (cause) {
        setProbe({ ok: false, error: cause instanceof Error ? cause.message : "Unable to test provider" });
      } finally {
        setProbing(false);
      }
    };
    return (
      <div className="border border-[#292824] bg-white/[0.015] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-terminal">{providerLabel(provider)}</span>
          <div className="flex items-center gap-2">
            {onEdit && (
              <button onClick={onEdit} className="text-[9px] uppercase tracking-wider text-dim hover:text-signal">Edit</button>
            )}
            {onDelete && (
              <button onClick={onDelete} className="text-[9px] uppercase tracking-wider text-dim hover:text-orange-300">Delete</button>
            )}
            <button onClick={runProbe} disabled={probing || !authenticated} className="text-[9px] uppercase tracking-wider text-dim hover:text-signal disabled:opacity-50">
              {probing ? "Testing…" : "Test"}
            </button>
            <span className={`text-[9px] uppercase ${authenticated ? "text-phosphor" : "text-orange-300"}`}>
              {authenticated ? "key configured" : "key missing"}
            </span>
          </div>
        </div>
        <p className="mt-2 truncate font-mono text-[9px] text-dim">{status.base_url ?? status.version ?? status.error ?? "http provider"}</p>
        <p className="mt-3 text-[10px] leading-5 text-dim">
          API key stored encrypted in <code className="font-mono text-terminal">providers.json</code>. HTTP providers cannot serve the developer role.
        </p>
        {probe && (
          <div className="mt-2">
            {probe.url && <p className="break-all font-mono text-[9px] text-dim">GET {probe.url}</p>}
            <p className={`break-words font-mono text-[9px] ${probe.ok ? "text-phosphor" : "text-orange-300"}`}>
              {probe.ok ? `OK — ${probe.models?.length ?? 0} models: ${(probe.models ?? []).slice(0, 5).join(", ")}${(probe.models?.length ?? 0) > 5 ? "…" : ""}` : `Failed: ${probe.error}`}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border border-[#292824] bg-white/[0.015] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-terminal">{providerLabel(provider)}</span>
        <span className={`text-[9px] uppercase ${authenticated ? "text-phosphor" : "text-orange-300"}`}>
          {authenticated ? "connected" : "not connected"}
        </span>
      </div>
      <p className="mt-2 truncate font-mono text-[9px] text-dim">{status?.version ?? status?.error ?? "No status returned"}</p>

      {!authenticated && !active && (
        <div className="mt-3">
          {session?.status === "failed" && <p className="mb-2 break-words font-mono text-[9px] text-orange-300">{session.error ?? "Sign-in failed."}</p>}
          {session?.status === "expired" && <p className="mb-2 text-[10px] text-orange-300">Sign-in timed out. Start again when you are ready.</p>}
          <button onClick={begin} disabled={busy} className="inline-flex items-center gap-2 border border-[#292824] px-3 py-1.5 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal disabled:opacity-50">
            <KeyRound className="h-3 w-3" /> {session && !ACTIVE_STATUSES.has(session.status) && session.status !== "cancelled" ? "Try again" : "Connect"}
          </button>
        </div>
      )}

      {active && session && (
        <div className="mt-3 space-y-2">
          {session.status === "starting" && <p className="inline-flex items-center gap-2 text-[10px] text-dim"><LoaderCircle className="h-3 w-3 animate-spin" /> Starting sign-in.</p>}
          {session.url && session.status !== "verifying" && (
            <a href={session.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 border border-signal/50 px-3 py-1.5 text-[10px] uppercase tracking-wider text-signal hover:border-signal">
              <ExternalLink className="h-3 w-3" /> Open sign-in page
            </a>
          )}
          {session.userCode && (
            <div>
              <p className="text-[10px] text-dim">Enter this one-time code on the sign-in page:</p>
              <p className="mt-1 select-all font-mono text-sm tracking-widest text-terminal">{session.userCode}</p>
            </div>
          )}
          {session.status === "awaiting_browser" && !session.needsInput && (
            <p className="inline-flex items-center gap-2 text-[10px] text-dim"><LoaderCircle className="h-3 w-3 animate-spin" /> Waiting for approval in the browser. This updates automatically.</p>
          )}
          {session.status === "awaiting_input" && (
            <div>
              {session.error && <p className="mb-2 text-[10px] text-orange-300">{session.error}</p>}
              <p className="text-[10px] text-dim">Sign in on that page, then paste the code it gives you:</p>
              <div className="mt-2 flex gap-2">
                <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste code" className="field flex-1 font-mono text-xs" />
                <button onClick={submitCode} disabled={busy || !code.trim()} className="border border-[#292824] px-3 py-1.5 text-[10px] uppercase tracking-wider text-dim hover:border-signal hover:text-signal disabled:opacity-50">Submit code</button>
              </div>
            </div>
          )}
          {session.status === "verifying" && <p className="inline-flex items-center gap-2 text-[10px] text-dim"><LoaderCircle className="h-3 w-3 animate-spin" /> Verifying the code.</p>}
          <button onClick={cancel} disabled={busy} className="inline-flex items-center gap-2 text-[10px] uppercase tracking-wider text-dim hover:text-orange-300 disabled:opacity-50">
            <X className="h-3 w-3" /> Cancel
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-[10px] text-orange-300">{error}</p>}
    </div>
  );
}
