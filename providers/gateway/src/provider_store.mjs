/**
 * Persistent owner of providers.json.
 *
 * The registry is an immutable in-memory snapshot built at boot; this module is
 * the read/write boundary for the file that feeds it. Writes are serialized
 * through a single promise chain so concurrent requests cannot clobber each
 * other, and every entry is re-validated before it touches disk using the same
 * rules the boot path enforces.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { encryptKey } from "./crypto.mjs";
import { RESERVED_NAMES } from "./http_provider.mjs";
import { validateHttpEntry, validateHttpFields } from "./registry.mjs";

/** Read + validate every custom provider entry. Absent file = empty list. */
export function readProviderEntries(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`providers.json is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.providers;
  if (!Array.isArray(list)) {
    throw new Error("providers.json must define a providers array");
  }
  return list.map(validateHttpEntry);
}

/** Validate + persist the full entry list atomically (serialized). */
export function writeProviderEntries(path, entries) {
  const validated = entries.map(validateHttpEntry);
  withWriteLock(() => {
    writeFileSync(path, serialize(validated), "utf8");
  });
  return validated;
}

/**
 * Validate the user-supplied fields and encrypt the plaintext api_key into the
 * persisted `encrypted_api_key`. `api_key` must be a non-empty string.
 */
export function normalizeHttpInput(raw, masterKey) {
  const base = validateHttpFields(raw);
  const apiKey = raw?.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(`Provider "${base.name}" api_key is required`);
  }
  return { ...base, encrypted_api_key: encryptKey(apiKey, masterKey) };
}

/**
 * Read-modify-write one entry. Returns the resulting full entry list so the
 * caller can rebuild its in-memory registry without re-reading disk.
 *
 * input carries the PLAINTEXT `api_key` (create: required; update: optional —
 * blank keeps the existing encrypted key). The master key encrypts before the
 * entry touches disk; plaintext is never persisted.
 *
 * ops:
 *   create — append `input`; rejects reserved + duplicate names
 *   update — replace the entry named `name` with `input` (rename allowed)
 *   delete — drop the entry named `name`
 */
export async function mutateProvider({ path, op, name, input, masterKey }) {
  return withWriteLock(() => {
    const entries = readProviderEntries(path);
    if (op === "create") {
      const next = normalizeHttpInput(input, masterKey);
      if (entries.some((entry) => entry.name === next.name)) {
        throw new Error(`Provider "${next.name}" already exists`);
      }
      const created = [...entries, next];
      writeFileSync(path, serialize(created), "utf8");
      return created;
    }
    if (op === "update") {
      const index = entries.findIndex((entry) => entry.name === name);
      if (index === -1) throw new Error(`Provider "${name}" does not exist`);
      const existing = entries[index];
      const hasNewKey = typeof input?.api_key === "string" && input.api_key.length > 0;
      const next = hasNewKey
        ? normalizeHttpInput(input, masterKey)
        : { ...validateHttpFields(input), encrypted_api_key: existing.encrypted_api_key };
      const collides = entries.some(
        (entry, idx) => idx !== index && entry.name === next.name,
      );
      if (collides) throw new Error(`Provider "${next.name}" already exists`);
      const updated = [...entries];
      updated[index] = next;
      writeFileSync(path, serialize(updated), "utf8");
      return updated;
    }
    if (op === "delete") {
      if (RESERVED_NAMES.has(name)) {
        throw new Error(`Provider "${name}" is reserved and cannot be deleted`);
      }
      const index = entries.findIndex((entry) => entry.name === name);
      if (index === -1) throw new Error(`Provider "${name}" does not exist`);
      const deleted = entries.filter((entry) => entry.name !== name);
      writeFileSync(path, serialize(deleted), "utf8");
      return deleted;
    }
    throw new Error(`Unknown provider mutation op "${op}"`);
  });
}

function serialize(entries) {
  return `${JSON.stringify({ providers: entries }, null, 2)}\n`;
}

// Single-process write lock. ponytail: does not protect across multiple
// gateway containers — add a file lock if we ever run >1 gateway.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = () => Promise.resolve().then(fn);
  const result = writeChain.then(run, run);
  // Swallow failures on the stored chain so one rejected write can't poison
  // every subsequent write; the caller observes the real error on `result`.
  writeChain = result.catch(() => undefined);
  return result;
}
