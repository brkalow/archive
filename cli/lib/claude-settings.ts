import { join } from "path";
import { homedir } from "os";
import { readFile, writeFile, mkdir } from "fs/promises";

export interface ClaudeSettings {
  extraKnownMarketplaces?: Record<
    string,
    {
      source: {
        source: string;
        repo: string;
      };
    }
  >;
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

export function getClaudeSettingsPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".claude", "settings.json");
}

export async function readClaudeSettings(): Promise<ClaudeSettings> {
  const settingsPath = getClaudeSettingsPath();

  try {
    const content = await readFile(settingsPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeClaudeSettings(
  settings: ClaudeSettings
): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const claudeDir = join(process.env.HOME || homedir(), ".claude");

  // Ensure .claude directory exists
  await mkdir(claudeDir, { recursive: true });

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
