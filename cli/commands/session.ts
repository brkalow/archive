import { parseArgs } from "util";
import { getServerUrl } from "../lib/config";
import { getClientId } from "../lib/client-id";
import { ApiClient } from "../daemon/api-client";
import {
  removeSharedSession,
  getSharedSessions,
} from "../lib/shared-sessions";
import { getAccessTokenIfAuthenticated } from "../lib/oauth";

export async function session(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      return sessionList(args.slice(1));
    case "delete":
      return sessionDelete(args.slice(1));
    case "unshare":
      return sessionUnshare(args.slice(1));
    case "feedback":
      return sessionFeedback(args.slice(1));
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
  unshare [id]      Stop sharing a session
  feedback [id]     Check for pending feedback (outputs JSON)

Options for 'list':
  --mine            Only show sessions uploaded by this client
  --project <path>  Filter by project path
  --limit <n>       Number of sessions to show (default: 10)
  --json            Output as JSON
  --server <url>    Server URL (default: from config)

Options for 'delete':
  --force           Skip confirmation prompt
  --server <url>    Server URL (default: from config)

Options for 'unshare':
  --server <url>    Server URL to unshare from (default: all servers)

Options for 'feedback':
  --server <url>    Server URL (default: from config)
  Output: {} if no feedback, or {decision:"block",reason:"..."} if pending

Examples:
  openctl session list              # List recent sessions
  openctl session list --mine       # List only my sessions
  openctl session delete abc123     # Delete a session
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
  const authToken = await getAccessTokenIfAuthenticated(serverUrl);

  // Build query string
  const params = new URLSearchParams();
  if (values.mine) params.set("mine", "true");
  if (values.project) params.set("project", values.project);

  const url = `${serverUrl}/api/sessions${params.toString() ? `?${params}` : ""}`;

  const headers: Record<string, string> = {
    "X-Openctl-Client-ID": getClientId(),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const response = await fetch(url, { headers });

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
  const authToken = await getAccessTokenIfAuthenticated(serverUrl);

  // Confirm unless --force
  if (!values.force) {
    process.stdout.write(`Delete session ${sessionId}? This cannot be undone. [y/N] `);
    const response = await readLine();
    if (response.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }
  }

  const headers: Record<string, string> = {
    "X-Openctl-Client-ID": getClientId(),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${serverUrl}/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers,
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

  // Get the shared session info before removing it
  const config = getSharedSessions();
  const sharedSession = config.sessions[sessionUuid];

  // Complete the session on each server before removing locally
  if (sharedSession?.serverSessions) {
    const serversToComplete = serverUrl
      ? [serverUrl].filter((s) => sharedSession.servers.includes(s))
      : sharedSession.servers;

    for (const server of serversToComplete) {
      const serverInfo = sharedSession.serverSessions[server];
      if (serverInfo?.sessionId) {
        // Get auth token for this server
        const authToken = await getAccessTokenIfAuthenticated(server);
        const api = new ApiClient(server, undefined, authToken);

        // Disable interactive mode first
        try {
          await api.disableInteractive(serverInfo.sessionId);
        } catch {
          // Non-critical - session might not have been interactive
        }

        // Complete the session
        try {
          await api.completeSession(serverInfo.sessionId);
          console.log(`Session completed on ${server}`);
        } catch (err) {
          // Log but continue - session might already be complete or server unreachable
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Warning: Failed to complete session on ${server}: ${message}`);
        }
      }
    }
  }

  await removeSharedSession(sessionUuid, serverUrl);
  console.log(`Session unshared${serverUrl ? ` from ${serverUrl}` : ""}.`);
}

interface PendingFeedback {
  id: string;
  content: string;
  type: "message" | "diff_comment" | "suggested_edit";
  source?: string;
  created_at: string;
  context?: {
    file: string;
    line: number;
  };
}

interface PendingFeedbackResponse {
  pending: boolean;
  messages: PendingFeedback[];
  session_id: string;
}

/**
 * Check for pending feedback and output JSON for the stop hook.
 * If feedback is pending, outputs { decision: "block", reason: "..." }
 * Otherwise outputs {}
 */
async function sessionFeedback(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
    },
    allowPositionals: true,
  });

  const sessionUuid = positionals[0] || Bun.env.CLAUDE_SESSION_ID;
  if (!sessionUuid) {
    // No session - allow stop
    console.log("{}");
    process.exit(0);
  }

  const serverUrl = getServerUrl(values.server);
  const authToken = await getAccessTokenIfAuthenticated(serverUrl);

  // Build headers with optional auth
  const headers: Record<string, string> = {
    "X-Openctl-Client-ID": getClientId(),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    const url = `${serverUrl}/api/sessions/by-claude-session/${encodeURIComponent(sessionUuid)}/feedback/pending`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      // Session not found or error - allow stop
      console.log("{}");
      process.exit(0);
    }

    const data = (await response.json()) as PendingFeedbackResponse;

    if (!data.pending || data.messages.length === 0) {
      console.log("{}");
      process.exit(0);
    }

    // Format feedback messages
    const reason = formatBatchedFeedback(data.messages);

    // Mark all as delivered (errors are non-critical, feedback was already formatted)
    await Promise.all(
      data.messages.map((m) =>
        fetch(`${serverUrl}/api/sessions/${data.session_id}/feedback/${m.id}/delivered`, {
          method: "POST",
          headers,
        }).catch((err) => {
          // Log to stderr but don't fail - the important part (formatting feedback) succeeded
          console.error(`[feedback] Failed to mark message ${m.id} as delivered: ${err instanceof Error ? err.message : String(err)}`);
        })
      )
    );

    // Output blocking response
    console.log(JSON.stringify({ decision: "block", reason }));
  } catch {
    // Network error - allow stop
    console.log("{}");
    process.exit(0);
  }
}

/**
 * Format multiple feedback messages into a single batched message.
 */
function formatBatchedFeedback(messages: PendingFeedback[]): string {
  if (messages.length === 1) {
    return formatSingleFeedback(messages[0]!);
  }

  const header = `[${messages.length} remote feedback messages]`;
  const formatted = messages.map((m, i) => {
    const num = i + 1;
    return `--- Feedback ${num} ---\n${formatSingleFeedback(m)}`;
  });

  return `${header}\n\n${formatted.join("\n\n")}\n\nPlease address all feedback above.`;
}

/**
 * Format a single feedback message.
 */
function formatSingleFeedback(feedback: PendingFeedback): string {
  if (feedback.type === "diff_comment" && feedback.context) {
    return `[Feedback on ${feedback.context.file}:${feedback.context.line}]

${feedback.content}`;
  }

  if (feedback.type === "suggested_edit" && feedback.context) {
    return `[Suggested edit for ${feedback.context.file}]

${feedback.content}`;
  }

  const source = feedback.source ? ` from ${feedback.source}` : "";
  return `[Remote feedback${source}]

${feedback.content}`;
}
