/**
 * AES-256-GCM encryption for provider API keys at rest.
 *
 * The master key is the hex string in PROVIDERS_ENCRYPTION_KEY (32 bytes).
 * Each call to encryptKey uses a fresh random IV, so the same plaintext
 * produces different ciphertext every time. The blob format is
 * `v1:<base64(iv)>.<base64(ciphertext)>.<base64(authTag)>`; decryptKey verifies
 * the GCM tag and throws on any tamper, truncation, or key mismatch.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = "v1";

function toKey(masterKeyHex) {
  if (typeof masterKeyHex !== "string" || masterKeyHex.length === 0) {
    throw new Error("Master encryption key is not configured");
  }
  let buf;
  try {
    buf = Buffer.from(masterKeyHex, "hex");
  } catch (error) {
    throw new Error(`Master encryption key is invalid: ${error.message}`);
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(`Master encryption key must be ${KEY_BYTES * 8} bits (${KEY_BYTES} hex-encoded bytes)`);
  }
  return buf;
}

export function encryptKey(plaintext, masterKeyHex) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("plaintext key must be a non-empty string");
  }
  const key = toKey(masterKeyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString("base64")}.${ciphertext.toString("base64")}.${tag.toString("base64")}`;
}

export function decryptKey(blob, masterKeyHex) {
  if (typeof blob !== "string" || blob.length === 0) {
    throw new Error("encrypted key is missing");
  }
  const [prefix, payload] = blob.split(":");
  if (prefix !== PREFIX || typeof payload !== "string") {
    throw new Error("encrypted key has an unsupported format");
  }
  const [ivB64, ciphertextB64, tagB64] = payload.split(".");
  if (!ivB64 || !ciphertextB64 || !tagB64) {
    throw new Error("encrypted key is malformed");
  }
  let iv, ciphertext, tag;
  try {
    iv = Buffer.from(ivB64, "base64");
    ciphertext = Buffer.from(ciphertextB64, "base64");
    tag = Buffer.from(tagB64, "base64");
  } catch (error) {
    throw new Error(`encrypted key could not be decoded: ${error.message}`);
  }
  if (iv.length !== IV_BYTES) {
    throw new Error("encrypted key IV is corrupt");
  }
  const key = toKey(masterKeyHex);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("encrypted key could not be decrypted (wrong master key or tampered)");
  }
  return plain.toString("utf8");
}

export function isKeyConfigured(masterKeyHex) {
  try {
    toKey(masterKeyHex);
    return true;
  } catch {
    return false;
  }
}
