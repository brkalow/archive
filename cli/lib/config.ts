import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const CONFIG_PATH = join(Bun.env.HOME || "~", ".archive", "config.json");

interface ServerConfig {
  allowedRepos: string[];
}

interface Config {
  server?: string;
  db?: string;
  autoOpen?: boolean;
  servers?: Record<string, ServerConfig>;
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

/**
 * Get allowed repositories for a specific server.
 */
export function getAllowedRepos(serverUrl: string): string[] {
  const config = loadConfig();
  return config.servers?.[serverUrl]?.allowedRepos ?? [];
}

/**
 * Add a repository to the allowlist for a specific server.
 */
export function addAllowedRepo(serverUrl: string, repoId: string): void {
  const config = loadConfig();
  if (!config.servers) {
    config.servers = {};
  }
  if (!config.servers[serverUrl]) {
    config.servers[serverUrl] = { allowedRepos: [] };
  }

  const repos = config.servers[serverUrl].allowedRepos;
  if (!repos.includes(repoId)) {
    repos.push(repoId);
    saveConfig(config);
  }
}

/**
 * Remove a repository from the allowlist for a specific server.
 * Returns true if the repo was found and removed.
 */
export function removeAllowedRepo(serverUrl: string, repoId: string): boolean {
  const config = loadConfig();
  const repos = config.servers?.[serverUrl]?.allowedRepos;
  if (!repos) return false;

  const index = repos.indexOf(repoId);
  if (index === -1) return false;

  repos.splice(index, 1);
  saveConfig(config);
  return true;
}

/**
 * Check if a repository is allowed for a specific server.
 */
export function isRepoAllowed(serverUrl: string, repoId: string): boolean {
  const repos = getAllowedRepos(serverUrl);
  return repos.includes(repoId);
}

/**
 * Get all servers with their allowed repositories.
 */
export function getAllServersWithRepos(): Record<string, string[]> {
  const config = loadConfig();
  const result: Record<string, string[]> = {};
  if (config.servers) {
    for (const [server, serverConfig] of Object.entries(config.servers)) {
      if (serverConfig.allowedRepos?.length > 0) {
        result[server] = serverConfig.allowedRepos;
      }
    }
  }
  return result;
}
