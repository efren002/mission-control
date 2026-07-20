import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { decryptKey } from "../src/crypto.mjs";
import { mutateProvider, readProviderEntries } from "../src/provider_store.mjs";

const MASTER_KEY = "ab".repeat(32); // 32-byte hex
const SECRET = "sk-test-123";
let dir;
let path;

const INPUT = {
  name: "openrouter",
  kind: "http",
  format: "openai",
  base_url: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-3.5-sonnet",
  api_key: SECRET,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-store-"));
  path = join(dir, "providers.json");
  writeFileSync(path, JSON.stringify({ providers: [] }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("create encrypts the api_key and persists an encrypted_api_key (never plaintext)", async () => {
  const entries = await mutateProvider({ path, op: "create", input: INPUT, masterKey: MASTER_KEY });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "openrouter");
  assert.equal(typeof entries[0].encrypted_api_key, "string");
  assert.equal(entries[0].encrypted_api_key, readProviderEntries(path)[0].encrypted_api_key);

  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes(SECRET), false, "plaintext key must not be written to disk");
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.providers[0].api_key, undefined);
  // Round-trips back to the original secret under the master key.
  assert.equal(decryptKey(onDisk.providers[0].encrypted_api_key, MASTER_KEY), SECRET);
});

test("create rejects a duplicate name", async () => {
  await mutateProvider({ path, op: "create", input: INPUT, masterKey: MASTER_KEY });
  await assert.rejects(
    () => mutateProvider({ path, op: "create", input: INPUT, masterKey: MASTER_KEY }),
    /already exists/i,
  );
});

test("create rejects an invalid entry before touching disk", async () => {
  await assert.rejects(
    () => mutateProvider({ path, op: "create", input: { ...INPUT, base_url: "not-a-url" }, masterKey: MASTER_KEY }),
    /base_url/i,
  );
  assert.deepEqual(readProviderEntries(path), []);
});

test("create rejects a missing api_key", async () => {
  const { api_key, ...withoutKey } = INPUT;
  await assert.rejects(
    () => mutateProvider({ path, op: "create", input: withoutKey, masterKey: MASTER_KEY }),
    /api_key/i,
  );
});

test("update with a new api_key re-encrypts; blank api_key keeps the existing key", async () => {
  await mutateProvider({ path, op: "create", input: INPUT, masterKey: MASTER_KEY });
  const original = readProviderEntries(path)[0].encrypted_api_key;

  // Blank api_key → keep existing.
  const kept = await mutateProvider({
    path,
    op: "update",
    name: "openrouter",
    input: { ...INPUT, api_key: "", model: "gpt-4o" },
    masterKey: MASTER_KEY,
  });
  assert.equal(kept[0].encrypted_api_key, original);
  assert.equal(kept[0].model, "gpt-4o");

  // New api_key → re-encrypt.
  const rotated = await mutateProvider({
    path,
    op: "update",
    name: "openrouter",
    input: { ...INPUT, api_key: "sk-rotated" },
    masterKey: MASTER_KEY,
  });
  assert.notEqual(rotated[0].encrypted_api_key, original);
  assert.equal(decryptKey(rotated[0].encrypted_api_key, MASTER_KEY), "sk-rotated");
});

test("update allows a rename without colliding", async () => {
  await mutateProvider({ path, op: "create", input: INPUT, masterKey: MASTER_KEY });
  const renamed = await mutateProvider({
    path,
    op: "update",
    name: "openrouter",
    input: { ...INPUT, name: "openrouter-v2" },
    masterKey: MASTER_KEY,
  });
  assert.equal(renamed[0].name, "openrouter-v2");
});

test("update rejects a rename that collides with another entry", async () => {
  await mutateProvider({ path, op: "create", input: INPUT, masterKey: MASTER_KEY });
  await mutateProvider({
    path,
    op: "create",
    input: { ...INPUT, name: "nine", api_key: "sk-nine" },
    masterKey: MASTER_KEY,
  });
  await assert.rejects(
    () => mutateProvider({ path, op: "update", name: "nine", input: { ...INPUT, name: "openrouter" }, masterKey: MASTER_KEY }),
    /already exists/i,
  );
});

test("update throws when the named provider does not exist", async () => {
  await assert.rejects(
    () => mutateProvider({ path, op: "update", name: "ghost", input: INPUT, masterKey: MASTER_KEY }),
    /does not exist/i,
  );
});

test("delete removes an entry from disk", async () => {
  await mutateProvider({ path, op: "create", input: INPUT, masterKey: MASTER_KEY });
  const remaining = await mutateProvider({ path, op: "delete", name: "openrouter" });
  assert.equal(remaining.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { providers: [] });
});

test("delete refuses reserved CLI provider names", async () => {
  await assert.rejects(
    () => mutateProvider({ path, op: "delete", name: "codex" }),
    /reserved/i,
  );
});

test("delete throws when the named provider does not exist", async () => {
  await assert.rejects(
    () => mutateProvider({ path, op: "delete", name: "ghost" }),
    /does not exist/i,
  );
});

test("readProviderEntries returns an empty list when the file is absent", () => {
  rmSync(path);
  assert.deepEqual(readProviderEntries(path), []);
});
