#!/usr/bin/env bun
import { loadConfig, readStdinInput } from "../lib/config";
import { markSessionInteractive } from "../lib/api";

const TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  // Read stdin to get Claude session ID
  const stdinInput = await readStdinInput();
  if (!stdinInput?.session_id) {
    console.log(
      "Unable to enable collaboration: No session ID available from Claude Code."
    );
    process.exit(0);
  }

  const config = loadConfig();

  if (!config) {
    console.log(
      "Unable to enable collaboration: openctl server URL not configured.\n" +
        "Set OPENCTL_SERVER_URL environment variable to enable this feature."
    );
    process.exit(0);
  }

  try {
    const response = await Promise.race([
      markSessionInteractive(config.serverUrl, stdinInput.session_id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS)
      ),
    ]);

    console.log(
      `Collaboration enabled for this session.\n` +
        `You can now send feedback from the openctl browser UI.\n` +
        `Session ID: ${response.session_id}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (message === "Timeout") {
      console.log(
        "Unable to enable collaboration: Server did not respond in time."
      );
    } else if (message.includes("404")) {
      console.log(
        "Unable to enable collaboration: Session not found on server.\n" +
          "Make sure streaming is enabled and the session has been created."
      );
    } else {
      console.log(`Unable to enable collaboration: ${message}`);
    }
  }

  process.exit(0);
}

main();
