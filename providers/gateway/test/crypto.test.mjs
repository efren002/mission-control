import assert from "node:assert/strict";
import test from "node:test";

import { decryptKey, encryptKey, isKeyConfigured } from "../src/crypto.mjs";

const MASTER_KEY = "ab".repeat(32); // 32-byte hex
const OTHER_KEY = "cd".repeat(32);

test("encryptKey then decryptKey round-trips the plaintext", () => {
  const blob = encryptKey("sk-secret", MASTER_KEY);
  assert.equal(decryptKey(blob, MASTER_KEY), "sk-secret");
});

test("each encryption uses a fresh IV so ciphertexts differ", () => {
  const a = encryptKey("sk-same", MASTER_KEY);
  const b = encryptKey("sk-same", MASTER_KEY);
  assert.notEqual(a, b);
  assert.equal(decryptKey(a, MASTER_KEY), "sk-same");
  assert.equal(decryptKey(b, MASTER_KEY), "sk-same");
});

test("decryptKey rejects a wrong master key", () => {
  const blob = encryptKey("sk-secret", MASTER_KEY);
  assert.throws(() => decryptKey(blob, OTHER_KEY), /decrypt/i);
});

test("decryptKey rejects a tampered blob", () => {
  const blob = encryptKey("sk-secret", MASTER_KEY);
  const [prefix, payload] = blob.split(":");
  const [iv, ciphertext, tag] = payload.split(".");
  // Flip characters in the ciphertext.
  const tampered = `${prefix}:${iv}.${ciphertext.slice(0, -2) + "ZZ"}.${tag}`;
  assert.throws(() => decryptKey(tampered, MASTER_KEY), /decrypt/i);
});

test("decryptKey rejects an unsupported blob format", () => {
  assert.throws(() => decryptKey("not-a-blob", MASTER_KEY), /format|malformed/i);
  assert.throws(() => decryptKey("v1:only.two", MASTER_KEY), /malformed/i);
});

test("isKeyConfigured distinguishes valid 32-byte hex from anything else", () => {
  assert.equal(isKeyConfigured(MASTER_KEY), true);
  assert.equal(isKeyConfigured(""), false);
  assert.equal(isKeyConfigured("too-short"), false);
  assert.equal(isKeyConfigured("zz".repeat(32)), false); // non-hex
});
