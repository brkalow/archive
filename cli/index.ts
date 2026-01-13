#!/usr/bin/env bun

/**
 * Archive CLI - Main entry point
 *
 * Commands:
 *   daemon    Manage the background daemon (start/stop/status)
 *   upload    Upload a session to the archive
 *   config    Manage CLI configuration
 */

import { daemon } from "./commands/daemon";
import { upload } from "./commands/upload";
import { config } from "./commands/config";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  daemon,
  upload,
  config,
};

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(`
Usage: archive <command> [options]

Commands:
  daemon    Manage the background daemon (start/stop/status)
  upload    Upload a session to the archive
  config    Manage CLI configuration

Run 'archive <command> --help' for more information.
    `);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log("archive 0.1.0");
    process.exit(0);
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.log("Run 'archive --help' for available commands.");
    process.exit(1);
  }

  await handler(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
