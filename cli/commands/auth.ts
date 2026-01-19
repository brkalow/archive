/**
 * CLI authentication commands: login, logout, status, whoami
 */

import { parseArgs } from "util";
import { getKeychain } from "../lib/keychain";
import { startOAuthFlow, getAuthenticatedTokens, getOAuthConfig } from "../lib/oauth";
import { getServerUrl } from "../lib/config";
import { getClientId } from "../lib/client-id";

/**
 * Main auth command dispatcher.
 */
export async function auth(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "login":
      return await loginCommand(args.slice(1));
    case "logout":
      return await logoutCommand(args.slice(1));
    case "status":
      return await statusCommand(args.slice(1));
    case "whoami":
      return await whoamiCommand(args.slice(1));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      showHelp();
      return;
    default:
      console.error(`Unknown auth command: ${subcommand}`);
      console.error('Run "openctl auth help" for usage information.');
      process.exit(1);
  }
}

/**
 * Show help for auth commands.
 */
function showHelp(): void {
  console.log(`
Usage: openctl auth <command> [options]

Commands:
  login     Authenticate with the server
  logout    Clear stored credentials
  status    Check authentication status
  whoami    Show current user info

Options:
  --server <url>  Server URL (default: configured server or https://openctl.dev)

Examples:
  openctl auth login
  openctl auth login --server https://my-openctl.example.com
  openctl auth status
  openctl auth logout
`);
}

/**
 * Login command - authenticate with the server.
 */
async function loginCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
    },
    allowPositionals: false,
  });

  const serverUrl = values.server || getServerUrl();

  try {
    console.log(`Authenticating with ${serverUrl}...`);
    console.log();

    const tokens = await startOAuthFlow(serverUrl);

    // Store tokens in keychain
    const keychain = getKeychain();
    await keychain.set(serverUrl, tokens);

    console.log();
    console.log(`Authenticated as ${tokens.email}`);

    // Check for unclaimed sessions
    await checkUnclaimedSessions(serverUrl, tokens.accessToken);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Authentication failed: ${error.message}`);
    } else {
      console.error("Authentication failed");
    }
    process.exit(1);
  }
}

/**
 * Logout command - clear stored credentials.
 */
async function logoutCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
      all: { type: "boolean", short: "a" },
    },
    allowPositionals: false,
  });

  const keychain = getKeychain();

  if (values.all) {
    // Logout from all servers
    const servers = await keychain.list();
    for (const server of servers) {
      await keychain.delete(server);
      console.log(`Logged out from ${server}`);
    }
    if (servers.length === 0) {
      console.log("No stored credentials found");
    }
  } else {
    const serverUrl = values.server || getServerUrl();
    await keychain.delete(serverUrl);
    console.log(`Logged out from ${serverUrl}`);
  }
}

/**
 * Status command - check authentication status.
 */
async function statusCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
    },
    allowPositionals: false,
  });

  const serverUrl = values.server || getServerUrl();
  const keychain = getKeychain();
  const tokens = await keychain.get(serverUrl);

  if (!tokens) {
    console.log("Not authenticated");
    console.log(`Server: ${serverUrl}`);
    console.log();
    console.log('Run "openctl auth login" to authenticate.');
    return;
  }

  // Check if token is valid/expired
  const isExpired = Date.now() >= tokens.expiresAt;
  const expiresIn = tokens.expiresAt - Date.now();

  console.log(`Authenticated as ${tokens.email}`);
  console.log(`Server: ${serverUrl}`);
  console.log(`User ID: ${tokens.userId}`);

  if (isExpired) {
    console.log("Status: Token expired");
    console.log();
    console.log('Run "openctl auth login" to re-authenticate.');
  } else {
    const minutes = Math.floor(expiresIn / 60000);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      console.log(`Status: Active (expires in ${hours}h ${minutes % 60}m)`);
    } else {
      console.log(`Status: Active (expires in ${minutes}m)`);
    }
  }
}

/**
 * Whoami command - show current user info.
 */
async function whoamiCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
      json: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const serverUrl = values.server || getServerUrl();

  try {
    const tokens = await getAuthenticatedTokens(serverUrl);

    if (values.json) {
      console.log(JSON.stringify({
        userId: tokens.userId,
        email: tokens.email,
        server: serverUrl,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
      }, null, 2));
    } else {
      console.log(tokens.email);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Failed to get user info");
    }
    process.exit(1);
  }
}

/**
 * Check for unclaimed sessions and prompt to claim them.
 */
async function checkUnclaimedSessions(serverUrl: string, accessToken: string): Promise<void> {
  const clientId = getClientId();

  try {
    const response = await fetch(`${serverUrl}/api/sessions/unclaimed`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Openctl-Client-ID": clientId,
      },
    });

    if (!response.ok) {
      return; // Endpoint may not exist yet or other error
    }

    const { count, sessions } = await response.json();

    if (count === 0) {
      return;
    }

    console.log();
    console.log(`Found ${count} session${count > 1 ? "s" : ""} from this device that aren't linked to your account.`);

    // Show session titles
    if (sessions && sessions.length > 0) {
      const displayCount = Math.min(sessions.length, 3);
      for (let i = 0; i < displayCount; i++) {
        console.log(`  - ${sessions[i].title}`);
      }
      if (sessions.length > displayCount) {
        console.log(`  ... and ${sessions.length - displayCount} more`);
      }
    }

    console.log();
    console.log("Claim these sessions? They'll be accessible from any device you sign into. [Y/n]");

    // Read user input
    const answer = await prompt();
    if (answer.toLowerCase() !== "n" && answer.toLowerCase() !== "no") {
      const claimResponse = await fetch(`${serverUrl}/api/sessions/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Openctl-Client-ID": clientId,
        },
      });

      if (claimResponse.ok) {
        const { claimed } = await claimResponse.json();
        console.log(`Claimed ${claimed} session${claimed > 1 ? "s" : ""}.`);
      }
    }
  } catch {
    // Silently ignore errors - claiming is optional
  }
}

/**
 * Simple prompt for user input.
 * Returns empty string (defaults to "yes") if not in interactive mode.
 */
function prompt(): Promise<string> {
  return new Promise((resolve) => {
    // In non-interactive environments, default to accepting
    if (!process.stdin.isTTY) {
      resolve("");
      return;
    }

    const stdin = Bun.stdin.stream();
    const reader = stdin.getReader();

    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      reader.releaseLock();
      resolve("");
    }, 30000); // 30 second timeout

    reader.read().then(({ value }) => {
      clearTimeout(timeout);
      reader.releaseLock();
      resolve(value ? Buffer.from(value).toString().trim() : "");
    }).catch(() => {
      clearTimeout(timeout);
      resolve("");
    });
  });
}

export default auth;
