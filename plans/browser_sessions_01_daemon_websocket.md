# Phase 1: Daemon WebSocket Infrastructure

> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

This plan establishes bidirectional WebSocket communication between the daemon and server. Currently, the daemon uses HTTP REST to push updates. For browser-initiated sessions, the server needs to send commands to the daemon (start session, send input, etc.), requiring a persistent WebSocket connection.

## Dependencies

- Existing daemon implementation (`cli/daemon.ts`)
- Existing server WebSocket support (from live_streaming)

## Tasks

### 1. Define Daemon WebSocket Message Types

Create shared type definitions for daemon↔server communication.

**File:** `cli/types/daemon-ws.ts`

```typescript
// ============================================
// Daemon → Server Messages
// ============================================

export interface DaemonConnectedMessage {
  type: "daemon_connected";
  client_id: string;
  capabilities: {
    can_spawn_sessions: boolean;
    spawnable_harnesses: SpawnableHarnessInfo[];
  };
}

export interface SpawnableHarnessInfo {
  id: string;                    // "claude-code", "aider", etc.
  name: string;                  // Human-readable name
  available: boolean;            // Is the CLI installed?
  supports_permission_relay: boolean;
  supports_streaming: boolean;
  default_model?: string;
}

export interface SessionOutputMessage {
  type: "session_output";
  session_id: string;
  messages: StreamJsonMessage[];
}

export interface SessionEndedMessage {
  type: "session_ended";
  session_id: string;
  exit_code: number;
  error?: string;
  reason?: "completed" | "user_terminated" | "error" | "timeout";
}

export interface PermissionPromptMessage {
  type: "permission_prompt";
  session_id: string;
  request_id: string;
  tool: string;
  description: string;
  details: Record<string, unknown>;
}

export interface QuestionPromptMessage {
  type: "question_prompt";
  session_id: string;
  tool_use_id: string;
  question: string;
  options?: string[];
}

export type DaemonToServerMessage =
  | DaemonConnectedMessage
  | SessionOutputMessage
  | SessionEndedMessage
  | PermissionPromptMessage
  | QuestionPromptMessage;

// ============================================
// Server → Daemon Messages
// ============================================

export interface StartSessionMessage {
  type: "start_session";
  session_id: string;          // Server-assigned ID
  prompt: string;              // Initial prompt
  cwd: string;                 // Working directory
  harness?: string;            // "claude-code" (default), "aider", etc.
  model?: string;              // Model to use
  permission_mode?: "relay" | "auto" | "deny";
  resume_session_id?: string;  // Harness session ID to resume
}

export interface SendInputMessage {
  type: "send_input";
  session_id: string;
  content: string;
}

export interface EndSessionMessage {
  type: "end_session";
  session_id: string;
}

export interface InterruptSessionMessage {
  type: "interrupt_session";
  session_id: string;
}

export interface PermissionResponseMessage {
  type: "permission_response";
  session_id: string;
  request_id: string;
  allow: boolean;
}

export interface QuestionResponseMessage {
  type: "question_response";
  session_id: string;
  tool_use_id: string;
  answer: string;
}

export type ServerToDaemonMessage =
  | StartSessionMessage
  | SendInputMessage
  | EndSessionMessage
  | InterruptSessionMessage
  | PermissionResponseMessage
  | QuestionResponseMessage;

// ============================================
// Stream JSON types (from Claude Code output)
// ============================================

export interface StreamJsonMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  message?: {
    id?: string;
    role: string;
    content: ContentBlock[];
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  session_id?: string;
  cwd?: string;
  duration_ms?: number;
  is_error?: boolean;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}
```

### 2. Add Server-Side Type Definitions

Mirror the types on the server side.

**File:** `src/types/daemon-ws.ts`

Copy the same type definitions (or import from a shared package if using monorepo structure). For now, duplicate with a note about keeping in sync.

```typescript
// Types shared with cli/types/daemon-ws.ts
// Keep in sync manually until we have a shared package

// ... same types as above ...
```

### 3. Daemon WebSocket Connection Manager

Implement the daemon-side WebSocket connection with reconnection logic.

**File:** `cli/lib/daemon-ws.ts`

```typescript
import { config } from "../config";
import type {
  DaemonToServerMessage,
  ServerToDaemonMessage,
  SpawnableHarnessInfo,
} from "../types/daemon-ws";

type MessageHandler = (message: ServerToDaemonMessage) => void;

interface DaemonWSOptions {
  serverUrl: string;
  clientId: string;
  onMessage: MessageHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class DaemonWebSocket {
  private ws: WebSocket | null = null;
  private options: DaemonWSOptions;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private isConnecting = false;
  private shouldReconnect = true;
  private heartbeatInterval: Timer | null = null;

  constructor(options: DaemonWSOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    try {
      const wsUrl = this.options.serverUrl
        .replace(/^http/, "ws")
        .replace(/\/$/, "") + "/api/daemon/ws";

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;

        // Send daemon_connected message
        this.sendConnectedMessage();

        // Start heartbeat
        this.startHeartbeat();

        this.options.onConnect?.();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerToDaemonMessage;
          this.options.onMessage(message);
        } catch (error) {
          console.error("[daemon-ws] Failed to parse message:", error);
        }
      };

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.stopHeartbeat();
        this.options.onDisconnect?.();

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error("[daemon-ws] WebSocket error:", error);
      };
    } catch (error) {
      this.isConnecting = false;
      console.error("[daemon-ws] Failed to connect:", error);
      this.scheduleReconnect();
    }
  }

  private sendConnectedMessage(): void {
    const capabilities = this.detectCapabilities();

    this.send({
      type: "daemon_connected",
      client_id: this.options.clientId,
      capabilities: {
        can_spawn_sessions: capabilities.length > 0,
        spawnable_harnesses: capabilities,
      },
    });
  }

  private detectCapabilities(): SpawnableHarnessInfo[] {
    const harnesses: SpawnableHarnessInfo[] = [];

    // Check for Claude Code
    try {
      const result = Bun.spawnSync(["which", "claude"]);
      if (result.exitCode === 0) {
        harnesses.push({
          id: "claude-code",
          name: "Claude Code",
          available: true,
          supports_permission_relay: true,
          supports_streaming: true,
        });
      }
    } catch {
      // Claude not available
    }

    // Check for Aider (future)
    // try {
    //   const result = Bun.spawnSync(["which", "aider"]);
    //   if (result.exitCode === 0) {
    //     harnesses.push({
    //       id: "aider",
    //       name: "Aider",
    //       available: true,
    //       supports_permission_relay: false,
    //       supports_streaming: true,
    //     });
    //   }
    // } catch {}

    return harnesses;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[daemon-ws] Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);

    console.log(`[daemon-ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  send(message: DaemonToServerMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.error("[daemon-ws] Cannot send, WebSocket not open");
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
```

### 4. Integrate WebSocket into Daemon

Modify the daemon to establish WebSocket connection alongside HTTP.

**File:** `cli/daemon.ts` (modify existing)

```typescript
import { DaemonWebSocket } from "./lib/daemon-ws";
import type { ServerToDaemonMessage } from "./types/daemon-ws";

// Add to DaemonService class or top-level daemon code:

let daemonWs: DaemonWebSocket | null = null;

function initWebSocket(serverUrl: string, clientId: string): void {
  daemonWs = new DaemonWebSocket({
    serverUrl,
    clientId,
    onMessage: handleServerMessage,
    onConnect: () => {
      console.log("[daemon] WebSocket connected to server");
    },
    onDisconnect: () => {
      console.log("[daemon] WebSocket disconnected from server");
    },
  });

  daemonWs.connect();
}

function handleServerMessage(message: ServerToDaemonMessage): void {
  switch (message.type) {
    case "start_session":
      // Will be implemented in Phase 2
      console.log("[daemon] Received start_session:", message.session_id);
      break;

    case "send_input":
      // Will be implemented in Phase 2
      console.log("[daemon] Received send_input:", message.session_id);
      break;

    case "end_session":
      // Will be implemented in Phase 2
      console.log("[daemon] Received end_session:", message.session_id);
      break;

    case "interrupt_session":
      // Will be implemented in Phase 2
      console.log("[daemon] Received interrupt_session:", message.session_id);
      break;

    case "permission_response":
      // Will be implemented in Phase 6
      console.log("[daemon] Received permission_response:", message.session_id);
      break;

    case "question_response":
      // Will be implemented in Phase 6
      console.log("[daemon] Received question_response:", message.session_id);
      break;

    default:
      console.warn("[daemon] Unknown message type:", (message as any).type);
  }
}

// Call initWebSocket when daemon starts
// Add to existing daemon startup code:
// initWebSocket(config.serverUrl, clientId);
```

### 5. Server-Side Daemon Connection Tracking

Track connected daemons on the server.

**File:** `src/lib/daemon-connections.ts`

```typescript
import type { ServerWebSocket } from "bun";
import type {
  DaemonToServerMessage,
  ServerToDaemonMessage,
  SpawnableHarnessInfo,
} from "../types/daemon-ws";

export interface ConnectedDaemon {
  clientId: string;
  ws: ServerWebSocket<{ type: "daemon"; clientId: string }>;
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
    ws: ServerWebSocket<{ type: "daemon"; clientId: string }>,
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
      // Mark any active spawned sessions as disconnected
      for (const sessionId of daemon.activeSpawnedSessions) {
        // Will emit events for session disconnection handling
        console.log(`[daemon-mgr] Session ${sessionId} lost daemon connection`);
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

  registerSpawnedSession(clientId: string, sessionId: string): void {
    const daemon = this.daemons.get(clientId);
    if (daemon) {
      daemon.activeSpawnedSessions.add(sessionId);
    }
  }

  unregisterSpawnedSession(clientId: string, sessionId: string): void {
    const daemon = this.daemons.get(clientId);
    if (daemon) {
      daemon.activeSpawnedSessions.delete(sessionId);
    }
  }
}

export const daemonConnections = new DaemonConnectionManager();
```

### 6. Server WebSocket Handler for Daemons

Add WebSocket endpoint for daemon connections.

**File:** `src/server.ts` (modify existing WebSocket handling)

```typescript
import { daemonConnections } from "./lib/daemon-connections";
import type { DaemonToServerMessage } from "./types/daemon-ws";

// In the websocket configuration, add handling for daemon connections:

websocket: {
  open(ws) {
    const data = ws.data as { type: string; sessionId?: string; clientId?: string };

    if (data.type === "daemon") {
      // Daemon connections are fully handled in the message handler
      // after receiving daemon_connected message
      console.log("[ws] Daemon WebSocket opened, awaiting daemon_connected");
      return;
    }

    // Existing session subscription logic...
    if (data.type === "session" && data.sessionId) {
      wsManager.addConnection(data.sessionId, ws);
      // ... existing code
    }
  },

  message(ws, message) {
    const data = ws.data as { type: string; sessionId?: string; clientId?: string };

    try {
      const parsed = JSON.parse(message as string);

      // Handle daemon messages
      if (data.type === "daemon") {
        handleDaemonMessage(ws, parsed as DaemonToServerMessage);
        return;
      }

      // Existing session message handling...
      if (data.type === "session" && data.sessionId) {
        // ... existing code for subscribe, ping, user_message
      }
    } catch (error) {
      console.error("[ws] Failed to parse message:", error);
    }
  },

  close(ws) {
    const data = ws.data as { type: string; sessionId?: string; clientId?: string };

    if (data.type === "daemon" && data.clientId) {
      daemonConnections.removeDaemon(data.clientId);
      return;
    }

    // Existing session close logic...
    if (data.type === "session" && data.sessionId) {
      wsManager.removeConnection(data.sessionId, ws);
    }
  },
},

// Add this function:
function handleDaemonMessage(
  ws: ServerWebSocket<{ type: string; clientId?: string }>,
  message: DaemonToServerMessage
): void {
  switch (message.type) {
    case "daemon_connected": {
      // Store the clientId in ws.data for later reference
      (ws.data as any).clientId = message.client_id;

      daemonConnections.addDaemon(message.client_id, ws as any, message.capabilities);
      break;
    }

    case "session_output": {
      // Will be implemented in Phase 3 - relay to browser WebSocket
      console.log(`[daemon-msg] session_output for ${message.session_id}`);
      break;
    }

    case "session_ended": {
      // Will be implemented in Phase 3
      console.log(`[daemon-msg] session_ended for ${message.session_id}`);
      break;
    }

    case "permission_prompt": {
      // Will be implemented in Phase 6
      console.log(`[daemon-msg] permission_prompt for ${message.session_id}`);
      break;
    }

    case "question_prompt": {
      // Will be implemented in Phase 6
      console.log(`[daemon-msg] question_prompt for ${message.session_id}`);
      break;
    }

    default:
      console.warn("[daemon-msg] Unknown message type:", (message as any).type);
  }
}
```

### 7. WebSocket Upgrade for Daemon Connections

Handle the WebSocket upgrade request for `/api/daemon/ws`.

**File:** `src/server.ts` (modify fetch handler)

```typescript
fetch(req, server) {
  const url = new URL(req.url);

  // Daemon WebSocket upgrade
  if (url.pathname === "/api/daemon/ws" && req.headers.get("upgrade") === "websocket") {
    // Optionally validate client ID from header or query param
    const clientIdHeader = req.headers.get("X-Openctl-Client-ID");

    const success = server.upgrade(req, {
      data: {
        type: "daemon",
        clientId: clientIdHeader, // May be undefined initially, set on daemon_connected
      },
    });

    if (success) {
      return undefined;
    }
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Existing session WebSocket upgrade...
  const sessionWsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/ws$/);
  if (sessionWsMatch && req.headers.get("upgrade") === "websocket") {
    // ... existing code
  }

  // ... rest of fetch handler
}
```

### 8. Daemon Status API Endpoint

Add REST endpoint to check daemon connection status.

**File:** `src/routes/api.ts` (add to existing)

```typescript
// GET /api/daemon/status
getDaemonStatus(): Response {
  const status = daemonConnections.getStatus();
  return json(status);
}

// Optional: GET /api/daemon/list (for multi-daemon scenarios)
listConnectedDaemons(): Response {
  const daemons = daemonConnections.getAllConnected().map(d => ({
    client_id: d.clientId,
    connected_at: d.connectedAt.toISOString(),
    capabilities: d.capabilities,
    active_sessions: d.activeSpawnedSessions.size,
  }));

  return json({ daemons });
}
```

**File:** `src/server.ts` (register routes)

```typescript
routes: {
  // ... existing routes

  "/api/daemon/status": {
    GET: () => api.getDaemonStatus(),
  },

  "/api/daemon/list": {
    GET: () => api.listConnectedDaemons(),
  },
}
```

### 9. Update Daemon Startup

Ensure daemon connects via WebSocket when it starts.

**File:** `cli/daemon.ts` (integrate into existing startup)

```typescript
// In the daemon's main startup function:

export async function startDaemon(options: DaemonOptions): Promise<void> {
  const config = await loadConfig();

  // ... existing daemon initialization

  // Initialize WebSocket connection to server
  if (config.serverUrl) {
    initWebSocket(config.serverUrl, config.clientId);
  }

  // ... rest of daemon startup
}

// In daemon shutdown:
export async function stopDaemon(): Promise<void> {
  // Disconnect WebSocket
  daemonWs?.disconnect();

  // ... existing shutdown logic
}
```

## Testing

### Unit Tests

**File:** `tests/daemon-ws.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { daemonConnections } from "../src/lib/daemon-connections";

describe("DaemonConnectionManager", () => {
  beforeEach(() => {
    // Clear connections between tests
  });

  test("tracks daemon connection", () => {
    const mockWs = { send: () => {}, close: () => {} } as any;

    daemonConnections.addDaemon("client-123", mockWs, {
      can_spawn_sessions: true,
      spawnable_harnesses: [{
        id: "claude-code",
        name: "Claude Code",
        available: true,
        supports_permission_relay: true,
        supports_streaming: true,
      }],
    });

    const status = daemonConnections.getStatus();
    expect(status.connected).toBe(true);
    expect(status.client_id).toBe("client-123");
  });

  test("returns disconnected status when no daemon", () => {
    const status = daemonConnections.getStatus();
    expect(status.connected).toBe(false);
    expect(status.client_id).toBeUndefined();
  });

  test("replaces existing connection with same clientId", () => {
    let ws1Closed = false;
    const mockWs1 = { send: () => {}, close: () => { ws1Closed = true; } } as any;
    const mockWs2 = { send: () => {}, close: () => {} } as any;

    daemonConnections.addDaemon("client-123", mockWs1, { can_spawn_sessions: true, spawnable_harnesses: [] });
    daemonConnections.addDaemon("client-123", mockWs2, { can_spawn_sessions: true, spawnable_harnesses: [] });

    expect(ws1Closed).toBe(true);
    expect(daemonConnections.getAllConnected().length).toBe(1);
  });
});
```

### Integration Tests

**File:** `tests/daemon-ws-integration.test.ts`

```typescript
import { describe, test, expect } from "bun:test";

describe("Daemon WebSocket Integration", () => {
  test("daemon connects and server tracks connection", async () => {
    // Start test server
    // Connect daemon WebSocket
    // Send daemon_connected message
    // Verify /api/daemon/status returns connected

    const statusRes = await fetch("http://localhost:3000/api/daemon/status");
    const status = await statusRes.json();

    // After daemon connects:
    expect(status.connected).toBe(true);
  });

  test("server detects daemon disconnect", async () => {
    // Connect daemon
    // Close WebSocket
    // Verify /api/daemon/status returns disconnected
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `cli/types/daemon-ws.ts` | Create | Daemon↔Server message type definitions |
| `src/types/daemon-ws.ts` | Create | Server-side copy of message types |
| `cli/lib/daemon-ws.ts` | Create | Daemon WebSocket connection manager |
| `cli/daemon.ts` | Modify | Integrate WebSocket connection |
| `src/lib/daemon-connections.ts` | Create | Server-side daemon connection tracking |
| `src/routes/api.ts` | Modify | Add daemon status endpoint |
| `src/server.ts` | Modify | Add daemon WebSocket handling and routes |
| `tests/daemon-ws.test.ts` | Create | Unit tests |
| `tests/daemon-ws-integration.test.ts` | Create | Integration tests |

## Acceptance Criteria

- [ ] Daemon establishes WebSocket connection to server on startup
- [ ] Daemon sends `daemon_connected` with capabilities on connect
- [ ] Server tracks connected daemons by client ID
- [ ] `GET /api/daemon/status` returns correct connection status
- [ ] Daemon reconnects automatically on disconnect (exponential backoff)
- [ ] Server handles daemon disconnect gracefully
- [ ] Daemon sends periodic heartbeat pings
- [ ] Multiple daemons can connect (tracked by client ID)
- [ ] All tests pass
