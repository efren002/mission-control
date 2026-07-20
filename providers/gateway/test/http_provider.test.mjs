import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, beforeEach, test } from "node:test";

import { buildHttpRequest, streamHttpCompletion } from "../src/http_provider.mjs";

const OPENAI_ENTRY = {
  name: "openrouter",
  kind: "http",
  format: "openai",
  base_url: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-3.5-sonnet",
  api_key_env: "OPENROUTER_API_KEY",
};

const ANTHROPIC_ENTRY = {
  name: "anthropic-direct",
  kind: "http",
  format: "anthropic",
  base_url: "https://api.anthropic.com/v1",
  model: "claude-3-5-sonnet-20241022",
  api_key_env: "ANTHROPIC_API_KEY",
};

let servers = [];

function startMock(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      servers.push(server);
      resolve(port);
    });
  });
}

function chunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

beforeEach(() => {
  servers = [];
});

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => server.close(resolve)),
    ),
  );
});

test("buildHttpRequest builds the OpenAI chat/completions request with Bearer auth", () => {
  const req = buildHttpRequest(OPENAI_ENTRY, {
    apiKey: "sk-test",
    model: null,
    prompt: "say hi",
  });
  assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer sk-test");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(req.body.messages, [{ role: "user", content: "say hi" }]);
  assert.equal(req.body.model, "anthropic/claude-3.5-sonnet");
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.stream_options, { include_usage: true });
});

test("buildHttpRequest builds the Anthropic messages request with x-api-key and version", () => {
  const req = buildHttpRequest(ANTHROPIC_ENTRY, {
    apiKey: "sk-ant-test",
    model: null,
    prompt: "say hi",
  });
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "sk-ant-test");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(req.body.messages, [{ role: "user", content: "say hi" }]);
  assert.equal(req.body.model, "claude-3-5-sonnet-20241022");
  assert.equal(req.body.stream, true);
});

test("buildHttpRequest lets the request model override the configured default", () => {
  const req = buildHttpRequest(OPENAI_ENTRY, {
    apiKey: "sk-test",
    model: "override-model",
    prompt: "hi",
  });
  assert.equal(req.body.model, "override-model");
});

test("streamHttpCompletion parses an OpenAI SSE stream into assistant text and usage", async () => {
  const port = await startMock((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    req.on("data", () => {});
    req.on("end", () => {
      chunk(res, { choices: [{ delta: { content: "Hello " } }] });
      chunk(res, { choices: [{ delta: { content: "world" } }] });
      chunk(res, {
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  const entry = { ...OPENAI_ENTRY, base_url: `http://127.0.0.1:${port}/v1` };
  const stdout = [];
  const result = await streamHttpCompletion({
    entry,
    apiKey: "sk-test",
    model: null,
    prompt: "hi",
    timeoutMs: 5_000,
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: () => {},
  });
  assert.equal(stdout.join(""), "Hello world");
  assert.equal(result.exitCode, 0);
  assert.equal(result.parsedUsage.inputTokens, 7);
  assert.equal(result.parsedUsage.outputTokens, 2);
  assert.equal(result.parsedUsage.totalTokens, 9);
});

test("streamHttpCompletion parses an Anthropic SSE stream into assistant text and usage", async () => {
  const port = await startMock((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    req.on("data", () => {});
    req.on("end", () => {
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 5, output_tokens: 0 } },
        })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hi " },
        })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "there" },
        })}\n\n`,
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 2 },
        })}\n\n`,
      );
      res.write("event: message_stop\ndata: {}\n\n");
      res.end();
    });
  });

  const entry = { ...ANTHROPIC_ENTRY, base_url: `http://127.0.0.1:${port}` };
  const stdout = [];
  const result = await streamHttpCompletion({
    entry,
    apiKey: "sk-ant-test",
    model: null,
    prompt: "hi",
    timeoutMs: 5_000,
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: () => {},
  });
  assert.equal(stdout.join(""), "Hi there");
  assert.equal(result.exitCode, 0);
  assert.equal(result.parsedUsage.inputTokens, 5);
  assert.equal(result.parsedUsage.outputTokens, 2);
  assert.equal(result.parsedUsage.cachedInputTokens, 0);
});

test("streamHttpCompletion aborts the in-flight fetch after timeoutMs", async () => {
  const port = await startMock((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    req.on("data", () => {});
    req.on("end", () => {
      // Never end the stream — force the client timeout to fire.
    });
  });

  const entry = { ...OPENAI_ENTRY, base_url: `http://127.0.0.1:${port}/v1` };
  await assert.rejects(
    () =>
      streamHttpCompletion({
        entry,
        apiKey: "sk-test",
        model: null,
        prompt: "hi",
        timeoutMs: 50,
        onStdout: () => {},
        onStderr: () => {},
      }),
    /timed out|abort/i,
  );
});

test("streamHttpCompletion surfaces a non-2xx upstream response as an error with stderr", async () => {
  const port = await startMock((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid api key" }));
  });

  const entry = { ...OPENAI_ENTRY, base_url: `http://127.0.0.1:${port}/v1` };
  const stderr = [];
  await assert.rejects(
    () =>
      streamHttpCompletion({
        entry,
        apiKey: "bad",
        model: null,
        prompt: "hi",
        timeoutMs: 5_000,
        onStdout: () => {},
        onStderr: (chunk) => stderr.push(chunk),
      }),
    /401|invalid api key/i,
  );
  assert.ok(stderr.join("").length > 0);
});
