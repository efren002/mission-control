/**
 * HTTP provider adapter for the provider-gateway.
 *
 * Custom providers declared in providers.json with `kind: "http"` are executed
 * in-process via fetch() against an OpenAI- or Anthropic-compatible endpoint.
 * The adapter emits the same stdout/stderr/completed+usage shape the CLI path
 * produces, so the Python client is unchanged. HTTP providers never touch the
 * filesystem or the sandbox supervisor.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const RESERVED_NAMES = new Set(["codex", "claude"]);

// When the gateway runs in a container, `localhost` in a provider base_url
// refers to the container itself, not the host where the operator's services
// run. Rewriting loopback hosts to host.docker.internal lets users keep
// `http://localhost:<port>` as the base_url. Opt-in via env so non-containerized
// gateways and tests are unaffected.
const REWRITE_LOCALHOST = process.env.PROVIDER_GATEWAY_REWRITE_LOCALHOST === "true";

export function resolveUpstreamUrl(rawUrl) {
  if (!REWRITE_LOCALHOST) return rawUrl;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    parsed.hostname = "host.docker.internal";
  }
  return parsed.toString();
}

/**
 * Build the upstream HTTP request for an HTTP provider entry.
 * Returns `{ url, method, headers, body }`.
 */
export function buildHttpRequest(entry, { apiKey, model, prompt }) {
  const resolvedModel = model || entry.model;
  const base = resolveUpstreamUrl(entry.base_url);
  if (entry.format === "anthropic") {
    return {
      url: joinUrl(base, "/messages"),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model: resolvedModel,
        max_tokens: entry.max_tokens ?? 4096,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      },
    };
  }

  // Default: OpenAI-compatible (OpenRouter, 9router, etc.).
  return {
    url: joinUrl(base, "/chat/completions"),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: {
      model: resolvedModel,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: prompt }],
    },
  };
}

function joinUrl(base, suffix) {
  const trimmed = base.replace(/\/+$/, "");
  if (/\/(chat\/completions|messages)$/.test(trimmed)) return trimmed;
  return `${trimmed}${suffix}`;
}

/**
 * Build the upstream GET /models request for an HTTP provider entry, used by the
 * connectivity probe. Same auth headers as buildHttpRequest.
 */
export function buildModelsRequest(entry, { apiKey }) {
  const headers =
    entry.format === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
      : { authorization: `Bearer ${apiKey}` };
  return { url: joinUrl(resolveUpstreamUrl(entry.base_url), "/models"), method: "GET", headers };
}

/**
 * Probe a provider's /models endpoint to verify the key, base_url, and auth
 * format without running a chat completion. Resolves with
 * `{ ok: true, models: string[] }` or `{ ok: false, error }`.
 */
export async function probeHttpModels({ entry, apiKey, timeoutMs = 10_000 }) {
  const { url, headers } = buildModelsRequest(entry, { apiKey });
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) return { ok: false, url, error: `Timed out after ${timeoutMs}ms` };
    const cause = error instanceof Error ? error.message : "Network error";
    return {
      ok: false,
      url,
      error: `Could not reach ${url} from the gateway container: ${cause}. If the upstream is on your host, use http://host.docker.internal:<port> as the base_url (localhost inside the container is the container itself).`,
    };
  }
  if (!response.ok) {
    const detail = await safeText(response);
    return { ok: false, url, error: `HTTP ${response.status} from ${url}: ${(detail || response.statusText).slice(0, 500)}` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, url, error: `Response from ${url} was not JSON: ${error.message}` };
  }
  const list = Array.isArray(payload?.data) ? payload.data : [];
  const models = list
    .map((item) => (typeof item === "object" && item ? item.id : null))
    .filter((id) => typeof id === "string");
  return { ok: true, url, models };
}

/**
 * Run an HTTP provider to completion, emitting stdout/stderr chunks via the
 * callbacks and resolving with `{ exitCode, parsedUsage, signal }`.
 *
 * - exitCode 0 on a successful 2xx stream that the parser could read.
 * - Throws on non-2xx upstream responses, network errors, or timeout.
 */
export async function streamHttpCompletion({
  entry,
  apiKey,
  model,
  prompt,
  timeoutMs,
  onStdout,
  onStderr,
}) {
  const { url, headers, body } = buildHttpRequest(entry, { apiKey, model, prompt });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) throw new Error(`HTTP provider timed out after ${timeoutMs}ms`);
    throw error;
  }

  if (!response.ok) {
    const detail = await safeText(response);
    onStderr(`HTTP ${response.status}: ${detail}`.slice(0, 4_000));
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }

  const parser = entry.format === "anthropic" ? anthropicParser() : openaiParser();
  await readSse(response.body, (eventName, data) => parser.feed(eventName, data, onStdout));

  const parsedUsage = parser.usage();
  return { exitCode: 0, signal: null, parsedUsage };
}

async function readSse(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = null;
  let dataLines = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.replace(/\r$/, "");
        if (line === "") {
          if (dataLines.length > 0) {
            onEvent(eventName, dataLines.join("\n"));
          }
          eventName = null;
          dataLines = [];
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
    }
    if (dataLines.length > 0) onEvent(eventName, dataLines.join("\n"));
  } finally {
    reader.releaseLock();
  }
}

function openaiParser() {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let totalTokens = 0;
  let sawUsage = false;

  return {
    feed(_eventName, dataRaw, onStdout) {
      if (dataRaw === "[DONE]") return;
      let payload;
      try {
        payload = JSON.parse(dataRaw);
      } catch {
        return; // ignore non-JSON keepalive lines
      }
      const delta = payload?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) onStdout(delta);
      if (payload?.usage) {
        sawUsage = true;
        inputTokens = number(payload.usage.prompt_tokens) || inputTokens;
        outputTokens = number(payload.usage.completion_tokens) || outputTokens;
        cachedInputTokens =
          number(payload.usage.prompt_tokens_details?.cached_tokens) || cachedInputTokens;
        totalTokens = number(payload.usage.total_tokens) || inputTokens + outputTokens;
      }
    },
    usage() {
      return {
        inputTokens: sawUsage ? inputTokens : 0,
        cachedInputTokens,
        outputTokens: sawUsage ? outputTokens : 0,
        totalTokens: sawUsage ? totalTokens : 0,
      };
    },
  };
}

function anthropicParser() {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawUsage = false;

  return {
    feed(eventName, dataRaw, onStdout) {
      let payload;
      try {
        payload = JSON.parse(dataRaw);
      } catch {
        return;
      }
      const type = payload?.type ?? eventName;
      if (type === "message_start" && payload?.message?.usage) {
        inputTokens = number(payload.message.usage.input_tokens);
        cachedInputTokens = number(payload.message.usage.cache_read_input_tokens);
        sawUsage = true;
      }
      if (
        type === "content_block_delta" &&
        payload?.delta?.type === "text_delta" &&
        typeof payload.delta.text === "string"
      ) {
        onStdout(payload.delta.text);
      }
      if (type === "message_delta" && payload?.usage) {
        outputTokens = number(payload.usage.output_tokens);
        sawUsage = true;
      }
    },
    usage() {
      return {
        inputTokens: sawUsage ? inputTokens : 0,
        cachedInputTokens,
        outputTokens: sawUsage ? outputTokens : 0,
        totalTokens: sawUsage ? inputTokens + outputTokens : 0,
      };
    },
  };
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isAbortError(error) {
  return (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    /timed out|abort/i.test(error?.message ?? "")
  );
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export { RESERVED_NAMES };
