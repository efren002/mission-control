import assert from "node:assert/strict";
import test from "node:test";

import {
  initialProviderUsage,
  parseProviderUsage,
  parseRateLimitSignal,
  recordProviderUsage,
} from "../src/usage.mjs";

test("parses Codex turn usage without double-counting cached input", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30 },
    }),
  ].join("\n");

  assert.deepEqual(parseProviderUsage("codex", output), {
    inputTokens: 120,
    cachedInputTokens: 80,
    outputTokens: 30,
    totalTokens: 150,
  });
});

test("parses Claude result usage including cache tokens", () => {
  const output = JSON.stringify({
    type: "result",
    usage: {
      input_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
      output_tokens: 10,
    },
  });

  assert.deepEqual(parseProviderUsage("claude", output), {
    inputTokens: 90,
    cachedInputTokens: 40,
    outputTokens: 10,
    totalTokens: 100,
  });
});

test("parseRateLimitSignal captures Claude's structured rate_limit_info even on success", () => {
  const output = [
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { primary: { used_percent: 42 } },
    }),
    JSON.stringify({ type: "result", usage: {} }),
  ].join("\n");

  assert.deepEqual(parseRateLimitSignal({ exitCode: 0, stdout: output, stderr: "" }), {
    exhausted: false,
    info: { primary: { used_percent: 42 } },
    detail: null,
  });
});

test("parseRateLimitSignal flags exhaustion from Claude's usage-limit error text", () => {
  const stderr = "Error: You have reached your specified monthly usage limits.";
  const result = parseRateLimitSignal({ exitCode: 1, stdout: "", stderr });

  assert.equal(result.exhausted, true);
  assert.match(result.detail, /usage limits/);
});

test("parseRateLimitSignal flags exhaustion from Codex's 429/rate-limit wording", () => {
  const stderr = "Request failed: 429 Too Many Requests";
  const result = parseRateLimitSignal({ exitCode: 1, stdout: "", stderr });

  assert.equal(result.exhausted, true);
});

test("parseRateLimitSignal returns null for an unrelated failure", () => {
  const result = parseRateLimitSignal({
    exitCode: 1,
    stdout: "",
    stderr: "Error: connection reset by peer",
  });

  assert.equal(result, null);
});

test("parseRateLimitSignal does not flag a clean success with no rate-limit info", () => {
  const result = parseRateLimitSignal({
    exitCode: 0,
    stdout: JSON.stringify({ type: "result", usage: {} }),
    stderr: "",
  });

  assert.equal(result, null);
});

test("records requests even when a failed run has no token metadata", () => {
  const now = new Date("2026-07-17T00:00:00.000Z");
  assert.deepEqual(recordProviderUsage(initialProviderUsage(), null, now), {
    requests: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
});
