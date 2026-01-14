/**
 * Manages WebSocket connections from PTY wrappers.
 *
 * The wrapper is the CLI process that spawns Claude and manages the PTY.
 * It connects to the server to relay output and receive injected feedback.
 */

import type { ServerWebSocket } from "bun";
import type {
  WrapperToServerMessage,
  ServerToWrapperMessage,
  ServerToBrowserMessage,
} from "./websocket-types";
import type { SessionRepository } from "../db/repository";
import { broadcastToSession } from "./api";

/**
 * Data attached to wrapper WebSocket connections.
 */
export interface WrapperWebSocketData {
  sessionId: string;
  isWrapper: true;
}

/**
 * Internal state for a wrapper connection.
 */
interface WrapperConnection {
  ws: ServerWebSocket<WrapperWebSocketData>;
  sessionId: string;
  authenticated: boolean;
}

// Map of session ID to wrapper connection
const wrapperConnections = new Map<string, WrapperConnection>();

/**
 * Register a new wrapper WebSocket connection.
 * The connection is not yet authenticated.
 */
export function addWrapperConnection(
  sessionId: string,
  ws: ServerWebSocket<WrapperWebSocketData>
): void {
  wrapperConnections.set(sessionId, {
    ws,
    sessionId,
    authenticated: false,
  });
}

/**
 * Remove a wrapper connection from tracking.
 */
export function removeWrapperConnection(sessionId: string): void {
  wrapperConnections.delete(sessionId);
}

/**
 * Get the wrapper connection for a session.
 */
export function getWrapperConnection(sessionId: string): WrapperConnection | undefined {
  return wrapperConnections.get(sessionId);
}

/**
 * Check if a wrapper is connected and authenticated for a session.
 */
export function isWrapperConnected(sessionId: string): boolean {
  const conn = wrapperConnections.get(sessionId);
  return conn?.authenticated ?? false;
}

/**
 * Hash a token using SHA-256.
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Authenticate a wrapper connection using its stream token.
 * Returns true if authentication succeeded.
 */
export async function authenticateWrapper(
  sessionId: string,
  token: string,
  repo: SessionRepository
): Promise<boolean> {
  const conn = wrapperConnections.get(sessionId);
  if (!conn) return false;

  const session = repo.getSession(sessionId);
  if (!session) return false;

  // Verify the token hash matches
  const tokenHash = await hashToken(token);
  if (!repo.verifyStreamToken(sessionId, tokenHash)) {
    return false;
  }

  conn.authenticated = true;
  repo.setWrapperConnected(sessionId, true);

  // Notify browsers that wrapper is now connected
  broadcastToSession(sessionId, {
    type: "wrapper_status",
    connected: true,
  } as ServerToBrowserMessage);

  return true;
}

/**
 * Send a message to the wrapper for a session.
 * Returns true if the message was sent.
 */
export function sendToWrapper(sessionId: string, message: ServerToWrapperMessage): boolean {
  const conn = wrapperConnections.get(sessionId);
  if (!conn?.authenticated) return false;

  try {
    conn.ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle a message from a wrapper.
 */
export async function handleWrapperMessage(
  sessionId: string,
  message: WrapperToServerMessage,
  repo: SessionRepository
): Promise<void> {
  const conn = wrapperConnections.get(sessionId);
  if (!conn) return;

  switch (message.type) {
    case "auth": {
      const success = await authenticateWrapper(sessionId, message.token, repo);
      conn.ws.send(
        JSON.stringify({
          type: success ? "auth_ok" : "auth_failed",
        })
      );
      if (!success) {
        conn.ws.close(4001, "Authentication failed");
      }
      break;
    }

    case "output":
      // Only relay if authenticated
      if (!conn.authenticated) return;

      // Broadcast raw output to browsers (for live terminal display)
      broadcastToSession(sessionId, {
        type: "output",
        data: message.data,
      } as ServerToBrowserMessage);
      break;

    case "state":
      // Only relay if authenticated
      if (!conn.authenticated) return;

      // Broadcast state change to browsers
      broadcastToSession(sessionId, {
        type: "state",
        state: message.state,
      } as ServerToBrowserMessage);
      break;

    case "ended": {
      // Only process if authenticated
      if (!conn.authenticated) return;

      // Mark session complete
      repo.updateSessionStatus(sessionId, "complete");
      repo.setWrapperConnected(sessionId, false);

      // Broadcast completion to browsers
      const messageCount = repo.getMessageCount(sessionId);
      broadcastToSession(sessionId, {
        type: "complete",
        final_message_count: messageCount,
      } as ServerToBrowserMessage);
      break;
    }

    case "feedback_status": {
      // Only process if authenticated
      if (!conn.authenticated) return;

      // Update feedback message status in database
      repo.updateFeedbackStatus(message.message_id, message.status);

      // Notify browsers of the status change
      broadcastToSession(sessionId, {
        type: "feedback_status",
        message_id: message.message_id,
        status: message.status,
      } as ServerToBrowserMessage);
      break;
    }
  }
}

/**
 * Handle wrapper WebSocket disconnection.
 */
export function handleWrapperClose(sessionId: string, repo: SessionRepository): void {
  const conn = wrapperConnections.get(sessionId);
  if (conn?.authenticated) {
    repo.setWrapperConnected(sessionId, false);

    // Notify browsers that wrapper disconnected
    broadcastToSession(sessionId, {
      type: "wrapper_status",
      connected: false,
    } as ServerToBrowserMessage);
  }

  wrapperConnections.delete(sessionId);
}

/**
 * Close all wrapper connections (for graceful shutdown).
 */
export function closeAllWrapperConnections(): void {
  for (const [, conn] of wrapperConnections) {
    try {
      conn.ws.close(1001, "Server shutting down");
    } catch {
      // Ignore errors during shutdown
    }
  }
  wrapperConnections.clear();
}
