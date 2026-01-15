#!/usr/bin/env bun

/**
 * Archive CLI - Main entry point
 *
 * Commands:
 *   daemon    Manage the background daemon (start/stop/status)
 *   upload    Upload a session to the archive
 *   config    Manage CLI configuration
 *   repo      Manage repository access control
 *   session   Manage sessions (list/delete)
 *   list      Alias for 'session list'
 */

import { daemon } from "./commands/daemon";
import { upload } from "./commands/upload";
import { config } from "./commands/config";
import { repo } from "./commands/repo";
import { session } from "./commands/session";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  daemon,
  upload,
  config,
  repo,
  session,
  list: (args) => session(["list", ...args]),
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
  repo      Manage repository access control
  session   Manage sessions (list/delete)
  list      Alias for 'session list'

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
