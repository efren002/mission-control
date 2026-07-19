import { spawn } from "node:child_process";

const LOGIN_TIMEOUT_MS = Number(process.env.PROVIDER_GATEWAY_LOGIN_TIMEOUT_MS ?? 10 * 60 * 1000);
// The claude CLI silently keeps waiting when a pasted code is not accepted, so
// a submission that has not completed within this window is treated as rejected.
const VERIFY_TIMEOUT_MS = Number(process.env.PROVIDER_GATEWAY_LOGIN_VERIFY_TIMEOUT_MS ?? 25_000);
const CODE_REJECTED_MESSAGE = "The provider did not accept the code. Check it and try again.";
const MAX_INPUT_CHARS = 4_096;
const MAX_TAIL_CHARS = 8_000;
const MAX_ERROR_CHARS = 2_000;

// Fixed argument lists only: the provider name selects an entry, nothing from the
// request ever reaches the command line.
const loginCommands = {
  codex: { commandLine: "codex login --device-auth", needsInput: false },
  claude: { commandLine: "claude auth login", needsInput: true },
};

const ACTIVE_STATUSES = new Set(["starting", "awaiting_browser", "awaiting_input", "verifying"]);

// CSI sequences, OSC sequences (including OSC-8 hyperlinks), and carriage returns.
// eslint-disable-next-line no-control-regex
const TERMINAL_NOISE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;
// eslint-disable-next-line no-control-regex
const URL_PATTERN = /https?:\/\/[^\s"'<>\x00-\x1f]+/;
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,10}(?:-[A-Z0-9]{4,10})+)\b/;
const INPUT_PROMPT_PATTERN = /paste code here/i;

const sessions = new Map();
let onLoginSuccess = () => {};

export function setLoginSuccessHandler(handler) {
  onLoginSuccess = handler;
}

function stripTerminalNoise(text) {
  return text.replace(TERMINAL_NOISE, "");
}

function sessionPayload(session) {
  return {
    provider: session.provider,
    status: session.status,
    url: session.url,
    userCode: session.userCode,
    needsInput: loginCommands[session.provider].needsInput,
    startedAt: session.startedAt,
    error: session.error,
  };
}

function isActive(session) {
  return ACTIVE_STATUSES.has(session.status);
}

function killSessionGroup(session, signal) {
  if (!session.pid) return;
  try {
    process.kill(-session.pid, signal);
  } catch {
    // The process group already exited.
  }
}

function stopSessionProcess(session) {
  killSessionGroup(session, "SIGTERM");
  setTimeout(() => killSessionGroup(session, "SIGKILL"), 2_000).unref();
}

function parseLoginOutput(session) {
  const text = session.outputTail;
  if (!session.url) {
    const url = URL_PATTERN.exec(text);
    if (url) {
      session.url = url[0];
      if (session.status === "starting") session.status = "awaiting_browser";
    }
  }
  if (!session.userCode) {
    for (const line of text.split("\n")) {
      if (line.includes("://")) continue;
      const code = DEVICE_CODE_PATTERN.exec(line);
      if (code) {
        session.userCode = code[1];
        break;
      }
    }
  }
  if (!loginCommands[session.provider].needsInput) return;
  if (["starting", "awaiting_browser"].includes(session.status) && INPUT_PROMPT_PATTERN.test(text)) {
    session.status = "awaiting_input";
  }
  // A re-printed prompt after submission means the code was not accepted; the
  // tail was cleared on submission, so the original prompt cannot match here.
  if (session.status === "verifying" && INPUT_PROMPT_PATTERN.test(text)) {
    rejectSubmittedCode(session);
  }
}

function rejectSubmittedCode(session) {
  clearTimeout(session.verifyTimer);
  session.status = "awaiting_input";
  session.error = CODE_REJECTED_MESSAGE;
}

function finishLogin(session, exitCode) {
  clearTimeout(session.timer);
  clearTimeout(session.verifyTimer);
  if (!isActive(session)) return;
  if (exitCode === 0) {
    session.status = "succeeded";
    onLoginSuccess(session.provider);
  } else {
    session.status = "failed";
    session.error =
      session.outputTail.trim().slice(-MAX_ERROR_CHARS) ||
      `Login process exited with code ${exitCode}`;
  }
}

export function startLogin(provider, environment) {
  const existing = sessions.get(provider);
  if (existing && isActive(existing)) {
    return { statusCode: 409, payload: sessionPayload(existing) };
  }
  // `script` allocates a pseudo-terminal so the CLI runs its interactive login
  // flow; -e propagates the CLI's exit code, -f flushes output as it appears.
  const child = spawn("script", ["-qefc", loginCommands[provider].commandLine, "/dev/null"], {
    cwd: "/",
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const session = {
    provider,
    child,
    pid: child.pid ?? null,
    status: "starting",
    url: null,
    userCode: null,
    outputTail: "",
    startedAt: new Date().toISOString(),
    error: null,
    timer: null,
    verifyTimer: null,
  };
  const capture = (chunk) => {
    session.outputTail = stripTerminalNoise(`${session.outputTail}${chunk}`).slice(-MAX_TAIL_CHARS);
    parseLoginOutput(session);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    clearTimeout(session.timer);
    clearTimeout(session.verifyTimer);
    if (isActive(session)) {
      session.status = "failed";
      session.error = error.message;
    }
  });
  child.on("close", (code) => finishLogin(session, code));
  session.timer = setTimeout(() => {
    if (!isActive(session)) return;
    session.status = "expired";
    session.error = "Login timed out before it was completed";
    stopSessionProcess(session);
  }, LOGIN_TIMEOUT_MS);
  session.timer.unref();
  sessions.set(provider, session);
  return { statusCode: 200, payload: sessionPayload(session) };
}

export function getLogin(provider) {
  const session = sessions.get(provider);
  if (!session) {
    return { statusCode: 404, payload: { detail: "No login session for this provider" } };
  }
  return { statusCode: 200, payload: sessionPayload(session) };
}

export function submitLoginInput(provider, code) {
  const session = sessions.get(provider);
  if (!session || !isActive(session)) {
    return { statusCode: 404, payload: { detail: "No active login session for this provider" } };
  }
  if (!loginCommands[provider].needsInput) {
    return { statusCode: 400, payload: { detail: "This provider login does not accept input" } };
  }
  if (session.status !== "awaiting_input") {
    return { statusCode: 409, payload: { detail: "Login session is not waiting for a code" } };
  }
  if (
    typeof code !== "string" ||
    code.trim().length === 0 ||
    code.length > MAX_INPUT_CHARS ||
    // Control characters must never reach the pseudo-terminal: a newline would
    // inject extra input lines and bytes like ^C or escape drive the CLI itself.
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(code.trim())
  ) {
    return {
      statusCode: 400,
      payload: { detail: "Code must be a single non-empty line within the size limit" },
    };
  }
  session.status = "verifying";
  session.error = null;
  // Start from a clean tail so a re-printed paste prompt is unambiguous
  // rejection feedback; the URL and device code are already captured.
  session.outputTail = "";
  session.child.stdin.write(`${code.trim()}\n`);
  clearTimeout(session.verifyTimer);
  session.verifyTimer = setTimeout(() => {
    // The CLI keeps reading stdin after a rejection, so returning to
    // awaiting_input lets the user paste a corrected code into the same run.
    if (session.status === "verifying") rejectSubmittedCode(session);
  }, VERIFY_TIMEOUT_MS);
  session.verifyTimer.unref();
  return { statusCode: 200, payload: sessionPayload(session) };
}

export function cancelLogin(provider) {
  const session = sessions.get(provider);
  if (!session) {
    return { statusCode: 404, payload: { detail: "No login session for this provider" } };
  }
  if (isActive(session)) {
    clearTimeout(session.timer);
    clearTimeout(session.verifyTimer);
    session.status = "cancelled";
    stopSessionProcess(session);
  }
  return { statusCode: 200, payload: sessionPayload(session) };
}

export function shutdownLogins() {
  for (const session of sessions.values()) {
    if (isActive(session)) killSessionGroup(session, "SIGKILL");
  }
}
