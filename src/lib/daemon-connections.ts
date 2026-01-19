/**
 * Server-side Daemon Connection Tracking
 *
 * Manages connected daemon WebSocket connections and provides
 * methods to communicate with daemons.
 */

import type { ServerWebSocket } from "bun";
import type {
  ServerToDaemonMessage,
  SpawnableHarnessInfo,
} from "../types/daemon-ws";
import { spawnedSessionRegistry } from "./spawned-session-registry";
import { broadcastToSession } from "../routes/api";

// Maximum concurrent spawned sessions per daemon
const MAX_CONCURRENT_SESSIONS_PER_DAEMON = 3;

export interface DaemonWebSocketData {
  type: "daemon";
  clientId?: string;
}

export interface ConnectedDaemon {
  clientId: string;
  ws: ServerWebSocket<DaemonWebSocketData>;
  connectedAt: Date;
  capabilities: {
    can_spawn_sessions: boolean;
    spawnable_harnesses: SpawnableHarnessInfo[];
  };
  activeSpawnedSessions: Set<string>;
}

class DaemonConnectionManager {
  private daemons = new Map<string, ConnectedDaemon>();

  addDaemon(
    clientId: string,
    ws: ServerWebSocket<DaemonWebSocketData>,
    capabilities: ConnectedDaemon["capabilities"]
  ): void {
    // If there's an existing connection with same clientId, close it
    const existing = this.daemons.get(clientId);
    if (existing) {
      console.log(`[daemon-mgr] Replacing existing connection for ${clientId}`);
      try {
        existing.ws.close();
      } catch {
        // Ignore close errors
      }
    }

    this.daemons.set(clientId, {
      clientId,
      ws,
      connectedAt: new Date(),
      capabilities,
      activeSpawnedSessions: new Set(),
    });

    console.log(`[daemon-mgr] Daemon connected: ${clientId}`);
  }

  removeDaemon(clientId: string): void {
    const daemon = this.daemons.get(clientId);
    if (daemon) {
      // Mark all active spawned sessions as disconnected and preserve recovery info
      for (const sessionId of daemon.activeSpawnedSessions) {
        const session = spawnedSessionRegistry.getSession(sessionId);
        if (session && session.status !== "ended" && session.status !== "failed") {
          // Check if we have a claude session ID for potential resume
          const canResume = !!session.claudeSessionId;

          if (canResume && session.claudeSessionId) {
            // Preserve recovery info for potential resume
            spawnedSessionRegistry.updateForRecovery(sessionId, session.claudeSessionId);
          }

          spawnedSessionRegistry.updateSession(sessionId, {
            status: "disconnected",
            error: "Daemon disconnected",
          });

          // Notify browser subscribers with recovery info
          broadcastToSession(sessionId, {
            type: "daemon_disconnected",
            session_id: sessionId,
            message: "Connection to daemon lost",
            can_resume: canResume,
            claude_session_id: session.claudeSessionId,
          });

          console.log(`[daemon-mgr] Session ${sessionId} marked disconnected (can_resume=${canResume})`);
        }
      }
    }

    this.daemons.delete(clientId);
    console.log(`[daemon-mgr] Daemon disconnected: ${clientId}`);
  }

  getDaemon(clientId: string): ConnectedDaemon | undefined {
    return this.daemons.get(clientId);
  }

  getAnyConnectedDaemon(): ConnectedDaemon | undefined {
    // Return the first connected daemon (for single-user scenarios)
    // In multi-user scenarios, you'd match based on user ownership
    for (const daemon of this.daemons.values()) {
      return daemon;
    }
    return undefined;
  }

  sendToDaemon(clientId: string, message: ServerToDaemonMessage): boolean {
    const daemon = this.daemons.get(clientId);
    if (!daemon) {
      console.error(`[daemon-mgr] Cannot send to ${clientId}: not connected`);
      return false;
    }

    try {
      daemon.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`[daemon-mgr] Failed to send to ${clientId}:`, error);
      return false;
    }
  }

  getStatus(): {
    connected: boolean;
    client_id?: string;
    capabilities?: ConnectedDaemon["capabilities"];
  } {
    const daemon = this.getAnyConnectedDaemon();
    if (!daemon) {
      return { connected: false };
    }

    return {
      connected: true,
      client_id: daemon.clientId,
      capabilities: daemon.capabilities,
    };
  }

  getAllConnected(): ConnectedDaemon[] {
    return Array.from(this.daemons.values());
  }

  /**
   * Register a spawned session with a daemon.
   * Returns true if registration succeeded, false if limit exceeded.
   */
  registerSpawnedSession(clientId: string, sessionId: string): boolean {
    const daemon = this.daemons.get(clientId);
    if (!daemon) return false;

    // Check concurrent session limit
    if (daemon.activeSpawnedSessions.size >= MAX_CONCURRENT_SESSIONS_PER_DAEMON) {
      console.warn(`[daemon-mgr] Max concurrent sessions (${MAX_CONCURRENT_SESSIONS_PER_DAEMON}) reached for ${clientId}`);
      return false;
    }

    daemon.activeSpawnedSessions.add(sessionId);
    return true;
  }

  /**
   * Get maximum concurrent sessions per daemon.
   */
  getMaxConcurrentSessions(): number {
    return MAX_CONCURRENT_SESSIONS_PER_DAEMON;
  }

  /**
   * Check if a daemon can accept more sessions.
   * Returns true if under limit, false if at or over limit.
   */
  canAcceptSession(clientId: string): boolean {
    const daemon = this.daemons.get(clientId);
    if (!daemon) return false;
    return daemon.activeSpawnedSessions.size < MAX_CONCURRENT_SESSIONS_PER_DAEMON;
  }

  unregisterSpawnedSession(clientId: string, sessionId: string): void {
    const daemon = this.daemons.get(clientId);
    if (daemon) {
      daemon.activeSpawnedSessions.delete(sessionId);
    }
  }

  /**
   * Clear all connections. Used for testing.
   */
  clear(): void {
    for (const daemon of this.daemons.values()) {
      try {
        daemon.ws.close();
      } catch {
        // Ignore close errors
      }
    }
    this.daemons.clear();
  }
}

export const daemonConnections = new DaemonConnectionManager();
