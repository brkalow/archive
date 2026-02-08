/**
 * Ascending ID generator for OpenCode compatibility.
 *
 * IDs must sort lexicographically by creation time because the TUI's
 * Binary.search inserts messages/parts into sorted arrays by ID.
 *
 * CRITICAL: The encoding must match the opencode server's Identifier.ascending()
 * which uses `timestamp * 0x1000 + counter` (not raw timestamp). If our IDs
 * use a different encoding, they sort incorrectly relative to TUI-generated IDs,
 * causing the TUI to show persistent QUEUED state and duplicate messages.
 *
 * Format: <prefix>_<12-hex-encoded-timestamp><14-base62-random>
 * Encoding: 6 big-endian bytes of (Date.now() * 0x1000 + counter)
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let counter = 0;

function getMonotonicValue(): bigint {
  const now = Date.now();
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  }
  counter++;
  return BigInt(now) * BigInt(0x1000) + BigInt(counter);
}

function encodeTimestampHex(value: bigint): string {
  // Lower 48 bits as 12 hex chars (matching opencode's 6-byte big-endian encoding)
  return (value & 0xffff_ffff_ffffn).toString(16).padStart(12, "0");
}

function randomBase62(length: number): string {
  let result = "";
  const randomBytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    result += BASE62[randomBytes[i] % 62];
  }
  return result;
}

export type IdPrefix = "msg" | "prt" | "ses";

export function generateAscendingId(prefix: IdPrefix): string {
  const value = getMonotonicValue();
  const tsHex = encodeTimestampHex(value);
  const random = randomBase62(14);
  return `${prefix}_${tsHex}${random}`;
}

/**
 * Deterministic ID for DB replay / reconstruction.
 * Uses zero-padded index instead of random suffix.
 */
export function generateDeterministicId(
  prefix: IdPrefix,
  timestamp: number,
  index: number
): string {
  const value = BigInt(timestamp) * BigInt(0x1000) + BigInt(index + 1);
  const tsHex = encodeTimestampHex(value);
  const indexStr = index.toString().padStart(14, "0");
  return `${prefix}_${tsHex}${indexStr}`;
}
