# Plan: CLI Setup Command

Add `openctl setup claude-code` command to install the Claude Code plugin.

## Overview

Create a `setup` command that registers the openctl plugin marketplace and enables the plugin in Claude Code's settings.

**Target usage:**
```bash
openctl setup claude-code
```

## How Claude Code Plugin Installation Works

1. Create a marketplace manifest at `plugins/claude-code/.claude-plugin/marketplace.json`
2. Modify `~/.claude/settings.json` to add the marketplace and enable the plugin

## Files to Create

### 1. `plugins/claude-code/.claude-plugin/marketplace.json`

Marketplace manifest for the openctl plugin:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "openctl-claude-code-plugins",
  "version": "1.0.0",
  "description": "OpenCtl plugins for Claude Code session sharing and collaboration",
  "owner": {
    "name": "OpenCtl",
    "email": "support@openctl.dev"
  },
  "plugins": [
    {
      "name": "openctl",
      "description": "Enables remote feedback during Claude Code sessions",
      "version": "0.1.0",
      "source": "./openctl",
      "category": "productivity"
    }
  ]
}
```

### 2. `cli/commands/setup.ts`

Setup command that configures Claude Code integration:

```typescript
export async function setup(args: string[]): Promise<void> {
  const target = args[0];
  switch (target) {
    case "claude-code": return setupClaudeCode();
    default: showHelp();
  }
}
```

**Setup logic:**
1. Read existing `~/.claude/settings.json` (or create empty object)
2. Add marketplace to `extraKnownMarketplaces`
3. Enable plugin in `enabledPlugins`
4. Write updated settings back
5. Print success message

### 3. `cli/lib/claude-settings.ts`

Utilities for reading/writing Claude Code settings:

```typescript
export function getClaudeSettingsPath(): string {
  const home = process.env.HOME || "~";
  return join(home, ".claude", "settings.json");
}

export async function readClaudeSettings(): Promise<ClaudeSettings> {
  // Read and parse, return {} if not exists
}

export async function writeClaudeSettings(settings: ClaudeSettings): Promise<void> {
  // Write with pretty formatting
}
```

## Files to Modify

### 4. `cli/index.ts`

Add setup command to registry:
```typescript
import { setup } from "./commands/setup";

const commands = {
  // ...existing commands...
  setup,
};
```

## Implementation Details

### Settings Modification

```typescript
async function setupClaudeCode(): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const settings = await readClaudeSettings();

  // Add marketplace
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces["openctl-claude-code-plugins"] = {
    source: {
      source: "github",
      repo: "brkalow/openctl"
    }
  };

  // Enable plugin
  settings.enabledPlugins = settings.enabledPlugins || {};
  settings.enabledPlugins["openctl@openctl-claude-code-plugins"] = true;

  await writeClaudeSettings(settings);

  console.log("OpenCtl plugin enabled for Claude Code!");
  console.log("\nNext steps:");
  console.log("  1. Start or restart Claude Code");
  console.log("  2. Use /openctl:share to share your session");
}
```

### Error Handling

| Scenario | Action |
|----------|--------|
| Unknown target | Show help with available targets |
| Settings file doesn't exist | Create with just our settings |
| Settings file malformed | Error with instructions to fix manually |
| Already installed | Update settings (idempotent) |

### User Flow

```
$ openctl setup claude-code
Configuring Claude Code plugin...
  Added marketplace: openctl-claude-code-plugins
  Enabled plugin: openctl@openctl-claude-code-plugins

OpenCtl plugin enabled for Claude Code!

Next steps:
  1. Start or restart Claude Code
  2. Use /openctl:share to share your session
```

## Critical Files

**Create:**
- `plugins/claude-code/.claude-plugin/marketplace.json` - Marketplace manifest
- `cli/commands/setup.ts` - Setup command
- `cli/lib/claude-settings.ts` - Settings utilities

**Modify:**
- `cli/index.ts:21-27` - Add setup to command registry

**Reference:**
- `plugins/claude-code/openctl/` - Existing plugin source

## Verification

1. Run `openctl setup` - shows usage with available targets
2. Run `openctl setup claude-code` - modifies settings.json
3. Check `~/.claude/settings.json` contains:
   - `extraKnownMarketplaces.openctl-claude-code-plugins`
   - `enabledPlugins["openctl@openctl-claude-code-plugins"]`
4. Start Claude Code, verify `/openctl:share` command appears
5. Run setup again - idempotent (no errors, same result)
