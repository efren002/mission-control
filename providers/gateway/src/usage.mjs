const emptyUsage = () => ({
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  updatedAt: null,
});

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function claudeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const directInput = number(value.input_tokens);
  const cacheCreation = number(value.cache_creation_input_tokens);
  const cacheRead = number(value.cache_read_input_tokens);
  const output = number(value.output_tokens);
  return {
    inputTokens: directInput + cacheCreation + cacheRead,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    totalTokens: directInput + cacheCreation + cacheRead + output,
  };
}

function codexUsage(value) {
  if (!value || typeof value !== "object") return null;
  const input = number(value.input_tokens);
  const cached = number(value.cached_input_tokens);
  const output = number(value.output_tokens);
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
  };
}

function parseJsonLines(output) {
  return String(output)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function parseProviderUsage(provider, output) {
  const messages = parseJsonLines(output);

  if (provider === "codex") {
    const completed = messages.findLast((message) => message?.type === "turn.completed");
    return codexUsage(completed?.usage);
  }

  const result = messages.findLast((message) => message?.type === "result");
  const resultUsage = claudeUsage(result?.usage);
  if (resultUsage) return resultUsage;

  const total = emptyUsage();
  let found = false;
  for (const message of messages) {
    if (message?.type !== "assistant") continue;
    const usage = claudeUsage(message.message?.usage);
    if (!usage) continue;
    found = true;
    total.inputTokens += usage.inputTokens;
    total.cachedInputTokens += usage.cachedInputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
  }
  return found ? total : null;
}

// Claude's CLI emits a structured `rate_limit_event` message on its JSON
// stream whenever its account's rate-limit status changes (not only on
// exhaustion), and separately classifies exhaustion errors as text matching
// "reached your specified ... usage limits". Codex's own tooling detects
// exhaustion with an equally simple check: the message contains "429",
// "rate limit", or "too many requests". Neither CLI documents this wording
// as a stable contract, so this is a best-effort signal — the same kind of
// free-text heuristic already used for authentication failures elsewhere in
// this gateway — not a guaranteed classification.
const EXHAUSTION_PATTERN =
  /\b429\b|rate[ -]?limit|too many requests|usage limit|usage_cap_reached/i;

export function parseRateLimitSignal({ exitCode, stdout, stderr }) {
  const event = parseJsonLines(stdout).findLast(
    (message) => message?.type === "rate_limit_event",
  );
  const info = event?.rate_limit_info ?? null;

  const combined = `${stdout}\n${stderr}`;
  const exhausted = exitCode !== 0 && EXHAUSTION_PATTERN.test(combined);

  if (!info && !exhausted) return null;
  return {
    exhausted,
    info,
    detail: exhausted ? combined.trim().slice(-2_000) : null,
  };
}

export function recordProviderUsage(current, parsed, now = new Date()) {
  const next = current ?? emptyUsage();
  return {
    requests: next.requests + 1,
    inputTokens: next.inputTokens + (parsed?.inputTokens ?? 0),
    cachedInputTokens: next.cachedInputTokens + (parsed?.cachedInputTokens ?? 0),
    outputTokens: next.outputTokens + (parsed?.outputTokens ?? 0),
    totalTokens: next.totalTokens + (parsed?.totalTokens ?? 0),
    updatedAt: now.toISOString(),
  };
}

export function initialProviderUsage() {
  return emptyUsage();
}
