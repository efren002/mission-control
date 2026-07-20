import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { buildRegistry, httpProviderStatus } from "../src/registry.mjs";
import { encryptKey } from "../src/crypto.mjs";

const MASTER_KEY = "ab".repeat(32); // 32-byte hex
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-registry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function blob(value) {
  return encryptKey(value, MASTER_KEY);
}

function writeConfig(payload) {
  const path = join(dir, "providers.json");
  writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
  return path;
}

function httpEntry(overrides = {}) {
  return {
    name: "openrouter",
    kind: "http",
    format: "openai",
    base_url: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-3.5-sonnet",
    encrypted_api_key: blob("sk-test"),
    ...overrides,
  };
}

test("registry always includes codex and claude as cli providers", () => {
  const registry = buildRegistry({ customProvidersPath: join(dir, "missing.json") });
  assert.equal(registry.get("codex").kind, "cli");
  assert.equal(registry.get("claude").kind, "cli");
});

test("registry loads http providers from providers.json", () => {
  const path = writeConfig({ providers: [httpEntry()] });
  const registry = buildRegistry({ customProvidersPath: path });
  const entry = registry.get("openrouter");
  assert.equal(entry.kind, "http");
  assert.equal(entry.format, "openai");
  assert.equal(typeof entry.encrypted_api_key, "string");
});

test("registry rejects a custom provider whose name collides with codex or claude", () => {
  const path = writeConfig({ providers: [httpEntry({ name: "codex" })] });
  assert.throws(() => buildRegistry({ customProvidersPath: path }), /collides|reserved/i);
});

test("registry rejects an unsupported kind or format", () => {
  const path = writeConfig({ providers: [httpEntry({ name: "weird", kind: "grpc" })] });
  assert.throws(() => buildRegistry({ customProvidersPath: path }), /kind/i);
});

test("registry rejects an entry missing an encrypted_api_key", () => {
  const { encrypted_api_key, ...withoutKey } = httpEntry();
  const path = writeConfig({ providers: [withoutKey] });
  assert.throws(() => buildRegistry({ customProvidersPath: path }), /encrypted_api_key/i);
});

test("registry fails fast on malformed providers.json", () => {
  const path = writeConfig("{ not valid json");
  assert.throws(() => buildRegistry({ customProvidersPath: path }), /JSON|parse/i);
});

test("registry entries are immutable snapshots", () => {
  const path = writeConfig({ providers: [httpEntry()] });
  const first = buildRegistry({ customProvidersPath: path });
  const second = buildRegistry({ customProvidersPath: path });
  assert.notEqual(first, second);
  assert.equal(second.get("openrouter").name, "openrouter");
});

test("httpProviderStatus reports authenticated when the key decrypts under the master key", () => {
  const status = httpProviderStatus(httpEntry(), MASTER_KEY);
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.available, true);
  assert.equal(status.version, "http");
  // The key material must never leak through status.
  assert.equal(status.encrypted_api_key, undefined);
});

test("httpProviderStatus reports unauthenticated and an error when decryption fails", () => {
  const wrongMaster = "cd".repeat(32);
  const status = httpProviderStatus(httpEntry(), wrongMaster);
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.available, false);
  assert.match(status.error ?? "", /decrypt/i);
});
