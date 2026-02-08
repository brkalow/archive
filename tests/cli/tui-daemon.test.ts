/**
 * Daemon-backed PTY TUI Integration Test
 *
 * Spawns the real OpenCode TUI in a pseudo-terminal against the real
 * SpawnedSessionManager + DaemonBackend + OpenCodeAPI stack, which
 * spawns actual Claude Code processes.
 *
 * Requires:
 * - `claude` CLI in PATH with a valid API key
 * - `opencode` binary available
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createOpenCodeAPI, type OpenCodeAPI } from "../../cli/lib/opencode-api";
import { DaemonBackend } from "../../cli/lib/opencode-backend";
import { SpawnedSessionManager } from "../../cli/lib/spawned-session-manager";
import type { DaemonToServerMessage } from "../../cli/types/daemon-ws";
import { resolve } from "path";

// ============================================
// ANSI Stripping (same as tui-pty.test.ts)
// ============================================

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "") // CSI sequences (full range)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, "") // charset sequences
    .replace(/\x1b[#%][A-Z0-9]/g, "") // other ESC sequences
    .replace(/\x1b[=>Nc]/g, "") // simple ESC commands
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // control chars (keep \n, \r)
}

// ============================================
// Minimal VT Screen Buffer
// ============================================

/**
 * Replays raw terminal output through a virtual screen buffer to get
 * the actual visible screen state. Handles cursor positioning, erase,
 * scroll regions, and basic text output — enough for TUI screen assertions.
 */
function renderScreen(raw: string, cols: number, rows: number): string {
  const buf = new Array(rows * cols).fill(" ");
  let r = 0,
    c = 0;
  // Scroll region (1-indexed inclusive bounds, default = full screen)
  let scrollTop = 0,
    scrollBot = rows - 1;
  let i = 0;

  /** Scroll the region [scrollTop..scrollBot] up by one line. */
  function scrollUp() {
    for (let row = scrollTop; row < scrollBot; row++) {
      for (let col = 0; col < cols; col++) {
        buf[row * cols + col] = buf[(row + 1) * cols + col];
      }
    }
    // Clear bottom line of scroll region
    for (let col = 0; col < cols; col++) {
      buf[scrollBot * cols + col] = " ";
    }
  }

  /** Scroll the region [scrollTop..scrollBot] down by one line. */
  function scrollDown() {
    for (let row = scrollBot; row > scrollTop; row--) {
      for (let col = 0; col < cols; col++) {
        buf[row * cols + col] = buf[(row - 1) * cols + col];
      }
    }
    // Clear top line of scroll region
    for (let col = 0; col < cols; col++) {
      buf[scrollTop * cols + col] = " ";
    }
  }

  /** Move cursor down; scroll if at bottom of scroll region. */
  function linefeed() {
    if (r === scrollBot) {
      scrollUp();
    } else {
      r = Math.min(rows - 1, r + 1);
    }
  }

  while (i < raw.length) {
    const ch = raw.charCodeAt(i);

    // ESC sequence
    if (ch === 0x1b) {
      if (i + 1 >= raw.length) {
        i++;
        continue;
      }
      const next = raw[i + 1];

      if (next === "[") {
        // CSI: collect parameter bytes (0x20-0x3f), then final byte (0x40-0x7e)
        let j = i + 2;
        while (
          j < raw.length &&
          raw.charCodeAt(j) >= 0x20 &&
          raw.charCodeAt(j) <= 0x3f
        )
          j++;
        if (j >= raw.length) {
          i = j;
          continue;
        }
        const params = raw.slice(i + 2, j);
        const final = raw[j];
        // Handle DEC private modes (CSI ? ... h/l) before stripping '?'
        const isDECPrivate = params.startsWith("?");

        // Strip leading '?' for DEC private mode params
        const cleanParams = params.replace(/^\?/, "");
        const nums = cleanParams
          .split(";")
          .map((s) => parseInt(s) || 0);

        // Alternate screen buffer: clear buffer on enter
        if (isDECPrivate && final === "h") {
          const mode = nums[0];
          if (mode === 1049 || mode === 47 || mode === 1047) {
            buf.fill(" ");
            r = 0;
            c = 0;
            scrollTop = 0;
            scrollBot = rows - 1;
          }
          i = j + 1;
          continue;
        }

        switch (final) {
          case "H":
          case "f": // Cursor position
            r = Math.min(rows - 1, Math.max(0, (nums[0] || 1) - 1));
            c = Math.min(cols - 1, Math.max(0, (nums[1] || 1) - 1));
            break;
          case "A":
            r = Math.max(0, r - (nums[0] || 1));
            break; // Up
          case "B":
            r = Math.min(rows - 1, r + (nums[0] || 1));
            break; // Down
          case "C":
            c = Math.min(cols - 1, c + (nums[0] || 1));
            break; // Forward
          case "D":
            c = Math.max(0, c - (nums[0] || 1));
            break; // Back
          case "G":
            c = Math.min(cols - 1, Math.max(0, (nums[0] || 1) - 1));
            break; // Column
          case "d":
            r = Math.min(rows - 1, Math.max(0, (nums[0] || 1) - 1));
            break; // Row (VPA)
          case "J": {
            // Erase in display
            const mode = nums[0] || 0;
            if (mode === 2 || mode === 3) {
              buf.fill(" ");
            } else if (mode === 0) {
              for (let k = r * cols + c; k < rows * cols; k++) buf[k] = " ";
            } else if (mode === 1) {
              for (let k = 0; k <= r * cols + c; k++) buf[k] = " ";
            }
            break;
          }
          case "K": {
            // Erase in line
            const mode = nums[0] || 0;
            const ls = r * cols;
            if (mode === 0) {
              for (let k = c; k < cols; k++) buf[ls + k] = " ";
            } else if (mode === 1) {
              for (let k = 0; k <= c; k++) buf[ls + k] = " ";
            } else if (mode === 2) {
              for (let k = 0; k < cols; k++) buf[ls + k] = " ";
            }
            break;
          }
          case "r": {
            // Set scroll region (DECSTBM)
            // CSI Pt ; Pb r — top and bottom rows (1-indexed)
            if (!params.startsWith("?")) {
              scrollTop = Math.max(0, (nums[0] || 1) - 1);
              scrollBot = Math.min(rows - 1, (nums[1] || rows) - 1);
              // Cursor moves to home after setting scroll region
              r = 0;
              c = 0;
            }
            break;
          }
          case "S": {
            // Scroll up N lines
            const n = nums[0] || 1;
            for (let k = 0; k < n; k++) scrollUp();
            break;
          }
          case "T": {
            // Scroll down N lines
            if (!params.startsWith(">")) {
              const n = nums[0] || 1;
              for (let k = 0; k < n; k++) scrollDown();
            }
            break;
          }
          case "L": {
            // Insert N lines at cursor (within scroll region)
            const n = Math.min(nums[0] || 1, scrollBot - r + 1);
            for (let k = 0; k < n; k++) {
              // Shift lines down from cursor to bottom of scroll region
              for (let row = scrollBot; row > r; row--) {
                for (let col = 0; col < cols; col++) {
                  buf[row * cols + col] = buf[(row - 1) * cols + col];
                }
              }
              // Clear the line at cursor
              for (let col = 0; col < cols; col++) {
                buf[r * cols + col] = " ";
              }
            }
            break;
          }
          case "M": {
            // Delete N lines at cursor (within scroll region)
            if (!params.startsWith("?")) {
              const n = Math.min(nums[0] || 1, scrollBot - r + 1);
              for (let k = 0; k < n; k++) {
                // Shift lines up from cursor to bottom of scroll region
                for (let row = r; row < scrollBot; row++) {
                  for (let col = 0; col < cols; col++) {
                    buf[row * cols + col] = buf[(row + 1) * cols + col];
                  }
                }
                // Clear the bottom line of scroll region
                for (let col = 0; col < cols; col++) {
                  buf[scrollBot * cols + col] = " ";
                }
              }
            }
            break;
          }
          // Ignore all other CSI sequences (colors, modes, etc.)
        }
        i = j + 1;
        continue;
      } else if (next === "]") {
        // OSC — skip until BEL or ST
        let j = i + 2;
        while (j < raw.length) {
          if (raw.charCodeAt(j) === 0x07) {
            j++;
            break;
          }
          if (raw[j] === "\x1b" && j + 1 < raw.length && raw[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      } else if (next === "D") {
        // Index (IND) — move cursor down, scroll if at bottom of region
        linefeed();
        i += 2;
        continue;
      } else if (next === "M") {
        // Reverse Index (RI) — move cursor up, scroll down if at top of region
        if (r === scrollTop) {
          scrollDown();
        } else {
          r = Math.max(0, r - 1);
        }
        i += 2;
        continue;
      } else if ("()".includes(next)) {
        i += 3;
        continue; // Charset designation
      } else {
        i += 2;
        continue; // Other ESC sequences
      }
    }

    // CR
    if (ch === 0x0d) {
      c = 0;
      i++;
      continue;
    }

    // LF — move down, scroll if at bottom of scroll region
    if (ch === 0x0a) {
      linefeed();
      i++;
      continue;
    }

    // Skip other control characters
    if (ch < 0x20 || ch === 0x7f) {
      i++;
      continue;
    }

    // Regular character — write to buffer
    if (r < rows && c < cols) {
      buf[r * cols + c] = raw[i];
      c++;
      if (c >= cols) {
        c = 0;
        linefeed();
      }
    }
    i++;
  }

  // Join rows into lines
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    lines.push(buf.slice(row * cols, (row + 1) * cols).join(""));
  }
  return lines.join("\n");
}

// ============================================
// Test Suite
// ============================================

describe("OpenCode TUI PTY Integration (Daemon)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let api: OpenCodeAPI;
  let backend: DaemonBackend;
  let sessionManager: SpawnedSessionManager;
  let proc: ReturnType<typeof Bun.spawn>;
  let output: string;

  const cwd = resolve(import.meta.dir, "../..");

  /**
   * Wait for a string or regex pattern to appear in terminal output.
   */
  async function waitFor(
    pattern: string | RegExp,
    timeoutMs = 30_000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const stripped = stripAnsi(output);
      if (typeof pattern === "string") {
        if (stripped.includes(pattern)) return;
      } else {
        if (pattern.test(stripped)) return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const stripped = stripAnsi(output);
    throw new Error(
      `Timed out waiting for ${pattern} after ${timeoutMs}ms.\n\n--- Terminal output (last 3000 chars) ---\n${stripped.slice(-3000)}`
    );
  }

  /**
   * Wait for a predicate to become true.
   */
  async function waitForCondition(
    predicate: () => boolean,
    timeoutMs: number,
    description: string
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    const stripped = stripAnsi(output);
    throw new Error(
      `Timed out waiting for ${description} after ${timeoutMs}ms.\n\n--- Terminal output (last 3000 chars) ---\n${stripped.slice(-3000)}`
    );
  }

  /**
   * Get the full stripped terminal output.
   */
  function getScreen(): string {
    return stripAnsi(output);
  }

  /**
   * Get the actual current visible screen by replaying raw terminal
   * output through a VT screen buffer. This correctly handles cursor
   * positioning and erase commands, so transient content (like QUEUED)
   * that was overwritten by later redraws won't appear.
   */
  function getVisibleScreen(): string {
    return renderScreen(output, 120, 40);
  }

  /**
   * Count completed turn headers in the accumulated output.
   * Uses "▣  Code" pattern (case-insensitive) to avoid false positives
   * from spinner animations that also use the ▣ character.
   */
  function countCompletionMarkers(): number {
    return (getScreen().match(/▣ +code/gi) || []).length;
  }

  /**
   * Count completed turn headers on the visible screen (VT buffer).
   */
  function countVisibleCompletionMarkers(): number {
    return (getVisibleScreen().match(/▣ +code/gi) || []).length;
  }

  beforeAll(() => {
    let sendToServer: (msg: DaemonToServerMessage) => void;

    sessionManager = new SpawnedSessionManager((msg) => {
      sendToServer(msg);
    });

    // Override startSession to always use permission_mode: "auto"
    // (maps to --dangerously-skip-permissions) so no permission prompts block the test
    const realStartSession = sessionManager.startSession.bind(sessionManager);
    sessionManager.startSession = async (request) => {
      return realStartSession({ ...request, permission_mode: "auto" });
    };

    backend = new DaemonBackend(sessionManager, cwd);
    api = createOpenCodeAPI(backend, { directory: cwd });
    backend.setBroadcast(api.broadcast);
    sendToServer = (msg) => backend.handleDaemonMessage(msg);

    server = Bun.serve({
      port: 0,
      idleTimeout: 255,
      async fetch(req) {
        const response = await api.handleRequest(req);
        if (response) return response;
        return new Response("Not found", { status: 404 });
      },
    });

    // Spawn the real TUI in a PTY
    output = "";
    proc = Bun.spawn(
      ["opencode", "attach", `http://localhost:${server.port}`],
      {
        terminal: {
          cols: 120,
          rows: 40,
          data(_terminal, data) {
            output += new TextDecoder().decode(data);
          },
        },
        env: {
          ...process.env,
          TERM: "xterm-256color",
          NO_COLOR: undefined,
        },
      }
    );
  });

  afterAll(async () => {
    proc?.kill();

    // End all active sessions
    for (const session of sessionManager.getActiveSessions()) {
      await sessionManager.endSession(session.id);
    }

    api?.close();
    server?.stop();
  });

  test("TUI boots and shows input prompt", async () => {
    await waitFor(/ask anything/i, 30_000);
    // Wait for the model to be loaded (shown in status bar)
    // Without this, submit() silently fails because selectedModel is null
    await waitFor(/Claude Sonnet/i, 30_000);
    const screen = getScreen();
    expect(screen.toLowerCase()).toContain("ask anything");
  }, 35_000);

  test("first message completes", async () => {
    // Extra settle time — the TUI's async config loading must complete
    // before submit() will work
    await new Promise((r) => setTimeout(r, 2000));

    // Type a simple, fast-to-answer message
    proc.terminal!.write("Say hello in exactly 3 words");
    await new Promise((r) => setTimeout(r, 200));
    proc.terminal!.write("\r");

    // Wait for the turn-complete header — real Claude responses take 10-30+ seconds.
    // Match the full pattern "▣  Code" (case-insensitive) to avoid false hits on
    // the spinner animation which also uses ▣.
    await waitFor(/▣ +code/i, 120_000);

    // Allow screen to fully render after completion
    await new Promise((r) => setTimeout(r, 1000));

    // Turn-complete header appeared
    expect(countCompletionMarkers()).toBeGreaterThanOrEqual(1);

    // Exactly 1 completion marker should be visible — no duplicate responses
    expect(countVisibleCompletionMarkers()).toBe(1);

    // QUEUED should not be visible on the current screen after completion.
    // (It appears transiently before the response streams in, but the TUI
    // should redraw it away once the turn completes.)
    const visible = getVisibleScreen();
    expect(visible.toUpperCase()).not.toContain("QUEUED");

    // Some assistant response text should have appeared
    // (non-deterministic, so just verify meaningful content exists)
    expect(output.length).toBeGreaterThan(500);
  }, 130_000);

  test("multi-turn: second message also completes", async () => {
    // Wait for input to be ready
    await new Promise((r) => setTimeout(r, 2000));

    // Count existing completion markers before sending the follow-up
    const markersBefore = countCompletionMarkers();

    // Type a follow-up message
    proc.terminal!.write("Now say goodbye in exactly 3 words");
    await new Promise((r) => setTimeout(r, 200));
    proc.terminal!.write("\r");

    // Wait for a NEW completion marker (not just the one from the first turn)
    await waitForCondition(
      () => countCompletionMarkers() > markersBefore,
      120_000,
      "second completion marker (▣)"
    );

    // Allow render
    await new Promise((r) => setTimeout(r, 1000));

    // Verify a new completion marker appeared (turn completed)
    expect(countCompletionMarkers()).toBeGreaterThan(markersBefore);

    // Exactly 2 completion markers should be visible — no duplicate responses
    expect(countVisibleCompletionMarkers()).toBe(2);

    // QUEUED should not be visible on the current screen
    const visible = getVisibleScreen();
    expect(visible.toUpperCase()).not.toContain("QUEUED");
  }, 130_000);
});
