/**
 * macOS Keychain implementation for secure token storage.
 * Uses the `security` CLI tool to interact with Keychain Services.
 *
 * Note: Maintains a local index file to track stored servers since
 * parsing keychain dump output is fragile and macOS-version dependent.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { TokenStore, Tokens } from "./keychain";

const SERVICE_NAME = "openctl-cli";
const INDEX_FILE = join(homedir(), ".openctl", "keychain-index.json");

/**
 * Execute a shell command and return stdout.
 * Throws on non-zero exit code.
 */
async function exec(command: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed (exit ${exitCode}): ${stderr || stdout}`);
  }

  return stdout;
}

/**
 * Escape a string for use in shell commands.
 */
function shellEscape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Read the server index file.
 */
function readIndex(): string[] {
  try {
    if (existsSync(INDEX_FILE)) {
      const content = readFileSync(INDEX_FILE, "utf8");
      const data = JSON.parse(content);
      return Array.isArray(data.servers) ? data.servers : [];
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

/**
 * Write the server index file.
 */
function writeIndex(servers: string[]): void {
  try {
    const dir = dirname(INDEX_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(INDEX_FILE, JSON.stringify({ servers }, null, 2));
  } catch {
    // Ignore write errors - index is not critical
  }
}

/**
 * Add a server to the index.
 */
function addToIndex(serverUrl: string): void {
  const servers = readIndex();
  if (!servers.includes(serverUrl)) {
    servers.push(serverUrl);
    writeIndex(servers);
  }
}

/**
 * Remove a server from the index.
 */
function removeFromIndex(serverUrl: string): void {
  const servers = readIndex().filter(s => s !== serverUrl);
  writeIndex(servers);
}

export class MacOSKeychain implements TokenStore {
  async get(serverUrl: string): Promise<Tokens | null> {
    try {
      // Use security CLI to find the generic password
      const result = await exec(
        `security find-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(serverUrl)} -w 2>/dev/null`
      );

      const trimmed = result.trim();
      if (!trimmed) {
        return null;
      }

      return JSON.parse(trimmed) as Tokens;
    } catch {
      // Item not found or other error
      return null;
    }
  }

  async set(serverUrl: string, tokens: Tokens): Promise<void> {
    const jsonData = JSON.stringify(tokens);

    // Delete existing entry if it exists (security add-generic-password -U updates)
    // Using -U flag to update if exists, otherwise add
    try {
      await exec(
        `security add-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(serverUrl)} -w ${shellEscape(jsonData)} -U`
      );
    } catch {
      // If -U fails (some older macOS versions), try delete then add
      try {
        await this.delete(serverUrl);
      } catch {
        // Ignore delete errors
      }
      await exec(
        `security add-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(serverUrl)} -w ${shellEscape(jsonData)}`
      );
    }

    // Update index
    addToIndex(serverUrl);
  }

  async delete(serverUrl: string): Promise<void> {
    try {
      await exec(
        `security delete-generic-password -s ${shellEscape(SERVICE_NAME)} -a ${shellEscape(serverUrl)} 2>/dev/null`
      );
    } catch {
      // Ignore errors (item may not exist)
    }

    // Update index
    removeFromIndex(serverUrl);
  }

  async list(): Promise<string[]> {
    // Use the index file for reliable listing
    const servers = readIndex();

    // Verify each server still exists in keychain (clean up stale entries)
    const validServers: string[] = [];
    for (const server of servers) {
      const tokens = await this.get(server);
      if (tokens) {
        validServers.push(server);
      }
    }

    // Update index if any entries were removed
    if (validServers.length !== servers.length) {
      writeIndex(validServers);
    }

    return validServers;
  }
}
