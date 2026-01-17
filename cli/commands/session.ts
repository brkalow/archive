import { parseArgs } from "util";
import { getServerUrl, isRepoAllowed, addAllowedRepo } from "../lib/config";
import { getClientId } from "../lib/client-id";
import { getRepoIdentifier } from "../lib/git";
import { getDaemonStatus } from "../daemon";
import {
  addSharedSession,
  removeSharedSession,
  findSessionByUuid,
  extractProjectPathFromSessionPath,
} from "../lib/shared-sessions";

export async function session(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      return sessionList(args.slice(1));
    case "delete":
      return sessionDelete(args.slice(1));
    case "start":
      return sessionStart(args.slice(1));
    case "share":
      return sessionShare(args.slice(1));
    case "unshare":
      return sessionUnshare(args.slice(1));
    default:
      showHelp();
  }
}

function showHelp(): void {
  console.log(`
Usage: openctl session <subcommand> [options]

Subcommands:
  list              List sessions on the server
  delete <id>       Delete a session
  share [id]        Share a session with the server
  unshare [id]      Stop sharing a session

Options for 'list':
  --mine            Only show sessions uploaded by this client
  --project <path>  Filter by project path
  --limit <n>       Number of sessions to show (default: 10)
  --json            Output as JSON
  --server <url>    Server URL (default: from config)

Options for 'delete':
  --force           Skip confirmation prompt
  --server <url>    Server URL (default: from config)

Options for 'share':
  --server <url>    Server URL (default: from config)

Options for 'unshare':
  --server <url>    Server URL to unshare from (default: all servers)

Examples:
  openctl session list              # List recent sessions
  openctl session list --mine       # List only my sessions
  openctl session delete abc123     # Delete a session
  openctl session share             # Share current session (uses CLAUDE_SESSION_ID)
  openctl session share abc-123     # Share a specific session by UUID
  openctl session unshare abc-123   # Stop sharing a session
  `);
}

interface SessionResponse {
  id: string;
  title: string;
  created_at: string;
  project_path: string | null;
  status: string;
}

async function sessionList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      mine: { type: "boolean" },
      project: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean" },
      server: { type: "string" },
    },
  });

  const serverUrl = getServerUrl(values.server);

  // Build query string
  const params = new URLSearchParams();
  if (values.mine) params.set("mine", "true");
  if (values.project) params.set("project", values.project);

  const url = `${serverUrl}/api/sessions${params.toString() ? `?${params}` : ""}`;

  const response = await fetch(url, {
    headers: {
      "X-Openctl-Client-ID": getClientId(),
    },
  });

  if (!response.ok) {
    console.error(`Failed to list sessions: ${response.status}`);
    process.exit(1);
  }

  const { sessions } = (await response.json()) as { sessions: SessionResponse[] };

  // Apply limit (client-side for now since API doesn't support it)
  const limit = values.limit ? parseInt(values.limit, 10) : 10;
  const limitedSessions = sessions.slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify(limitedSessions, null, 2));
  } else {
    if (limitedSessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    // Format and display sessions
    for (const s of limitedSessions) {
      const date = new Date(s.created_at).toLocaleDateString();
      const status = s.status === "live" ? " [LIVE]" : "";
      console.log(`${s.id}  ${date}  ${s.title}${status}`);
    }

    if (sessions.length > limit) {
      console.log(`\n(showing ${limit} of ${sessions.length} sessions)`);
    }
  }
}

async function sessionDelete(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      server: { type: "string" },
    },
    allowPositionals: true,
  });

  const sessionId = positionals[0];
  if (!sessionId) {
    console.error("Error: Session ID is required");
    console.log("Usage: openctl session delete <session-id> [--force]");
    process.exit(1);
  }

  const serverUrl = getServerUrl(values.server);

  // Confirm unless --force
  if (!values.force) {
    process.stdout.write(`Delete session ${sessionId}? This cannot be undone. [y/N] `);
    const response = await readLine();
    if (response.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }
  }

  const response = await fetch(`${serverUrl}/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: {
      "X-Openctl-Client-ID": getClientId(),
    },
  });

  if (response.status === 403) {
    console.error("Error: Permission denied");
    console.error("This session was uploaded from a different device.");
    process.exit(1);
  }

  if (response.status === 404) {
    console.error(`Error: Session not found`);
    console.error(`No session with ID '${sessionId}' exists on this server.`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`Failed to delete session: ${response.status}`);
    process.exit(1);
  }

  console.log(`Session ${sessionId} deleted.`);
}

async function readLine(): Promise<string> {
  // Simple stdin reader for confirmation
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  // Handle EOF (value is undefined when stdin is closed)
  if (!value) {
    return "";
  }
  return decoder.decode(value).trim();
}

async function sessionStart(_args: string[]): Promise<void> {
  console.error("Error: 'session start' is not yet implemented.");
  console.error("Use Claude Code directly and upload sessions with 'openctl upload'.");
  process.exit(1);
}

async function sessionShare(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
    },
    allowPositionals: true,
  });

  // 1. Get session UUID - from arg or CLAUDE_SESSION_ID env var
  let sessionUuid = positionals[0];
  if (!sessionUuid) {
    sessionUuid = Bun.env.CLAUDE_SESSION_ID;
    if (!sessionUuid) {
      console.error("Error: Session ID required (or set CLAUDE_SESSION_ID)");
      process.exit(1);
    }
  }

  // 2. Find session file path
  const sessionPath = await findSessionByUuid(sessionUuid);
  if (!sessionPath) {
    console.error(`Error: Session not found: ${sessionUuid}`);
    process.exit(1);
  }

  // 3. Extract project path from session
  const projectPath = extractProjectPathFromSessionPath(sessionPath);

  // 4. Get server URL
  const serverUrl = getServerUrl(values.server);

  // 5. Check repo allowlist
  const repoId = await getRepoIdentifier(projectPath || process.cwd());
  if (!repoId) {
    console.error("Error: Could not determine repository identifier.");
    console.error("Make sure you're in a git repository or the session is from a git project.");
    process.exit(2);
  }

  if (!isRepoAllowed(serverUrl, repoId)) {
    // Interactive: prompt to allow
    if (process.stdin.isTTY) {
      console.log(`This repository hasn't been allowed for sharing with ${serverUrl}.`);
      process.stdout.write("Allow this repository? [y/N] ");
      const response = await readLine();
      if (response.toLowerCase() === "y") {
        addAllowedRepo(serverUrl, repoId);
        console.log("Repository allowed.");
      } else {
        console.error("Aborted: Repository not allowed.");
        console.error("Run: openctl repo allow");
        process.exit(2);
      }
    } else {
      console.error("Error: Repository not allowed. Run: openctl repo allow");
      process.exit(2);
    }
  }

  // 6. Add to shared sessions allowlist
  await addSharedSession(sessionUuid, sessionPath, serverUrl);
  console.log(`Sharing session with ${serverUrl}...`);

  // 7. Ensure daemon is running
  const status = await getDaemonStatus();
  if (!status.running) {
    console.log("Starting daemon...");
    await startDaemonBackground(serverUrl);
    await Bun.sleep(1000);
  }

  // 8. Poll for session URL (daemon will create session on server)
  const sessionUrl = await pollForSessionUrl(sessionUuid, serverUrl);
  if (!sessionUrl) {
    console.error(`Error: Timed out waiting for session URL from ${serverUrl}`);
    console.error("The daemon may not be running or the server may be unreachable.");
    process.exit(4);
  }

  console.log(`Session shared: ${sessionUrl}`);
}

async function sessionUnshare(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
    },
    allowPositionals: true,
  });

  const sessionUuid = positionals[0] || Bun.env.CLAUDE_SESSION_ID;
  if (!sessionUuid) {
    console.error("Error: Session ID required");
    process.exit(1);
  }

  const serverUrl = values.server; // undefined means all servers

  await removeSharedSession(sessionUuid, serverUrl);
  console.log(`Session unshared${serverUrl ? ` from ${serverUrl}` : ""}.`);
}

/**
 * Poll server for session URL by querying with claude_session_id.
 */
async function pollForSessionUrl(
  sessionUuid: string,
  serverUrl: string,
  timeoutMs = 30000
): Promise<string | null> {
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(
        `${serverUrl}/api/sessions?claude_session_id=${encodeURIComponent(sessionUuid)}`
      );
      if (response.ok) {
        const data = (await response.json()) as { session?: { id: string }; url?: string };
        if (data.session?.id) {
          return data.url || `${serverUrl}/sessions/${data.session.id}`;
        }
      }
    } catch {
      // Server not reachable, continue polling
    }
    await Bun.sleep(pollInterval);
  }
  return null;
}

/**
 * Start daemon in background (detached process).
 */
async function startDaemonBackground(serverUrl: string): Promise<void> {
  // Find the CLI entry point
  const cliPath = new URL("../index.ts", import.meta.url).pathname;

  const proc = Bun.spawn(["bun", "run", cliPath, "daemon", "start", "--server", serverUrl], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();
}
