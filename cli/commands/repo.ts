import { parseArgs } from "util";
import { resolve } from "path";
import {
  loadConfig,
  getAllowedRepos,
  addAllowedRepo,
  removeAllowedRepo,
  getAllServersWithRepos,
} from "../lib/config";
import { getRepoIdentifier } from "../lib/git";

export async function repo(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "allow":
      return repoAllow(args.slice(1));
    case "deny":
      return repoDeny(args.slice(1));
    case "list":
      return repoList(args.slice(1));
    default:
      showHelp();
  }
}

function showHelp(): void {
  console.log(`
Usage: archive repo <subcommand> [options]

Subcommands:
  allow [path]    Allow a repository for automatic uploads
  deny [path]     Remove a repository from the allowlist
  list            List allowed repositories

Options:
  --server <url>  Target server (default: from config)
  --all           For 'deny': remove from all servers
                  For 'list': show all servers

Examples:
  archive repo allow                    # Allow current directory
  archive repo allow ~/projects/my-app  # Allow specific repo
  archive repo deny                     # Deny current directory
  archive repo list                     # List allowed repos
  archive repo list --all               # List repos for all servers
  `);
}

async function repoAllow(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string" },
    },
    allowPositionals: true,
  });

  const config = loadConfig();
  const serverUrl = values.server || config.server || "http://localhost:3000";
  const targetPath = positionals[0] || process.cwd();

  // Resolve to absolute path
  const absolutePath = resolve(targetPath);

  // Get repo identifier
  const repoId = await getRepoIdentifier(absolutePath);
  if (!repoId) {
    console.error(`Error: Not a git repository: ${absolutePath}`);
    process.exit(1);
  }

  // Add to allowlist
  addAllowedRepo(serverUrl, repoId);

  console.log(`Allowed: ${repoId}`);
  console.log(`Server: ${serverUrl}`);
  console.log(`\nSessions from this repository will now be uploaded automatically.`);
}

async function repoDeny(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string" },
      all: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const config = loadConfig();
  const targetPath = positionals[0] || process.cwd();

  // Resolve to absolute path
  const absolutePath = resolve(targetPath);

  // Get repo identifier
  const repoId = await getRepoIdentifier(absolutePath);
  if (!repoId) {
    console.error(`Error: Not a git repository: ${absolutePath}`);
    process.exit(1);
  }

  if (values.all) {
    // Remove from all servers
    const allServers = getAllServersWithRepos();
    let removed = false;
    for (const server of Object.keys(allServers)) {
      if (removeAllowedRepo(server, repoId)) {
        console.log(`Removed from: ${server}`);
        removed = true;
      }
    }
    if (!removed) {
      console.log(`Repository not found in any allowlist: ${repoId}`);
    }
  } else {
    // Remove from specific server
    const serverUrl = values.server || config.server || "http://localhost:3000";
    if (removeAllowedRepo(serverUrl, repoId)) {
      console.log(`Denied: ${repoId}`);
      console.log(`Server: ${serverUrl}`);
      console.log(`\nSessions from this repository will no longer be uploaded automatically.`);
    } else {
      console.log(`Repository not in allowlist: ${repoId}`);
      console.log(`Server: ${serverUrl}`);
    }
  }
}

async function repoList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string" },
      all: { type: "boolean" },
    },
  });

  const config = loadConfig();

  if (values.all) {
    // Show all servers
    const allServers = getAllServersWithRepos();
    if (Object.keys(allServers).length === 0) {
      console.log("No repositories allowed for any server.");
      return;
    }
    for (const [server, repos] of Object.entries(allServers)) {
      console.log(`${server}:`);
      for (const repo of repos) {
        console.log(`  ${repo}`);
      }
      console.log();
    }
  } else {
    // Show specific server
    const serverUrl = values.server || config.server || "http://localhost:3000";
    const repos = getAllowedRepos(serverUrl);

    if (repos.length === 0) {
      console.log(`No repositories allowed (${serverUrl})`);
      console.log(`\nTo allow a repository, run:`);
      console.log(`  archive repo allow`);
      return;
    }

    console.log(`Allowed repositories (${serverUrl}):`);
    for (const repo of repos) {
      console.log(`  ${repo}`);
    }
  }
}
