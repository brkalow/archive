/**
 * Daemon WebSocket Connection Manager
 *
 * Manages the WebSocket connection from the daemon to the server,
 * including automatic reconnection with exponential backoff and heartbeat.
 */

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
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

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
      const wsUrl =
        this.options.serverUrl.replace(/^http/, "ws").replace(/\/$/, "") +
        "/api/daemon/ws";

      this.ws = new WebSocket(wsUrl, {
        headers: {
          "X-Openctl-Client-ID": this.options.clientId,
        },
      } as WebSocketInit);

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
          const message = JSON.parse(
            event.data as string
          ) as ServerToDaemonMessage;
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
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      30000
    );

    console.log(
      `[daemon-ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

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
      console.error("[daemon-ws] Cannot send, WebSocket not open (state: " + this.ws?.readyState + ")");
      return;
    }

    // Log session_output messages for debugging
    if (message.type === "session_output") {
      console.log(`[daemon-ws] Sending session_output for ${message.session_id} (${message.messages.length} messages)`);
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

// Add type for WebSocket init options (Bun extension)
interface WebSocketInit {
  headers?: Record<string, string>;
}
