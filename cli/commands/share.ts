import { parseArgs } from "util";
import { getServerUrl, isRepoAllowed, addAllowedRepo } from "../lib/config";
import { getRepoIdentifier, getRepoHttpsUrl } from "../lib/git";
import { getDaemonStatus } from "../daemon";
import { ApiClient } from "../daemon/api-client";
import { getAdapterForPath } from "../adapters";
import {
  addSharedSession,
  findSessionByUuid,
  findLatestSessionForProject,
  extractProjectPathFromSessionPath,
  listRecentSessions,
  promptSessionSelection,
  readLine,
} from "../lib/shared-sessions";
import { getAccessTokenIfAuthenticated } from "../lib/oauth";

export async function share(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
      list: { type: "boolean", short: "l" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    showHelp();
    return;
  }

  // 1. Resolve session UUID and path
  let sessionUuid: string | undefined;
  let sessionPath: string | null = null;
  let projectPath: string | null = null;

  if (values.list) {
    // Interactive list mode
    const sessions = await listRecentSessions(10);
    const result = await promptSessionSelection(sessions);
    if (!result.session) {
      process.exit(result.cancelled ? 0 : 1);
    }
    sessionUuid = result.session.uuid;
    sessionPath = result.session.filePath;
    projectPath = result.session.projectPath;
  } else if (positionals[0]) {
    // Explicit session ID provided
    sessionUuid = positionals[0];
    sessionPath = await findSessionByUuid(sessionUuid);
    if (!sessionPath) {
      console.error(`Error: Session not found: ${sessionUuid}`);
      process.exit(1);
    }
    projectPath = extractProjectPathFromSessionPath(sessionPath);
  } else if (Bun.env.CLAUDE_SESSION_ID) {
    // Use environment variable
    sessionUuid = Bun.env.CLAUDE_SESSION_ID;
    sessionPath = await findSessionByUuid(sessionUuid);
    if (!sessionPath) {
      console.error(`Error: Session not found: ${sessionUuid}`);
      process.exit(1);
    }
    projectPath = extractProjectPathFromSessionPath(sessionPath);
  } else {
    // Auto-detect latest session for current project
    const cwd = process.cwd();
    const latest = await findLatestSessionForProject(cwd);
    if (!latest) {
      console.error("Error: No session found for current project.");
      console.error("Use --list to select from recent sessions, or provide a session ID.");
      process.exit(1);
    }
    sessionUuid = latest.uuid;
    sessionPath = latest.filePath;
    projectPath = cwd;
    console.log(`Found session: ${sessionUuid.slice(0, 8)}...`);
  }

  // 2. Get server URL
  const serverUrl = getServerUrl(values.server);

  // 3. Check repo allowlist
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

  // 4. Get adapter for session info
  const adapter = getAdapterForPath(sessionPath);
  if (!adapter) {
    console.error("Error: No adapter found for session file.");
    process.exit(3);
  }

  const sessionInfo = adapter.getSessionInfo(sessionPath);
  const repoUrl = await getRepoHttpsUrl(projectPath || process.cwd());

  // 5. Create session on server immediately
  console.log(`Creating session on ${serverUrl}...`);
  const authToken = await getAccessTokenIfAuthenticated(serverUrl);
  const api = new ApiClient(serverUrl, undefined, authToken);

  let serverSession;
  try {
    serverSession = await api.createLiveSession({
      title: "Live Session",
      project_path: sessionInfo.projectPath,
      harness_session_id: sessionInfo.harnessSessionId,
      harness: adapter.id,
      model: sessionInfo.model,
      repo_url: repoUrl ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to create session on server: ${message}`);
    process.exit(4);
  }

  const sessionUrl = `${serverUrl}/sessions/${serverSession.id}`;

  // 6. Add to shared sessions with server session info (for daemon to pick up)
  await addSharedSession(sessionUuid, sessionPath, serverUrl, {
    sessionId: serverSession.id,
  });

  // 7. Ensure daemon is running (for live streaming)
  const status = await getDaemonStatus();
  if (!status.running) {
    console.log("Starting daemon for live streaming...");
    await startDaemonBackground(serverUrl);
  }

  if (serverSession.resumed) {
    console.log(`Resumed existing session: ${sessionUrl}`);
  } else {
    console.log(`Session shared: ${sessionUrl}`);
  }
}

function showHelp(): void {
  console.log(`
Usage: openctl share [session-id] [options]

Share a live session for real-time viewing.

Arguments:
  session-id        Session UUID (optional, auto-detects current session)

Options:
  -l, --list        Interactively select from recent sessions
  -s, --server      Server URL (default: from config)
  -h, --help        Show this help

Session Resolution (in order):
  1. If --list is provided, show interactive picker
  2. If session-id argument is provided, use that
  3. If CLAUDE_SESSION_ID env var is set, use that
  4. Auto-detect latest session for current project

Examples:
  openctl share                   # Share current/latest session
  openctl share --list            # Pick from recent sessions
  openctl share abc-123-def       # Share a specific session
  `);
}

/**
 * Start daemon in background (detached process).
 */
async function startDaemonBackground(serverUrl: string): Promise<void> {
  const cliPath = new URL("../index.ts", import.meta.url).pathname;

  const proc = Bun.spawn(["bun", "run", cliPath, "daemon", "start", "--server", serverUrl], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();
}
