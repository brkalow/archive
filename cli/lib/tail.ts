import { watch } from "fs";
import { debug } from "./debug";

export class Tail extends EventTarget {
  private filePath: string;
  private position: number = 0;
  private watcher: ReturnType<typeof watch> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private buffer: string = "";
  private pollIntervalMs: number;

  constructor(filePath: string, options: { startFromEnd?: boolean; pollIntervalMs?: number } = {}) {
    super();
    this.filePath = filePath;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000; // Default 2 second polling fallback

    if (options.startFromEnd) {
      // Synchronously get size - use Bun.spawnSync or check if file exists
      try {
        const stat = require("fs").statSync(filePath);
        this.position = stat.size;
      } catch {
        this.position = 0;
      }
    }
  }

  start(): void {
    debug(`Tail starting from position ${this.position}`);
    this.readNewContent();

    // Watch for file changes (primary mechanism)
    this.watcher = watch(this.filePath, (eventType) => {
      if (eventType === "change") {
        this.readNewContent();
      }
    });

    // Polling fallback - fs.watch() can miss events on macOS
    this.pollInterval = setInterval(() => {
      this.readNewContent();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async readNewContent(): Promise<void> {
    try {
      const file = Bun.file(this.filePath);
      const size = file.size;

      if (size < this.position) {
        // File was truncated
        this.position = 0;
        this.buffer = "";
      }

      if (size > this.position) {
        // Read new content using Bun's file API with slice
        const slice = file.slice(this.position, size);
        const content = await slice.text();
        const bytesRead = size - this.position;
        this.position = size;

        this.buffer += content;

        // Emit complete lines
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        debug(`Read ${bytesRead} bytes, ${lines.length} complete lines`);

        for (const line of lines) {
          if (line.trim()) {
            this.dispatchEvent(new CustomEvent("line", { detail: line }));
          }
        }
      }
    } catch (err) {
      this.dispatchEvent(new CustomEvent("error", { detail: err }));
    }
  }

  getPosition(): number {
    return this.position;
  }
}
