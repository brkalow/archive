/**
 * Ascending ID generator for OpenCode compatibility.
 *
 * IDs must sort lexicographically by creation time because the TUI's
 * Binary.search inserts messages/parts into sorted arrays by ID.
 *
 * Format: <prefix>_<12-hex-timestamp><14-base62-random>
 * Example: msg_01932a4b5c6d00AbCdEfGhIjKl
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Monotonic counter to ensure uniqueness within same millisecond */
let lastTimestamp = 0;
let counter = 0;

function getMonotonicTimestamp(): number {
  const now = Date.now();
  if (now === lastTimestamp) {
    counter++;
  } else {
    lastTimestamp = now;
    counter = 0;
  }
  return now;
}

function encodeTimestampHex(ts: number): string {
  // 6 bytes = 12 hex chars, big-endian
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // Write as 64-bit, but we only use 48 bits (6 bytes)
  view.setUint32(0, Math.floor(ts / 0x100000000));
  view.setUint32(4, ts >>> 0);
  // Take last 6 bytes (12 hex chars)
  const bytes = new Uint8Array(buf).slice(2);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
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
  const ts = getMonotonicTimestamp();
  const tsHex = encodeTimestampHex(ts);
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
  const tsHex = encodeTimestampHex(timestamp);
  const indexStr = index.toString().padStart(14, "0");
  return `${prefix}_${tsHex}${indexStr}`;
}
