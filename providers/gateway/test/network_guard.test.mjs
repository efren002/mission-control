import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertHostnameNotBlocked,
  assertResolvesSafely,
  isBlockedAddress,
} from "../src/network_guard.mjs";

test("isBlockedAddress flags the AWS/GCP/Azure metadata IP", () => {
  assert.equal(isBlockedAddress("169.254.169.254"), true);
});

test("isBlockedAddress flags the AWS ECS task-metadata IP", () => {
  assert.equal(isBlockedAddress("169.254.170.2"), true);
});

test("isBlockedAddress flags the whole IPv4 link-local range", () => {
  assert.equal(isBlockedAddress("169.254.1.1"), true);
});

test("isBlockedAddress flags IPv6 link-local addresses, bracketed or not", () => {
  assert.equal(isBlockedAddress("fe80::1"), true);
  assert.equal(isBlockedAddress("[fe80::1]"), true);
});

test("isBlockedAddress flags the AWS IPv6 metadata address", () => {
  assert.equal(isBlockedAddress("fd00:ec2::254"), true);
});

test("isBlockedAddress allows loopback and private-network addresses", () => {
  assert.equal(isBlockedAddress("127.0.0.1"), false);
  assert.equal(isBlockedAddress("10.0.0.5"), false);
  assert.equal(isBlockedAddress("172.16.0.5"), false);
  assert.equal(isBlockedAddress("192.168.1.5"), false);
  assert.equal(isBlockedAddress("::1"), false);
});

test("isBlockedAddress allows plain hostnames (not an IP literal)", () => {
  assert.equal(isBlockedAddress("openrouter.ai"), false);
});

test("assertHostnameNotBlocked throws for a metadata IP literal", () => {
  assert.throws(() => assertHostnameNotBlocked("169.254.169.254"), /metadata/i);
});

test("assertHostnameNotBlocked does not throw for a loopback IP literal", () => {
  assert.doesNotThrow(() => assertHostnameNotBlocked("127.0.0.1"));
});

test("assertResolvesSafely rejects a bracketed IPv6 metadata literal", async () => {
  await assert.rejects(() => assertResolvesSafely("[fd00:ec2::254]"), /metadata/i);
});

test("assertResolvesSafely resolves without throwing for loopback", async () => {
  await assert.doesNotReject(() => assertResolvesSafely("127.0.0.1"));
});

test("assertResolvesSafely does not throw when DNS resolution fails", async () => {
  await assert.doesNotReject(() =>
    assertResolvesSafely("this-host-does-not-exist.invalid.example"),
  );
});
