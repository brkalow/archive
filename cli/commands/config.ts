import { loadConfig, saveConfig, getConfigValue, setConfigValue } from "../lib/config";

export async function config(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "get":
      return configGet(args[1]);
    case "set":
      return configSet(args[1], args[2]);
    case "list":
      return configList();
    default:
      console.log(`
Usage: archive config <subcommand> [args]

Subcommands:
  get <key>          Get a config value
  set <key> <value>  Set a config value
  list               List all config values

Available keys:
  server      Archive server URL
  db          Database path
  autoOpen    Auto-open browser after upload (true/false)
      `);
  }
}

function configGet(key: string | undefined): void {
  if (!key) {
    console.error("Error: Key is required");
    console.log("Usage: archive config get <key>");
    return;
  }

  const value = getConfigValue(key as "server" | "db" | "autoOpen");
  if (value !== undefined) {
    console.log(value);
  } else {
    console.log(`(not set)`);
  }
}

function configSet(key: string | undefined, value: string | undefined): void {
  if (!key || value === undefined) {
    console.error("Error: Key and value are required");
    console.log("Usage: archive config set <key> <value>");
    return;
  }

  setConfigValue(key as "server" | "db" | "autoOpen", value);
  console.log(`Set ${key} = ${value}`);
}

function configList(): void {
  const cfg = loadConfig();

  if (Object.keys(cfg).length === 0) {
    console.log("No configuration set.");
    return;
  }

  console.log("Current configuration:");
  for (const [key, value] of Object.entries(cfg)) {
    console.log(`  ${key}: ${value}`);
  }
}
