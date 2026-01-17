#!/usr/bin/env bun

/**
 * openctl CLI - Main entry point
 *
 * Commands:
 *   daemon    Manage the background daemon (start/stop/status)
 *   upload    Upload a session to the server
 *   config    Manage CLI configuration
 *   repo      Manage repository access control
 *   session   Manage sessions (list/delete)
 *   setup     Install openctl integrations (e.g., Claude Code plugin)
 *   list      Alias for 'session list'
 */

import { daemon } from "./commands/daemon";
import { upload } from "./commands/upload";
import { config } from "./commands/config";
import { repo } from "./commands/repo";
import { session } from "./commands/session";
import { setup } from "./commands/setup";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  daemon,
  upload,
  config,
  repo,
  session,
  setup,
  list: (args) => session(["list", ...args]),
};

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(`
openctl - Claude Code Session Manager

Upload, stream, and manage Claude Code sessions.

Usage: openctl <command> [options]

Commands:
  daemon    Manage the background daemon (start/stop/status)
  upload    Upload a session to the server
  config    Manage CLI configuration
  repo      Manage repository access control
  session   Manage sessions (list/delete)
  setup     Install openctl integrations (e.g., Claude Code plugin)
  list      Alias for 'session list'

Run 'openctl <command> --help' for more information.
    `);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    // Use build-time version if available, otherwise read from package.json
    const version =
      process.env.OPENCTL_VERSION ||
      (await import("../package.json")).version ||
      "0.0.0";
    // Use build-time git SHA if available, otherwise show "local"
    const gitSha = process.env.OPENCTL_GIT_SHA || "local";
    console.log(`openctl ${version} (${gitSha})`);
    process.exit(0);
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.log("Run 'openctl --help' for available commands.");
    process.exit(1);
  }

  await handler(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
