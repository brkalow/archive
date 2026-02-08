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

import type { OCEvent } from "../../src/lib/opencode/types";

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
  private encoder = new TextEncoder();

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
    let conn: SSEConnection;

    const stream = new ReadableStream({
      start: (controller) => {
        conn = { controller, format, directory: dir };
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
        this.connections.delete(conn);
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

    this.eventBuffer.push({ id: eventId, event });
    if (this.eventBuffer.length > EVENT_BUFFER_SIZE) {
      this.eventBuffer.shift();
    }

    this.forEachConnection((conn) =>
      this.sendToConnection(conn, event, eventId)
    );
  }

  private sendToConnection(
    conn: SSEConnection,
    event: OCEvent,
    eventId: number
  ): void {
    const data =
      conn.format === "bare"
        ? JSON.stringify(event)
        : JSON.stringify({
            ...(event.type !== "server.connected" && {
              directory: conn.directory,
            }),
            payload: event,
          });

    conn.controller.enqueue(
      this.encoder.encode(`id: ${eventId}\ndata: ${data}\n\n`)
    );
  }

  private startKeepalive(): void {
    const comment = this.encoder.encode(":keepalive\n\n");
    this.keepaliveTimer = setInterval(() => {
      this.forEachConnection((conn) => conn.controller.enqueue(comment));
    }, KEEPALIVE_INTERVAL_MS);
  }

  /**
   * Run a callback for each connection, removing any that throw.
   */
  private forEachConnection(fn: (conn: SSEConnection) => void): void {
    const dead: SSEConnection[] = [];
    for (const conn of this.connections) {
      try {
        fn(conn);
      } catch {
        dead.push(conn);
      }
    }
    for (const conn of dead) {
      this.connections.delete(conn);
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  close(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    const closeMsg = this.encoder.encode("event: close\ndata: {}\n\n");
    for (const conn of this.connections) {
      try {
        conn.controller.enqueue(closeMsg);
        conn.controller.close();
      } catch {
        // Already closed
      }
    }
    this.connections.clear();
    this.eventBuffer = [];
  }
}
