import { spawn } from "child_process";

const MARKETPLACE_REPO = "brkalow/openctl";
const MARKETPLACE_NAME = "openctl-claude-code-plugins";
const PLUGIN_KEY = `openctl@${MARKETPLACE_NAME}`;

export async function setup(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    return showHelp();
  }

  const target = args[0];

  switch (target) {
    case "claude-code":
      return setupClaudeCode();
    default:
      showHelp();
  }
}

function showHelp(): void {
  console.log(`
Usage: openctl setup <target>

Targets:
  claude-code    Install the openctl plugin for Claude Code

Example:
  openctl setup claude-code
  `);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Command not found: ${command}`));
      } else {
        reject(err);
      }
    });
  });
}

async function setupClaudeCode(): Promise<void> {
  console.log("Installing openctl plugin for Claude Code...\n");

  // Add marketplace
  console.log("Adding marketplace...");
  try {
    await runCommand("claude", ["plugin", "marketplace", "add", MARKETPLACE_REPO]);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("Command not found")) {
      console.error(
        "\nClaude CLI not found. Please install Claude Code first:\n" +
          "  https://docs.anthropic.com/en/docs/claude-code"
      );
      process.exit(1);
    }
    // Marketplace may already exist, continue to install
    console.log("  (marketplace may already be added)");
  }

  // Install plugin
  console.log("\nInstalling plugin...");
  try {
    await runCommand("claude", ["plugin", "install", PLUGIN_KEY]);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("Command not found")) {
      console.error(
        "\nClaude CLI not found. Please install Claude Code first:\n" +
          "  https://docs.anthropic.com/en/docs/claude-code"
      );
    } else {
      console.error(`\nFailed to install plugin: ${message}`);
    }
    process.exit(1);
  }

  console.log(`
openctl plugin installed for Claude Code!

Next steps:
  1. Start or restart Claude Code
  2. Use /openctl:share to share your session`);
}
