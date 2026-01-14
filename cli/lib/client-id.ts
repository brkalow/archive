import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname, join } from "path";

function getClientIdPath(): string {
  const home = Bun.env.HOME || process.env.HOME;
  if (!home) {
    throw new Error("HOME environment variable not set - cannot determine client ID path");
  }
  return join(home, ".archive", "client-id");
}

/**
 * Get the client ID for this CLI installation.
 * Generates a new UUID v4 on first use and persists it.
 */
export function getClientId(): string {
  const clientIdPath = getClientIdPath();

  // Try to read existing client ID
  if (existsSync(clientIdPath)) {
    try {
      const content = readFileSync(clientIdPath, "utf8").trim();
      if (content && isValidUUID(content)) {
        return content;
      }
    } catch {
      // Fall through to regenerate
    }
  }

  // Generate new client ID
  const clientId = crypto.randomUUID();

  // Ensure directory exists
  const dir = dirname(clientIdPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write with restricted permissions (readable only by user)
  writeFileSync(clientIdPath, clientId);
  chmodSync(clientIdPath, 0o600);

  return clientId;
}

/**
 * Get the path to the client ID file (exported for display purposes).
 */
export { getClientIdPath };

/**
 * Validate that a string is a valid UUID v4.
 */
function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}
