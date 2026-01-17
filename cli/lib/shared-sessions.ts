/**
 * Shared Sessions Allowlist - Manages which sessions are shared with servers.
 *
 * This module provides the data layer for explicit session sharing.
 * Sessions must be added to this allowlist before the daemon will track them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { dirname, join } from "path";

const SHARED_SESSIONS_PATH = join(Bun.env.HOME || "~", ".openctl", "shared-sessions.json");

/**
 * A session that has been explicitly shared.
 */
export interface SharedSession {
  /** Absolute path to the session file */
  filePath: string;
  /** Server URLs this session is shared with */
  servers: string[];
  /** ISO timestamp when first shared */
  sharedAt: string;
}

/**
 * The shared sessions configuration file structure.
 */
export interface SharedSessionsConfig {
  version: 1;
  sessions: Record<string, SharedSession>; // keyed by session UUID
}

/**
 * Load the shared sessions config, creating default if missing.
 */
export async function loadSharedSessions(): Promise<SharedSessionsConfig> {
  return loadSharedSessionsSync();
}

/**
 * Load the shared sessions config synchronously.
 */
export function loadSharedSessionsSync(): SharedSessionsConfig {
  try {
    const content = readFileSync(SHARED_SESSIONS_PATH, "utf8");
    const config = JSON.parse(content) as SharedSessionsConfig;
    // Validate structure
    if (!config.sessions || typeof config.sessions !== "object") {
      return { version: 1, sessions: {} };
    }
    return config;
  } catch {
    return { version: 1, sessions: {} };
  }
}

/**
 * Save the shared sessions config atomically.
 */
export async function saveSharedSessions(config: SharedSessionsConfig): Promise<void> {
  const dir = dirname(SHARED_SESSIONS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Write to temp file then rename for atomicity
  const tempPath = `${SHARED_SESSIONS_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  // Rename to final path (atomic on POSIX)
  const { rename } = await import("fs/promises");
  await rename(tempPath, SHARED_SESSIONS_PATH);
}

/**
 * Add a session to the shared sessions allowlist.
 * If the session is already shared with this server, this is a no-op.
 */
export async function addSharedSession(
  sessionUuid: string,
  filePath: string,
  serverUrl: string
): Promise<void> {
  const config = loadSharedSessionsSync();

  if (!config.sessions[sessionUuid]) {
    config.sessions[sessionUuid] = {
      filePath,
      servers: [serverUrl],
      sharedAt: new Date().toISOString(),
    };
  } else {
    // Session exists, add server if not already present
    const session = config.sessions[sessionUuid];
    if (!session.servers.includes(serverUrl)) {
      session.servers.push(serverUrl);
    }
    // Update file path in case it changed
    session.filePath = filePath;
  }

  await saveSharedSessions(config);
}

/**
 * Remove a session from the shared sessions allowlist.
 * If serverUrl is provided, only removes from that server.
 * If serverUrl is undefined, removes the session entirely.
 */
export async function removeSharedSession(
  sessionUuid: string,
  serverUrl?: string
): Promise<void> {
  const config = loadSharedSessionsSync();

  const session = config.sessions[sessionUuid];
  if (!session) {
    return;
  }

  if (serverUrl) {
    // Remove only from specific server
    session.servers = session.servers.filter((s) => s !== serverUrl);
    if (session.servers.length === 0) {
      delete config.sessions[sessionUuid];
    }
  } else {
    // Remove entirely
    delete config.sessions[sessionUuid];
  }

  await saveSharedSessions(config);
}

/**
 * Check if a session is shared with a specific server.
 */
export function isSessionShared(sessionUuid: string, serverUrl: string): boolean {
  const config = loadSharedSessionsSync();
  const session = config.sessions[sessionUuid];
  return session?.servers.includes(serverUrl) ?? false;
}

/**
 * Get all shared sessions.
 */
export function getSharedSessions(): SharedSessionsConfig {
  return loadSharedSessionsSync();
}

/**
 * Get shared sessions for a specific server.
 */
export function getSharedSessionsForServer(
  serverUrl: string
): Array<{ uuid: string; session: SharedSession }> {
  const config = loadSharedSessionsSync();
  const result: Array<{ uuid: string; session: SharedSession }> = [];

  for (const [uuid, session] of Object.entries(config.sessions)) {
    if (session.servers.includes(serverUrl)) {
      result.push({ uuid, session });
    }
  }

  return result;
}

/**
 * Get the path to the shared sessions file.
 */
export function getSharedSessionsPath(): string {
  return SHARED_SESSIONS_PATH;
}

/**
 * Find a session file by its UUID.
 * Searches through the Claude Code projects directory.
 */
export async function findSessionByUuid(sessionUuid: string): Promise<string | null> {
  const home = Bun.env.HOME;
  if (!home) {
    return null;
  }

  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) {
    return null;
  }

  // Search for <uuid>.jsonl file in all project directories
  return findSessionFile(projectsDir, `${sessionUuid}.jsonl`);
}

/**
 * Recursively search for a session file.
 */
function findSessionFile(dir: string, filename: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip subagent directories
        if (entry.name === "subagents") {
          continue;
        }
        const found = findSessionFile(fullPath, filename);
        if (found) {
          return found;
        }
      } else if (entry.name === filename) {
        return fullPath;
      }
    }
  } catch {
    // Ignore read errors
  }

  return null;
}

/**
 * Extract the project path from a Claude Code session file path.
 * Session paths follow the format: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
 */
export function extractProjectPathFromSessionPath(sessionPath: string): string | null {
  const projectsIndex = sessionPath.indexOf("/.claude/projects/");
  if (projectsIndex === -1) {
    return null;
  }

  const relativePath = sessionPath.slice(projectsIndex + "/.claude/projects/".length);
  const parts = relativePath.split("/");

  // The encoded project path is everything except the last part (session file)
  const encodedProjectPath = parts.slice(0, -1).join("/");

  // Use the same decoding logic as the adapter
  return decodeProjectPath(encodedProjectPath);
}

/**
 * Decode the project path from the encoded format used in .claude/projects
 */
function decodeProjectPath(encoded: string): string {
  if (!encoded) {
    return "";
  }

  // Check if URL encoding is present (look for %XX patterns)
  if (/%[0-9A-Fa-f]{2}/.test(encoded)) {
    // URL encoded format: replace hyphens with slashes, then URL decode
    const withSlashes = encoded.replace(/-/g, "/");
    try {
      return decodeURIComponent(withSlashes);
    } catch {
      // Fall through to simple replacement
    }
  }

  // Simple fallback: replace hyphens with slashes
  return "/" + encoded.replace(/-/g, "/").replace(/\/+/g, "/");
}
