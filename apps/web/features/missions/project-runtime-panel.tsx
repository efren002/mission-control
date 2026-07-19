"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FlaskConical, Loader2, Play, Square } from "lucide-react";

import {
  catalogApi,
  type CommandRun,
  type ProjectRuntime,
} from "@/features/catalog/api";
import { useVisiblePolling } from "@/lib/use-visible-polling";

export function ProjectRuntimePanel({
  projectId,
  repositoryId,
  token,
}: {
  projectId: string;
  repositoryId: string;
  token: string;
}) {
  const [runtime, setRuntime] = useState<ProjectRuntime | null>(null);
  const [busy, setBusy] = useState<"tests" | "start" | "stop" | null>(null);
  const [error, setError] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      setRuntime(await catalogApi.projectRuntime(token, projectId, repositoryId));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load project runtime");
    }
  }, [projectId, repositoryId, token]);

  useVisiblePolling(load, 3_000, Boolean(token && projectId), repositoryId);

  const output = runtime?.test_run?.output_excerpt ?? runtime?.test_run?.error ?? "";
  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  const runTests = async () => {
    setBusy("tests");
    try {
      const testRun = await catalogApi.runProjectTests(token, projectId, repositoryId);
      setRuntime((current) => current ? { ...current, test_run: testRun } : current);
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to run tests");
    } finally {
      setBusy(null);
    }
  };

  const changeApp = async (action: "start" | "stop") => {
    setBusy(action);
    try {
      const app =
        action === "start"
          ? await catalogApi.startProjectApp(token, projectId, repositoryId)
          : await catalogApi.stopProjectApp(token, projectId, repositoryId);
      setRuntime((current) => current ? { ...current, app } : current);
      setError("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to ${action} the app`);
    } finally {
      setBusy(null);
    }
  };

  const testsActive =
    runtime?.test_run?.status === "queued" || runtime?.test_run?.status === "running";
  const appRunning = runtime?.app?.status === "running";

  return (
    <section className="mt-4 border border-[#292824] p-4">
      <p className="text-[10px] font-bold uppercase tracking-wider text-signal">
        Project runtime
      </p>
      <p className="mt-2 text-[10px] leading-4 text-dim">
        Run the project&apos;s configured checks or launch it on a local preview port.
      </p>
      {error && <p className="mt-3 text-[10px] text-orange-300">{error}</p>}
      {runtime?.gateway_error && (
        <p className="mt-3 text-[10px] text-orange-300">
          Runtime gateway unavailable: {runtime.gateway_error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={busy !== null || testsActive || !runtime?.effective_test_command}
          onClick={() => void runTests()}
          className="inline-flex items-center gap-2 border border-signal/50 px-4 py-2 text-[10px] font-bold uppercase text-signal disabled:opacity-40"
        >
          {testsActive || busy === "tests" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <FlaskConical className="h-3 w-3" />
          )}
          {testsActive ? "Tests running" : "Run tests"}
        </button>
        {!appRunning ? (
          <button
            disabled={busy !== null || !runtime?.effective_app_command}
            onClick={() => void changeApp("start")}
            className="inline-flex items-center gap-2 bg-signal px-4 py-2 text-[10px] font-bold uppercase text-black disabled:opacity-40"
          >
            {busy === "start" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            Run app
          </button>
        ) : (
          <button
            disabled={busy !== null}
            onClick={() => void changeApp("stop")}
            className="inline-flex items-center gap-2 border border-orange-700 px-4 py-2 text-[10px] font-bold uppercase text-orange-300 disabled:opacity-40"
          >
            <Square className="h-3 w-3" /> Stop app
          </button>
        )}
        {appRunning && runtime.app && (
          <a
            href={runtime.app.preview_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 border border-[#292824] px-4 py-2 text-[10px] font-bold uppercase text-terminal hover:border-signal"
          >
            <ExternalLink className="h-3 w-3" /> Open app
          </a>
        )}
      </div>
      {runtime && (
        <div className="mt-3 grid gap-1 text-[9px] text-dim">
          <p>Tests: {runtime.effective_test_command ?? "No command detected or configured"}</p>
          <p>App: {runtime.effective_app_command ?? "No command detected or configured"}</p>
        </div>
      )}
      {runtime?.test_run && <TestRunOutput run={runtime.test_run} outputRef={outputRef} />}
      {runtime?.app?.log_tail && (
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words border-l border-[#292824] pl-3 text-[9px] leading-4 text-dim">
          {runtime.app.log_tail.slice(-3000)}
        </pre>
      )}
    </section>
  );
}

function TestRunOutput({
  run,
  outputRef,
}: {
  run: CommandRun;
  outputRef: React.RefObject<HTMLPreElement | null>;
}) {
  const tone =
    run.status === "passed"
      ? "text-phosphor"
      : run.status === "failed" || run.status === "error"
        ? "text-orange-300"
        : "text-signal";
  return (
    <div className="mt-3">
      <p className={`text-[9px] font-bold uppercase ${tone}`}>
        Tests {run.status.replaceAll("_", " ")}
        {run.exit_code !== null ? `, exit ${run.exit_code}` : ""}
      </p>
      {(run.output_excerpt || run.error) && (
        <pre
          ref={outputRef}
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border-l border-[#292824] pl-3 text-[9px] leading-4 text-dim"
        >
          {(run.output_excerpt || run.error || "").slice(-5000)}
        </pre>
      )}
    </div>
  );
}
