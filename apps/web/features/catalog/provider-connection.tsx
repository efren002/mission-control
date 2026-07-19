"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, KeyRound, LoaderCircle, X } from "lucide-react";

import { catalogApi, type ProviderLoginSession, type ProviderStatus } from "@/features/catalog/api";

const ACTIVE_STATUSES = new Set(["starting", "awaiting_browser", "awaiting_input", "verifying"]);
const POLL_INTERVAL_MS = 2_000;

const providerLabels: Record<"codex" | "claude", string> = {
  codex: "Codex",
  claude: "Claude",
};

export function ProviderConnectionBanner({ token }: { token: string }) {
  const [disconnected, setDisconnected] = useState<string[]>([]);

  useEffect(() => {
    if (!token) return;
    let disposed = false;
    const check = async () => {
      try {
        const { providers } = await catalogApi.providers(token);
        if (disposed) return;
        setDisconnected(
          Object.keys(providerLabels).filter(
            (name) => providers[name] && providers[name].authenticated !== true,
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
  const names = disconnected.map((name) => providerLabels[name as "codex" | "claude"]).join(" and ");
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border border-orange-700/70 bg-orange-950/20 px-4 py-3">
      <p className="text-xs text-orange-200">{names} {disconnected.length === 1 ? "is" : "are"} not connected. Agents cannot plan or build until every provider you use is signed in.</p>
      <Link href="/settings" className="border border-orange-700/70 px-3 py-1.5 text-[10px] uppercase tracking-wider text-orange-200 hover:border-orange-400 hover:text-orange-100">Connect in Settings</Link>
    </div>
  );
}

export function ProviderConnectionCard({ provider, status, token, onAuthenticated }: {
  provider: "codex" | "claude";
  status: ProviderStatus | undefined;
  token: string;
  onAuthenticated: () => void;
}) {
  const [session, setSession] = useState<ProviderLoginSession | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notifiedRef = useRef(false);

  const authenticated = status?.authenticated === true;
  const active = session !== null && ACTIVE_STATUSES.has(session.status);

  const applySession = useCallback((next: ProviderLoginSession | null) => {
    setSession(next);
    if (next?.status === "succeeded" && !notifiedRef.current) {
      notifiedRef.current = true;
      onAuthenticated();
    }
  }, [onAuthenticated]);

  // Resume a login that is already in progress, for example after a page reload.
  useEffect(() => {
    if (authenticated) return;
    let disposed = false;
    void catalogApi.providerLoginStatus(token, provider).then((existing) => {
      if (!disposed && existing && ACTIVE_STATUSES.has(existing.status)) setSession(existing);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [authenticated, provider, token]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void catalogApi.providerLoginStatus(token, provider).then(applySession).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, applySession, provider, token]);

  const begin = async () => {
    setBusy(true);
    setError("");
    notifiedRef.current = false;
    try {
      // A 409 also returns the already-running session, so this resumes it.
      applySession(await catalogApi.startProviderLogin(token, provider));
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
      applySession(await catalogApi.submitProviderLoginCode(token, provider, code.trim()));
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
      applySession(await catalogApi.cancelProviderLogin(token, provider));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel sign-in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-[#292824] bg-white/[0.015] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-terminal">{providerLabels[provider]}</span>
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
