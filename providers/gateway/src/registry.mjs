/**
 * Provider registry.
 *
 * Wraps the built-in CLI providers (codex, claude) and any HTTP providers
 * declared in providers.json (CUSTOM_PROVIDERS_PATH). A registry is an
 * immutable Map<string, ProviderEntry> rebuilt on demand — never mutated
 * after construction so callers always see a consistent snapshot.
 */

import { readFileSync } from "node:fs";

import { decryptKey } from "./crypto.mjs";
import { RESERVED_NAMES } from "./http_provider.mjs";
import { assertHostnameNotBlocked } from "./network_guard.mjs";

const CLI_KIND = "cli";
const HTTP_KIND = "http";
const SUPPORTED_FORMATS = new Set(["openai", "anthropic"]);

/** Build a fresh registry snapshot. Missing config path = CLI-only. */
export function buildRegistry({ customProvidersPath }) {
  const entries = new Map();
  entries.set("codex", {
    name: "codex",
    kind: CLI_KIND,
    capabilities: [
      "structured_output",
      "streaming_events",
      "repository_editing",
      "sandbox_control",
    ],
  });
  entries.set("claude", {
    name: "claude",
    kind: CLI_KIND,
    capabilities: [
      "structured_output",
      "streaming_events",
      "repository_editing",
      "sandbox_control",
    ],
  });

  if (customProvidersPath) {
    for (const entry of loadCustomProviders(customProvidersPath)) {
      if (RESERVED_NAMES.has(entry.name)) {
        throw new Error(
          `Custom provider "${entry.name}" collides with a reserved CLI provider name`,
        );
      }
      if (entries.has(entry.name)) {
        throw new Error(`Duplicate custom provider name "${entry.name}"`);
      }
      entries.set(entry.name, entry);
    }
  }

  return entries;
}

function loadCustomProviders(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // absent config file = no custom providers (not an error)
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`providers.json is not valid JSON: ${error.message}`);
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.providers;
  if (!Array.isArray(list)) {
    throw new Error("providers.json must define a non-empty providers array");
  }

  return list.map(validateHttpEntry);
}

export function validateHttpFields(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Each provider entry must be an object");
  }
  const { name, kind, format, base_url, model } = raw;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{1,38}$/i.test(name)) {
    throw new Error(`Invalid provider name "${name}"`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Custom provider "${name}" collides with a reserved CLI provider name`);
  }
  if (kind !== HTTP_KIND) {
    throw new Error(
      `Unsupported provider kind "${kind}" (only "http" is allowed for custom providers)`,
    );
  }
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported provider format "${format}" (expected openai or anthropic)`);
  }
  if (typeof base_url !== "string" || !/^https?:\/\//i.test(base_url)) {
    throw new Error(`Provider "${name}" base_url must be an http(s) URL`);
  }
  let hostname;
  try {
    hostname = new URL(base_url).hostname;
  } catch {
    throw new Error(`Provider "${name}" base_url is not a valid URL`);
  }
  assertHostnameNotBlocked(hostname, { context: `Provider "${name}" base_url` });
  return {
    name,
    kind: HTTP_KIND,
    format,
    base_url,
    model: typeof model === "string" ? model : null,
    max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : undefined,
  };
}

export function validateHttpEntry(raw) {
  const base = validateHttpFields(raw);
  const { encrypted_api_key } = raw;
  if (typeof encrypted_api_key !== "string" || encrypted_api_key.length === 0) {
    throw new Error(`Provider "${base.name}" encrypted_api_key is missing`);
  }
  return { ...base, encrypted_api_key };
}

/**
 * HTTP-provider status probe. "installed" = configured; "authenticated" =
 * the encrypted key decrypts successfully under the master key. The key
 * itself is never returned — only whether it is usable.
 */
export function httpProviderStatus(entry, masterKey) {
  let authenticated = false;
  let error;
  try {
    const apiKey = decryptKey(entry.encrypted_api_key, masterKey);
    authenticated = typeof apiKey === "string" && apiKey.length > 0;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "api key could not be decrypted";
  }
  return {
    name: entry.name,
    kind: HTTP_KIND,
    version: "http",
    installed: true,
    authenticated,
    available: authenticated,
    error,
    format: entry.format,
    base_url: entry.base_url,
    model: entry.model ?? null,
    max_tokens: entry.max_tokens ?? null,
    capabilities: ["structured_output", "streaming_events"],
  };
}

export const CLI_KIND_NAME = CLI_KIND;
export const HTTP_KIND_NAME = HTTP_KIND;
