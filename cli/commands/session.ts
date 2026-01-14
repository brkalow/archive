import { parseArgs } from "util";
import { loadConfig } from "../lib/config";
import { getClientId } from "../lib/client-id";

export async function session(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      return sessionList(args.slice(1));
    case "delete":
      return sessionDelete(args.slice(1));
    default:
      showHelp();
  }
}

function showHelp(): void {
  console.log(`
Usage: archive session <subcommand> [options]

Subcommands:
  list              List sessions on the server
  delete <id>       Delete a session

Options for 'list':
  --mine            Only show sessions uploaded by this client
  --project <path>  Filter by project path
  --limit <n>       Number of sessions to show (default: 10)
  --json            Output as JSON
  --server <url>    Server URL (default: from config)

Options for 'delete':
  --force           Skip confirmation prompt
  --server <url>    Server URL (default: from config)

Examples:
  archive session list              # List recent sessions
  archive session list --mine       # List only my sessions
  archive session delete abc123     # Delete a session
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

  const config = loadConfig();
  const serverUrl = values.server || config.server || "http://localhost:3000";

  // Build query string
  const params = new URLSearchParams();
  if (values.mine) params.set("mine", "true");
  if (values.project) params.set("project", values.project);

  const url = `${serverUrl}/api/sessions${params.toString() ? `?${params}` : ""}`;

  const response = await fetch(url, {
    headers: {
      "X-Archive-Client-ID": getClientId(),
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
    console.log("Usage: archive session delete <session-id> [--force]");
    process.exit(1);
  }

  const config = loadConfig();
  const serverUrl = values.server || config.server || "http://localhost:3000";

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
      "X-Archive-Client-ID": getClientId(),
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
