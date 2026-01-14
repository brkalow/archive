#!/usr/bin/env bun
import { loadConfig, readStdinInput } from "../lib/config";
import { markSessionInteractive } from "../lib/api";

const TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  const stdinInput = await readStdinInput();
  if (!stdinInput?.session_id) {
    process.exit(0);
  }

  // Check if user is running the /collaborate command
  const userPrompt = stdinInput.user_prompt?.trim();
  if (userPrompt !== "/collaborate") {
    process.exit(0);
  }

  const config = loadConfig();
  if (!config) {
    process.exit(0);
  }

  try {
    await Promise.race([
      markSessionInteractive(config.serverUrl, stdinInput.session_id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS)
      ),
    ]);
  } catch {
    // Non-critical - collaboration may not work but don't block
  }

  process.exit(0);
}

main();
