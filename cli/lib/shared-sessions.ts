/**
 * Shared Sessions Allowlist - Manages which sessions are shared with servers.
 *
 * This module provides the data layer for explicit session sharing.
 * Sessions must be added to this allowlist before the daemon will track them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { readdir, stat } from "fs/promises";
import { dirname, join } from "path";
import * as readline from "readline";

const SHARED_SESSIONS_PATH = join(Bun.env.HOME || "~", ".openctl", "shared-sessions.json");

/**
 * Server-specific session info (session ID for a specific server).
 */
export interface ServerSessionInfo {
  /** Server session ID */
  sessionId: string;
}

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
  /** Server session info keyed by server URL */
  serverSessions?: Record<string, ServerSessionInfo>;
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
  serverUrl: string,
  serverSessionInfo?: ServerSessionInfo
): Promise<void> {
  const config = loadSharedSessionsSync();

  if (!config.sessions[sessionUuid]) {
    config.sessions[sessionUuid] = {
      filePath,
      servers: [serverUrl],
      sharedAt: new Date().toISOString(),
      serverSessions: serverSessionInfo ? { [serverUrl]: serverSessionInfo } : undefined,
    };
  } else {
    // Session exists, add server if not already present
    const session = config.sessions[sessionUuid];
    if (!session.servers.includes(serverUrl)) {
      session.servers.push(serverUrl);
    }
    // Update file path in case it changed
    session.filePath = filePath;
    // Update server session info if provided
    if (serverSessionInfo) {
      session.serverSessions = session.serverSessions || {};
      session.serverSessions[serverUrl] = serverSessionInfo;
    }
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
 * List all sessions for a given project path.
 * Returns sessions sorted by modification time (oldest first for chronological upload).
 * Skips sessions in subagents/ subdirectory.
 */
export async function listSessionsForProject(
  projectPath: string,
  options?: { since?: Date }
): Promise<LocalSessionInfo[]> {
  const home = Bun.env.HOME;
  if (!home) {
    return [];
  }

  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) {
    return [];
  }

  // Encode the project path to match Claude Code's format
  const encodedPath = encodeProjectPath(projectPath);
  const sessionDir = join(projectsDir, encodedPath);

  if (!existsSync(sessionDir)) {
    return [];
  }

  const sessions: LocalSessionInfo[] = [];

  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip directories (including subagents/)
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = join(sessionDir, entry.name);

      try {
        const fileStat = await stat(filePath);
        const modifiedAt = fileStat.mtime;

        // Filter by --since if provided
        if (options?.since && modifiedAt < options.since) {
          continue;
        }

        const uuid = entry.name.replace(".jsonl", "");
        const decodedProjectPath = decodeProjectPath(encodedPath);
        const projectName = decodedProjectPath.split("/").pop() || decodedProjectPath;
        const titlePreview = await extractTitlePreview(filePath);

        sessions.push({
          uuid,
          filePath,
          projectPath: decodedProjectPath,
          projectName,
          modifiedAt,
          titlePreview,
        });
      } catch {
        // Skip files we can't read
      }
    }
  } catch {
    // Ignore directory read errors
  }

  // Sort by modification time (oldest first for chronological upload)
  sessions.sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime());

  return sessions;
}

/**
 * Find the latest session for a given project path.
 * Returns the UUID and file path of the most recently modified session.
 */
export async function findLatestSessionForProject(
  projectPath: string
): Promise<{ uuid: string; filePath: string } | null> {
  const home = Bun.env.HOME;
  if (!home) {
    return null;
  }

  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) {
    console.error(`No projects directory found: ${projectsDir}`);
    return null;
  }

  // Encode the project path to match Claude Code's format
  const encodedPath = encodeProjectPath(projectPath);
  const sessionDir = join(projectsDir, encodedPath);

  if (!existsSync(sessionDir)) {
    console.error(`No session directory found for project: ${projectPath}`);
    return null;
  }

  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    let latestFile: { uuid: string; filePath: string; mtime: number } | null = null;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = join(sessionDir, entry.name);
      const fileStat = await stat(filePath);
      const mtime = fileStat.mtimeMs;

      if (!latestFile || mtime > latestFile.mtime) {
        const uuid = entry.name.replace(".jsonl", "");
        latestFile = { uuid, filePath, mtime };
      }
    }

    if (latestFile) {
      return { uuid: latestFile.uuid, filePath: latestFile.filePath };
    }
  } catch {
    // Ignore read errors (e.g., permission issues)
  }

  return null;
}

/**
 * Encode a project path to the format used in .claude/projects
 */
function encodeProjectPath(projectPath: string): string {
  // Claude Code encodes paths by replacing slashes with hyphens.
  // The leading slash becomes a leading hyphen.
  // e.g., /Users/bryce/code -> -Users-bryce-code
  return projectPath.replace(/\//g, "-");
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
async function findSessionFile(dir: string, filename: string): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip subagent directories
        if (entry.name === "subagents") {
          continue;
        }
        const found = await findSessionFile(fullPath, filename);
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

/**
 * Information about a local session file.
 */
export interface LocalSessionInfo {
  /** Session UUID */
  uuid: string;
  /** Absolute path to the session file */
  filePath: string;
  /** Decoded project path */
  projectPath: string;
  /** Project name (basename of projectPath) */
  projectName: string;
  /** Last modified timestamp */
  modifiedAt: Date;
  /** Preview of the first user message (truncated) */
  titlePreview: string;
}

/**
 * List recent local sessions across all projects.
 * Scans ~/.claude/projects/ and returns sessions sorted by modification time (newest first).
 */
export async function listRecentSessions(limit: number = 10): Promise<LocalSessionInfo[]> {
  const home = Bun.env.HOME;
  if (!home) {
    return [];
  }

  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) {
    return [];
  }

  const sessions: LocalSessionInfo[] = [];
  await collectSessions(projectsDir, sessions);

  // Sort by modification time (newest first) and limit
  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions.slice(0, limit);
}

/**
 * Recursively collect session files from a directory.
 */
async function collectSessions(dir: string, sessions: LocalSessionInfo[]): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip subagent directories
        if (entry.name === "subagents") {
          continue;
        }
        await collectSessions(fullPath, sessions);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = await stat(fullPath);
          const uuid = entry.name.replace(".jsonl", "");
          const projectPath = extractProjectPathFromSessionPath(fullPath) || "";
          const projectName = projectPath.split("/").pop() || projectPath;
          const titlePreview = await extractTitlePreview(fullPath);

          sessions.push({
            uuid,
            filePath: fullPath,
            projectPath,
            projectName,
            modifiedAt: fileStat.mtime,
            titlePreview,
          });
        } catch {
          // Skip files we can't read
        }
      }
    }
  } catch {
    // Ignore directory read errors
  }
}

/**
 * Extract a title preview from the first user message in a session file.
 * Only reads the first ~16KB to avoid loading large files entirely.
 */
async function extractTitlePreview(filePath: string): Promise<string> {
  const MAX_BYTES = 16384; // 16KB should be enough to find first user message

  try {
    const file = Bun.file(filePath);
    const stream = file.stream();
    const reader = stream.getReader();

    let buffer = "";
    let bytesRead = 0;

    // Read chunks until we have enough data or find the first user message
    while (bytesRead < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += new TextDecoder().decode(value);
      bytesRead += value.length;

      // Try to extract title from what we have so far
      const title = extractTitleFromBuffer(buffer);
      if (title) {
        reader.releaseLock();
        return title;
      }
    }

    reader.releaseLock();

    // Final attempt with all buffered content
    const title = extractTitleFromBuffer(buffer);
    if (title) {
      return title;
    }
  } catch {
    // Ignore read errors
  }

  return "Untitled Session";
}

/**
 * Try to extract a title from a buffer of JSONL content.
 */
function extractTitleFromBuffer(buffer: string): string | null {
  const lines = buffer.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      const messageData = parsed.message || parsed;
      const role = messageData.role;

      if (role === "human" || role === "user") {
        let content = "";
        const rawContent = messageData.content;

        if (typeof rawContent === "string") {
          content = rawContent;
        } else if (Array.isArray(rawContent)) {
          // Find first text block
          for (const block of rawContent) {
            if (block.type === "text" && typeof block.text === "string") {
              content = block.text;
              break;
            }
          }
        }

        if (content) {
          // Strip system tags
          content = content
            .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, "")
            .replace(/<system-instruction>[\s\S]*?<\/system-instruction>/gi, "")
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
            .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          if (content) {
            // Truncate to ~60 chars at word boundary
            if (content.length <= 60) {
              return content;
            }
            const truncated = content.slice(0, 60);
            const lastSpace = truncated.lastIndexOf(" ");
            if (lastSpace > 30) {
              return truncated.slice(0, lastSpace) + "...";
            }
            return truncated + "...";
          }
        }
      }
    } catch {
      // Skip malformed or incomplete lines
    }
  }

  return null;
}

/**
 * Format a relative time string (e.g., "2 hours ago", "1 day ago").
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) {
    return "just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  } else {
    return date.toLocaleDateString();
  }
}

/**
 * Read a single line from stdin using Bun's stream API.
 * Useful for simple Y/N prompts outside of readline interface.
 */
export async function readLine(): Promise<string> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (!value) {
    return "";
  }
  return decoder.decode(value).trim();
}

/**
 * Selection result from promptSessionSelection.
 * - session: User selected a valid session
 * - cancelled=true: User explicitly cancelled (q, quit, empty) or no sessions
 * - cancelled=false with null session: Invalid input
 */
export interface SessionSelectionResult {
  session: LocalSessionInfo | null;
  cancelled: boolean;
}

/**
 * Prompt user to select a session from a list.
 * Returns a result indicating the selected session, cancellation, or invalid input.
 */
export async function promptSessionSelection(
  sessions: LocalSessionInfo[]
): Promise<SessionSelectionResult> {
  if (!process.stdin.isTTY) {
    console.error("Interactive session selection requires a TTY.");
    return { session: null, cancelled: true };
  }

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return { session: null, cancelled: true };
  }

  console.log("\nRecent sessions:\n");

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    if (!session) continue;
    const timeAgo = formatRelativeTime(session.modifiedAt);
    const num = String(i + 1).padStart(2, " ");
    console.log(`  ${num}. [${timeAgo}] ${session.projectName}`);
    console.log(`      "${session.titlePreview}"`);
  }

  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`Select session (1-${sessions.length}, or q to quit): `, (answer) => {
      rl.close();

      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "q" || trimmed === "quit" || trimmed === "") {
        resolve({ session: null, cancelled: true });
        return;
      }

      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 1 || num > sessions.length) {
        console.error(`Invalid selection: ${answer}`);
        resolve({ session: null, cancelled: false });
        return;
      }

      resolve({ session: sessions[num - 1] ?? null, cancelled: false });
    });
  });
}
