/**
 * Blocks custom HTTP providers from reaching cloud-metadata/link-local
 * endpoints (169.254.0.0/16, including the AWS/GCP/Azure metadata IP and the
 * AWS ECS task-metadata IP). These are never legitimate LLM API hosts, so
 * there is no operator use case for allowing them.
 *
 * Loopback and private-network addresses (127.0.0.0/8, 10.0.0.0/8, etc.) are
 * intentionally NOT blocked: PROVIDER_GATEWAY_REWRITE_LOCALHOST exists
 * specifically so operators can point a custom provider at an LLM service
 * running on their own host or private network (Ollama, LM Studio, an
 * on-prem gateway).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const LINK_LOCAL_V6_PREFIX = /^fe80:/i;
const METADATA_V6 = new Set(["fd00:ec2::254"]);

function isLinkLocalV4(address) {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 169 && octets[1] === 254;
}

// The WHATWG URL parser returns IPv6 hostnames in bracketed form
// ("[fe80::1]"), but node:net's isIP() only recognizes bare addresses —
// strip brackets before every IP check so bracketed literals aren't
// silently treated as unresolvable hostnames and waved through.
function stripBrackets(address) {
  return address.replace(/^\[|\]$/g, "");
}

/** True if `address` is a link-local or known cloud-metadata IP literal. */
export function isBlockedAddress(address) {
  const bare = stripBrackets(address);
  const version = isIP(bare);
  if (version === 4) return isLinkLocalV4(bare);
  if (version === 6) {
    const normalized = bare.toLowerCase();
    return LINK_LOCAL_V6_PREFIX.test(normalized) || METADATA_V6.has(normalized);
  }
  return false;
}

/** Sync check for a hostname that is itself a blocked literal IP. */
export function assertHostnameNotBlocked(hostname, { context = "base_url" } = {}) {
  if (isBlockedAddress(hostname)) {
    throw new Error(
      `${context} host "${hostname}" is a link-local/cloud-metadata address and is not allowed`,
    );
  }
}

/**
 * Resolve `hostname` and reject if any resulting address is link-local or a
 * cloud-metadata IP. Call this immediately before every outbound request to
 * a custom provider so a DNS name that only resolves to a blocked address
 * (rather than being typed as a literal IP) is still caught.
 */
export async function assertResolvesSafely(hostname, { context = "base_url" } = {}) {
  const bare = stripBrackets(hostname);
  if (isIP(bare)) {
    assertHostnameNotBlocked(bare, { context });
    return;
  }
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return; // DNS failure surfaces naturally as a connection error on fetch()
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `${context} host "${hostname}" resolves to a link-local/cloud-metadata address ` +
          `(${address}) and is not allowed`,
      );
    }
  }
}
