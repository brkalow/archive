/**
 * SSE Connection Manager for OpenCode compatibility.
 *
 * Manages SSE connections for both /event (bare format) and /global/event
 * (envelope format). Internal to the OpenCode API module.
 *
 * Key behaviors:
 * - Keepalive comments every 30 seconds
 * - 1000-event ring buffer for Last-Event-ID replay on reconnect
 * - Sequential integer event IDs
 * - CORS headers on all responses
 */

import type { OCEvent, OCGlobalEvent } from "../../src/lib/opencode/types";

interface SSEConnection {
  controller: ReadableStreamDefaultController;
  format: "bare" | "global";
  directory: string;
}

interface BufferedEvent {
  id: number;
  event: OCEvent;
}

const KEEPALIVE_INTERVAL_MS = 30_000;
const EVENT_BUFFER_SIZE = 1000;

export class OpenCodeSSEManager {
  private connections: Set<SSEConnection> = new Set();
  private eventBuffer: BufferedEvent[] = [];
  private nextEventId = 1;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.startKeepalive();
  }

  /**
   * Create a new SSE response for a connection.
   * Sends server.connected event immediately, then replays missed events.
   */
  connect(
    format: "bare" | "global",
    lastEventId?: string,
    directory?: string
  ): Response {
    const dir = directory || this.directory;

    const stream = new ReadableStream({
      start: (controller) => {
        const conn: SSEConnection = { controller, format, directory: dir };
        this.connections.add(conn);

        // Send initial server.connected event
        const connectedEvent: OCEvent = {
          type: "server.connected",
          properties: {},
        };
        this.sendToConnection(conn, connectedEvent, 0);

        // Replay missed events if Last-Event-ID provided
        if (lastEventId) {
          const fromId = parseInt(lastEventId, 10);
          if (!isNaN(fromId)) {
            for (const buffered of this.eventBuffer) {
              if (buffered.id > fromId) {
                this.sendToConnection(conn, buffered.event, buffered.id);
              }
            }
          }
        }
      },
      cancel: () => {
        // Find and remove this connection
        for (const conn of this.connections) {
          if (conn.controller) {
            try {
              // Check if this is the one being cancelled
              this.connections.delete(conn);
              break;
            } catch {
              // Already closed
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      },
    });
  }

  /**
   * Broadcast an event to all connected SSE clients.
   */
  broadcast(event: OCEvent): void {
    const eventId = this.nextEventId++;

    // Buffer the event
    this.eventBuffer.push({ id: eventId, event });
    if (this.eventBuffer.length > EVENT_BUFFER_SIZE) {
      this.eventBuffer.shift();
    }

    // Send to all connections
    const deadConnections: SSEConnection[] = [];
    for (const conn of this.connections) {
      try {
        this.sendToConnection(conn, event, eventId);
      } catch {
        deadConnections.push(conn);
      }
    }

    // Clean up dead connections
    for (const conn of deadConnections) {
      this.connections.delete(conn);
    }
  }

  private sendToConnection(
    conn: SSEConnection,
    event: OCEvent,
    eventId: number
  ): void {
    let data: string;

    if (conn.format === "bare") {
      // /event: bare format { type, properties }
      data = JSON.stringify(event);
    } else {
      // /global/event: envelope format { directory, payload: { type, properties } }
      // Initial server.connected has no directory field
      if (event.type === "server.connected") {
        const envelope: Partial<OCGlobalEvent> = {
          payload: event,
        };
        data = JSON.stringify(envelope);
      } else {
        const envelope: OCGlobalEvent = {
          directory: conn.directory,
          payload: event,
        };
        data = JSON.stringify(envelope);
      }
    }

    const encoder = new TextEncoder();
    const message = `id: ${eventId}\ndata: ${data}\n\n`;
    conn.controller.enqueue(encoder.encode(message));
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      const encoder = new TextEncoder();
      const comment = encoder.encode(":keepalive\n\n");

      const deadConnections: SSEConnection[] = [];
      for (const conn of this.connections) {
        try {
          conn.controller.enqueue(comment);
        } catch {
          deadConnections.push(conn);
        }
      }

      for (const conn of deadConnections) {
        this.connections.delete(conn);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  close(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    const encoder = new TextEncoder();
    for (const conn of this.connections) {
      try {
        conn.controller.enqueue(encoder.encode("event: close\ndata: {}\n\n"));
        conn.controller.close();
      } catch {
        // Already closed
      }
    }
    this.connections.clear();
    this.eventBuffer = [];
  }
}
