#!/usr/bin/env bun
import { loadConfig, readStdinInput } from "../lib/config";
import { markSessionFinished } from "../lib/api";

const TIMEOUT_MS = 3000; // 3 second timeout
const DEBUG = process.env.OPENCTL_DEBUG === "1";

function debug(msg: string): void {
  if (DEBUG) {
    console.error(`[session-end-hook] ${msg}`);
  }
}

async function main(): Promise<void> {
  debug("SessionEnd hook starting");

  // Read stdin to get Claude session ID
  const stdinInput = await readStdinInput();
  debug(`stdin input: ${JSON.stringify(stdinInput)}`);

  if (!stdinInput?.session_id) {
    debug("No session_id in stdin - exiting");
    process.exit(0);
  }

  const config = loadConfig();
  debug(`config: ${JSON.stringify(config)}`);

  // Not an Archive session (no env vars set) - exit
  if (!config) {
    debug("No config - exiting");
    process.exit(0);
  }

  try {
    debug(`Marking session finished: ${stdinInput.session_id}`);
    // Mark session as finished with timeout
    await Promise.race([
      markSessionFinished(config.serverUrl, stdinInput.session_id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS)
      ),
    ]);
    debug("Session marked finished successfully");
  } catch (err) {
    // Network error, timeout, or server unavailable
    // Log but don't block - session is ending anyway
    debug(`Error marking session finished: ${err}`);
  }

  process.exit(0);
}

main();
