import {
  readClaudeSettings,
  writeClaudeSettings,
  getClaudeSettingsPath,
} from "../lib/claude-settings";

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

async function setupClaudeCode(): Promise<void> {
  console.log("Configuring Claude Code plugin...");

  let settings;
  try {
    settings = await readClaudeSettings();
  } catch (error) {
    console.error(`Error reading settings: ${(error as Error).message}`);
    console.log(`\nPlease check ${getClaudeSettingsPath()} manually.`);
    process.exit(1);
  }

  // Add marketplace
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[MARKETPLACE_NAME] = {
    source: {
      source: "github",
      repo: "brkalow/openctl",
    },
  };
  console.log(`  Added marketplace: ${MARKETPLACE_NAME}`);

  // Enable plugin
  settings.enabledPlugins = settings.enabledPlugins || {};
  settings.enabledPlugins[PLUGIN_KEY] = true;
  console.log(`  Enabled plugin: ${PLUGIN_KEY}`);

  try {
    await writeClaudeSettings(settings);
  } catch (error) {
    console.error(`Error writing settings: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(`
openctl plugin enabled for Claude Code!

Next steps:
  1. Start or restart Claude Code
  2. Use /openctl:share to share your session`);
}
