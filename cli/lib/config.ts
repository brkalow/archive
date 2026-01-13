import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const CONFIG_PATH = join(Bun.env.HOME || "~", ".archive", "config.json");

interface Config {
  server?: string;
  db?: string;
  autoOpen?: boolean;
}

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getConfigValue(key: keyof Config): string | undefined {
  const config = loadConfig();
  const value = config[key];
  return value !== undefined ? String(value) : undefined;
}

export function setConfigValue(key: keyof Config, value: string): void {
  const config = loadConfig();
  (config as Record<string, unknown>)[key] = value;
  saveConfig(config);
}
