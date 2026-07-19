import assert from "node:assert/strict";
import test from "node:test";

import {
  initialProviderUsage,
  parseProviderUsage,
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
