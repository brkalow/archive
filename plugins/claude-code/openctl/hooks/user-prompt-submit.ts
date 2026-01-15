#!/usr/bin/env bun
import { loadConfig, readStdinInput } from "../lib/config";
import { markSessionInteractive } from "../lib/api";

const TIMEOUT_MS = 5000;

// Always log to stderr for debugging (visible in verbose mode ctrl+o)
function log(msg: string): void {
  console.error(`[openctl:user-prompt-submit] ${msg}`);
}

async function main(): Promise<void> {
  const stdinInput = await readStdinInput();

  if (!stdinInput?.session_id) {
    log("No session_id in stdin");
    process.exit(0);
  }

  // Check if user is running the /collaborate command
  const userPrompt = stdinInput.user_prompt?.trim();
  if (userPrompt !== "/collaborate") {
    // Not the collaborate command, let it through
    process.exit(0);
  }

  log(`Collaborate command detected for session ${stdinInput.session_id.slice(0, 8)}...`);

  const config = loadConfig();
  if (!config) {
    log("No OPENCTL_SERVER_URL set");
    process.exit(0);
  }

  try {
    log(`Marking session interactive at ${config.serverUrl}...`);

    const result = await Promise.race([
      markSessionInteractive(config.serverUrl, stdinInput.session_id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS)
      ),
    ]);

    log(`Session marked interactive: ${result.session_id}`);
  } catch (err) {
    log(`Error marking session interactive: ${err}`);
    // Non-critical - collaboration may not work but don't block the user
  }

  process.exit(0);
}

main();
