# Browser-Initiated Sessions

This document specifies the architecture for starting new Claude Code sessions from the browser when a connected daemon is available, using Claude Code's non-interactive (headless) mode.

**Depends on:** [live_streaming.md](./live_streaming.md)

## Overview

When a daemon is running and connected to the server, users can start new Claude Code sessions directly from the browser. The session runs headlessly via Claude Code's stream-JSON mode, with the browser serving as the primary interface for viewing output and providing input.

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     Browser     │       │     Server      │       │     Daemon      │
│                 │  ws   │                 │  ws   │                 │
│  User types     │──────►│  Relay input    │──────►│  Spawn Claude   │
│  prompt         │       │                 │       │  --stream-json  │
│                 │       │                 │       │       │         │
│  See output     │◄──────│  Broadcast      │◄──────│  stdout JSON    │
│  real-time      │       │  messages       │       │                 │
│                 │       │                 │       │                 │
│  Send follow-up │──────►│  Relay to       │──────►│  stdin JSON     │
│                 │       │  daemon         │       │                 │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

**Key differences from daemon mode:**

| Aspect | Daemon Mode (current) | Browser-Initiated (this spec) |
|--------|----------------------|-------------------------------|
| Who starts session | User runs `claude` locally | User clicks in browser |
| Local terminal | User sees TUI | No local terminal |
| How it works | Tail JSONL files | Spawn with `--stream-json` |
| Input method | Local keyboard | Browser only |
| Collaboration | Plugin injects feedback during idle | All input via browser |
| Use case | Passive streaming + local control | Fully remote sessions |

## Why Non-Interactive Mode?

When a user wants to start a session from the browser, there's no local terminal to display the TUI. Non-interactive/headless mode provides:

1. **Structured I/O**: JSON messages on stdin/stdout enable clean programmatic interaction
2. **No TUI dependencies**: Doesn't require a PTY or terminal emulator
3. **Full capability**: All tools and features work in non-interactive mode
4. **Streaming output**: Real-time message streaming to the browser

---

## Multi-Harness Support

While this spec uses Claude Code as the primary example, the architecture should support other coding agents (Aider, Cursor agent mode, etc.) that can run headlessly.

### Spawnable Harness Interface

Extend the existing `HarnessAdapter` interface with spawning capabilities:

```typescript
interface SpawnableHarness extends HarnessAdapter {
  /** Whether this harness supports headless/non-interactive mode */
  canSpawn(): boolean;

  /** Build the command to spawn a headless session */
  buildSpawnCommand(options: SpawnOptions): SpawnCommand;

  /** Parse output from the spawned process */
  parseOutput(line: string): HarnessMessage | null;

  /** Format user input for stdin */
  formatInput(content: string): string;

  /** Format tool result for stdin (if supported) */
  formatToolResult?(toolUseId: string, result: string): string;

  /** Check if a message is a permission request */
  isPermissionRequest?(msg: HarnessMessage): PermissionRequest | null;

  /** Format permission response for stdin */
  formatPermissionResponse?(requestId: string, allow: boolean): string;
}

interface SpawnOptions {
  prompt: string;
  cwd: string;
  model?: string;
  resumeSessionId?: string;
  permissionMode?: "stdio" | "auto" | "deny";
}

interface SpawnCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
```

### Harness Capabilities Matrix

| Harness | Headless Mode | Stdin Input | Permission Relay | Status |
|---------|--------------|-------------|------------------|--------|
| Claude Code | ✅ `--stream-json` | ✅ | ✅ `--permission-prompt-tool stdio` | Supported |
| Aider | ✅ `--no-pretty` | ✅ | ❌ (auto-approve only) | Planned |
| Cursor | ❓ Unknown | ❓ | ❓ | Research needed |
| Cline | ❓ Unknown | ❓ | ❓ | Research needed |

### Claude Code Implementation

```typescript
const claudeCodeSpawnable: SpawnableHarness = {
  ...claudeCodeAdapter,

  canSpawn(): boolean {
    return true;
  },

  buildSpawnCommand(options: SpawnOptions): SpawnCommand {
    const args = [
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    if (options.permissionMode === "stdio") {
      args.push("--permission-prompt-tool", "stdio");
    }

    return { command: "claude", args };
  },

  parseOutput(line: string): HarnessMessage | null {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  },

  formatInput(content: string): string {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content }
    }) + "\n";
  },

  // ... permission handling methods
};
```

### Aider Implementation (Example)

```typescript
const aiderSpawnable: SpawnableHarness = {
  ...aiderAdapter,

  canSpawn(): boolean {
    return true;
  },

  buildSpawnCommand(options: SpawnOptions): SpawnCommand {
    const args = [
      "--no-pretty",           // Disable TUI
      "--no-auto-commits",     // Don't auto-commit
      "--yes",                 // Auto-approve (no permission relay)
      "--message", options.prompt,
    ];

    if (options.model) {
      args.push("--model", options.model);
    }

    return { command: "aider", args };
  },

  parseOutput(line: string): HarnessMessage | null {
    // Aider outputs plain text, need to parse differently
    // Convert to normalized message format
    return parseAiderOutput(line);
  },

  formatInput(content: string): string {
    // Aider accepts plain text input
    return content + "\n";
  },
};
```

### Daemon SpawnedSessionManager Updates

The `SpawnedSessionManager` should use the harness interface:

```typescript
class SpawnedSessionManager {
  async startSession(request: StartSessionRequest): Promise<void> {
    const harness = getSpawnableHarness(request.harness || "claude-code");

    if (!harness.canSpawn()) {
      throw new Error(`Harness ${request.harness} does not support spawning`);
    }

    const spawnCmd = harness.buildSpawnCommand({
      prompt: request.prompt,
      cwd: request.cwd,
      model: request.model,
      permissionMode: "stdio",
    });

    const proc = Bun.spawn([spawnCmd.command, ...spawnCmd.args], {
      cwd: request.cwd,
      env: { ...process.env, ...spawnCmd.env },
      stdin: "pipe",
      stdout: "pipe",
    });

    // Use harness-specific parsing
    this.streamOutput(session, proc.stdout, harness);
  }

  async sendInput(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const harness = session.harness;

    // Use harness-specific input formatting
    const formatted = harness.formatInput(content);
    await this.writeToStdin(session, formatted);
  }
}
```

---

## Claude Code Stream-JSON Protocol

The following sections detail the Claude Code-specific implementation. Other harnesses will have their own protocols.

### Spawning a Session

```bash
claude -p "initial prompt" \
  --output-format stream-json \
  --input-format stream-json \
  --verbose
```

Flags:
- `-p` / `--print`: Run in non-interactive (print) mode
- `--output-format stream-json`: Emit JSONL output on stdout
- `--input-format stream-json`: Accept JSONL input on stdin
- `--verbose`: Include all message types in output

### Output Messages (stdout)

Each line is a complete JSON object (NDJSON format):

```jsonl
{"type":"system","subtype":"init","session_id":"abc123","cwd":"/Users/me/project"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll help you with that."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_001","name":"Read","input":{"file_path":"src/index.ts"}}]}}
{"type":"result","subtype":"success","duration_ms":1234,"session_id":"abc123"}
```

**Message types:**

| Type | Description |
|------|-------------|
| `system` | Initialization, session info, control messages |
| `assistant` | Claude's responses (text, tool_use blocks) |
| `user` | Echo of user input (with `--replay-user-messages`) |
| `result` | Session completion status |

**Content block types within assistant messages:**

| Block Type | Description |
|------------|-------------|
| `text` | Text response |
| `tool_use` | Tool invocation with id, name, input |
| `thinking` | Extended thinking content (if enabled) |

### Input Messages (stdin)

Send user messages as JSONL:

```jsonl
{"type":"user","message":{"role":"user","content":"Please also check the tests"}}
```

**Structure:**

```typescript
interface UserInputMessage {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
  session_id?: string;  // Optional, for session continuity
}
```

### Tool Results and Interactive Tools

Most tool results appear in the output stream automatically - Claude Code handles tool execution internally. However, **interactive tools** like `AskUserQuestion` require special handling since there's no local terminal.

#### AskUserQuestion Browser Relay

When Claude uses `AskUserQuestion` in a browser-initiated session, the daemon detects it and relays to the browser for user response:

```
Claude                  Daemon                  Server                 Browser
  │                        │                       │                      │
  │── tool_use ───────────►│                       │                      │
  │   AskUserQuestion      │                       │                      │
  │   {question, options}  │                       │                      │
  │                        │── question_prompt ───►│                      │
  │                        │   {tool_use_id,       │── question_prompt ──►│
  │                        │    question, options} │                      │
  │                        │                       │                      │
  │                        │                       │   [User sees modal]  │
  │                        │                       │   [User responds]    │
  │                        │                       │                      │
  │                        │◄── question_response ─│◄── question_response │
  │                        │   {tool_use_id,       │   {answer}           │
  │◄── tool_result ────────│    answer}            │                      │
  │                        │                       │                      │
  │   [continues]          │                       │                      │
```

**Daemon detection:**

```typescript
// In streamOutput(), detect AskUserQuestion tool calls
if (msg.type === "assistant" && msg.message?.content) {
  for (const block of msg.message.content) {
    if (block.type === "tool_use" && block.name === "AskUserQuestion") {
      // Relay to server for browser response
      this.sendToServer({
        type: "question_prompt",
        session_id: session.id,
        tool_use_id: block.id,
        question: block.input.question,
        options: block.input.options,
      });
      // Mark session as waiting for user response
      session.pendingToolUseId = block.id;
    }
  }
}
```

**Browser UI for questions:**

```
┌────────────────────────────────────────────────────────────────────┐
│  Claude is asking a question                                  [×]  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  "How would you like me to handle authentication?"                 │
│                                                                    │
│  ○ Use JWT tokens with refresh                                     │
│  ○ Use session-based auth with cookies                             │
│  ○ Use OAuth with third-party providers                            │
│                                                                    │
│  Or type a custom response:                                        │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                                                              │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│                                                          [Submit]  │
└────────────────────────────────────────────────────────────────────┘
```

**Server → Daemon response:**

```typescript
type ServerToDaemonMessage =
  // ... existing messages
  | {
      type: "question_response";
      session_id: string;
      tool_use_id: string;
      answer: string;
    };
```

**Daemon injects tool_result:**

```typescript
async handleQuestionResponse(msg: QuestionResponse): Promise<void> {
  const session = this.sessions.get(msg.session_id);
  if (!session || session.pendingToolUseId !== msg.tool_use_id) return;

  // Write tool_result to Claude's stdin
  const toolResult = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: msg.tool_use_id,
        content: msg.answer,
      }],
    },
  }) + "\n";

  await this.writeToStdin(session, toolResult);
  session.pendingToolUseId = undefined;
}
```

**Known limitation:** There's an [upstream issue (#16712)](https://github.com/anthropics/claude-code/issues/16712) where Claude Code may auto-inject a synthetic response when resuming sessions with pending tool calls. For browser-initiated sessions, we handle this by:
1. Not using `--resume` with pending tool calls
2. Injecting tool_result immediately before Claude auto-responds
3. If upstream is fixed, this becomes simpler

#### Permission Prompt Handling

Claude Code requests permission before dangerous operations (file writes, bash commands, etc.). In non-interactive mode, we can handle this via the `--permission-prompt-tool stdio` flag, which emits permission requests as JSON and accepts responses via stdin.

**Permission request flow:**

```
Claude                  Daemon                  Server                 Browser
  │                        │                       │                      │
  │── permission_request ─►│                       │                      │
  │   {tool: "Bash",       │                       │                      │
  │    command: "rm -rf"}  │                       │                      │
  │                        │── permission_prompt ─►│                      │
  │                        │                       │── permission_prompt ─►│
  │                        │                       │                      │
  │                        │                       │   [User sees modal]  │
  │                        │                       │   "Allow rm -rf?"    │
  │                        │                       │   [Allow] [Deny]     │
  │                        │                       │                      │
  │                        │◄─ permission_response │◄─ permission_response│
  │◄── allow/deny ─────────│   {allow: true}       │   {allow: true}      │
  │                        │                       │                      │
```

**Browser UI for permission prompts:**

```
┌────────────────────────────────────────────────────────────────────┐
│  ⚠️  Permission Required                                      [×]  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Claude wants to run a bash command:                               │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ rm -rf ./node_modules && npm install                         │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ☐ Remember this decision for this session                        │
│                                                                    │
│                                        [Deny]         [Allow]      │
└────────────────────────────────────────────────────────────────────┘
```

**Message types:**

```typescript
// Daemon → Server → Browser
interface PermissionPrompt {
  type: "permission_prompt";
  session_id: string;
  request_id: string;
  tool: string;           // "Bash", "Write", "Edit", etc.
  description: string;    // Human-readable description
  details: {
    command?: string;     // For Bash
    file_path?: string;   // For Write/Edit
    // ... tool-specific details
  };
}

// Browser → Server → Daemon
interface PermissionResponse {
  type: "permission_response";
  session_id: string;
  request_id: string;
  allow: boolean;
  remember?: boolean;     // Remember for this session
}
```

**Spawning with permission handling:**

```bash
claude -p "initial prompt" \
  --output-format stream-json \
  --input-format stream-json \
  --permission-prompt-tool stdio \
  --verbose
```

The `--permission-prompt-tool stdio` flag makes Claude Code emit permission requests as JSON instead of showing TUI prompts, allowing the daemon to relay them.

**Auto-approve options:**

For trusted environments or to reduce friction, users can configure auto-approval:

```typescript
interface PermissionConfig {
  auto_approve: {
    read: boolean;      // Auto-approve file reads (low risk)
    write: boolean;     // Auto-approve file writes
    bash: boolean;      // Auto-approve bash commands (high risk)
    mcp: boolean;       // Auto-approve MCP tool calls
  };
  // Or use Claude Code's built-in allowlists
  allowlist_path?: string;  // Path to .claude/settings.json
}
```

For v1, we recommend:
- Auto-approve reads (low risk)
- Relay writes and bash to browser (medium risk)
- Users can opt into full auto-approve at their own risk

### Session Management

Sessions can be resumed using the session ID:

```bash
# Resume existing session
claude --resume abc123 \
  --output-format stream-json \
  --input-format stream-json
```

The session ID is provided in the initial `system` message output.

---

## Daemon Changes

### Daemon-Server WebSocket Connection

Currently, the daemon uses HTTP REST to push updates. For bidirectional communication (receiving commands from server), the daemon needs a WebSocket connection:

```typescript
interface DaemonWebSocket {
  // Daemon → Server
  type: "daemon_connected" | "session_output" | "session_ended";

  // Server → Daemon
  type: "start_session" | "send_input" | "end_session";
}
```

### Connection Protocol

```
Daemon                              Server
  │                                    │
  │── ws connect ─────────────────────►│
  │                                    │
  │── daemon_connected ───────────────►│
  │   { client_id, capabilities }      │
  │                                    │
  │◄── start_session ──────────────────│
  │   { session_id, prompt, cwd }      │
  │                                    │
  │   [spawn claude --stream-json]     │
  │                                    │
  │── session_output ─────────────────►│
  │   { session_id, messages[] }       │
  │                                    │
  │◄── send_input ─────────────────────│
  │   { session_id, content }          │
  │                                    │
  │   [write to stdin]                 │
  │                                    │
  │── session_ended ──────────────────►│
  │   { session_id, exit_code }        │
  │                                    │
```

### Daemon WebSocket Messages

**Daemon → Server:**

```typescript
type DaemonMessage =
  // Connection established
  | {
      type: "daemon_connected";
      client_id: string;
      capabilities: {
        can_spawn_sessions: boolean;
        spawnable_harnesses: SpawnableHarnessInfo[];
      };
    }
  // Output from spawned session

// Sent as part of daemon_connected
interface SpawnableHarnessInfo {
  id: string;                    // "claude-code", "aider", etc.
  name: string;                  // Human-readable name
  available: boolean;            // Is the CLI installed?
  supports_permission_relay: boolean;
  supports_streaming: boolean;
  default_model?: string;
}

type DaemonMessage =
  // ... daemon_connected above
  // Output from spawned session
  | {
      type: "session_output";
      session_id: string;
      messages: StreamJsonMessage[];
    }
  // Session ended
  | {
      type: "session_ended";
      session_id: string;
      exit_code: number;
      error?: string;
    }
  // Permission prompt (when permission_mode is "relay")
  | {
      type: "permission_prompt";
      session_id: string;
      request_id: string;
      tool: string;
      description: string;
      details: Record<string, unknown>;
    };
```

**Server → Daemon:**

```typescript
type ServerToDaemonMessage =
  // Start a new session
  | {
      type: "start_session";
      session_id: string;          // Server-assigned ID
      prompt: string;              // Initial prompt
      cwd: string;                 // Working directory
      harness?: string;            // "claude-code" (default), "aider", etc.
      model?: string;              // Model to use
      permission_mode?: "relay" | "auto" | "deny";
      resume_session_id?: string;  // Harness session ID to resume
    }
  // Send input to running session
  | {
      type: "send_input";
      session_id: string;
      content: string;
    }
  // End session gracefully
  | {
      type: "end_session";
      session_id: string;
    }
  // Permission response (from browser)
  | {
      type: "permission_response";
      session_id: string;
      request_id: string;
      allow: boolean;
    };
```

### Spawned Session Manager

```typescript
interface SpawnedSession {
  id: string;                      // Server-assigned session ID
  claudeSessionId?: string;        // Claude's internal session ID (from init message)
  proc: Subprocess;                // Bun subprocess
  cwd: string;                     // Working directory
  startedAt: Date;
  stdin: WritableStream;           // For sending input
}

class SpawnedSessionManager {
  private sessions = new Map<string, SpawnedSession>();

  async startSession(request: StartSessionRequest): Promise<void> {
    const args = [
      "-p", request.prompt,
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (request.model) {
      args.push("--model", request.model);
    }

    if (request.resume_session_id) {
      args.push("--resume", request.resume_session_id);
    }

    const proc = Bun.spawn(["claude", ...args], {
      cwd: request.cwd,
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const session: SpawnedSession = {
      id: request.session_id,
      proc,
      cwd: request.cwd,
      startedAt: new Date(),
      stdin: proc.stdin,
    };

    this.sessions.set(request.session_id, session);

    // Stream stdout to server
    this.streamOutput(session, proc.stdout);

    // Handle exit
    proc.exited.then((exitCode) => {
      this.onSessionEnded(session, exitCode);
    });
  }

  async sendInput(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    }) + "\n";

    const writer = session.stdin.getWriter();
    await writer.write(new TextEncoder().encode(message));
    writer.releaseLock();
  }

  private async streamOutput(session: SpawnedSession, stdout: ReadableStream) {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      const messages: StreamJsonMessage[] = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            messages.push(msg);

            // Extract Claude session ID from init message
            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              session.claudeSessionId = msg.session_id;
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      if (messages.length > 0) {
        this.sendToServer({
          type: "session_output",
          session_id: session.id,
          messages,
        });
      }
    }
  }
}
```

---

## Server Changes

### Daemon Connection Tracking

```typescript
interface ConnectedDaemon {
  clientId: string;
  ws: WebSocket;
  connectedAt: Date;
  capabilities: {
    can_spawn_sessions: boolean;
    supported_harnesses: string[];
  };
  activeSpawnedSessions: Set<string>;
}

// Track connected daemons by client ID
const connectedDaemons = new Map<string, ConnectedDaemon>();
```

### New API Endpoints

**Check daemon availability:**

```
GET /api/daemon/status
```

Response:
```json
{
  "connected": true,
  "client_id": "abc123",
  "capabilities": {
    "can_spawn_sessions": true,
    "supported_harnesses": ["claude-code"]
  }
}
```

**Start a browser-initiated session:**

```
POST /api/sessions/spawn
Content-Type: application/json

{
  "prompt": "Help me implement user authentication",
  "cwd": "/Users/me/myproject",
  "harness": "claude-code",
  "model": "claude-sonnet-4-20250514",
  "permission_mode": "relay"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | Yes | Initial prompt to send to the agent |
| `cwd` | Yes | Working directory (must be in allowed repos) |
| `harness` | No | Agent to use: `"claude-code"` (default), `"aider"`, etc. |
| `model` | No | Model override (harness-specific) |
| `permission_mode` | No | `"relay"` (default), `"auto"`, or `"deny"` |

Response:
```json
{
  "session_id": "sess_xyz789",
  "status": "starting",
  "harness": "claude-code"
}
```

The server:
1. Validates daemon is connected and supports the requested harness
2. Creates a live session record
3. Sends `start_session` to daemon via WebSocket
4. Returns session ID for browser to subscribe

### WebSocket Protocol Extensions

Extend browser WebSocket messages to support input:

**Browser → Server (new):**

```typescript
type BrowserMessage =
  // Existing messages...
  | { type: "subscribe"; from_index?: number }
  | { type: "ping" }
  // New for browser-initiated sessions:
  | { type: "user_message"; content: string };
```

When server receives `user_message`:
1. Validate session is a browser-initiated (spawned) session
2. Relay to daemon via `send_input` message
3. Daemon writes to Claude's stdin

---

## Browser UI

### Session Start Interface

When daemon is connected, show a "New Session" button:

```
┌────────────────────────────────────────────────────────────────────┐
│  Live Sessions                                           [+ New]   │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  No active sessions                                                │
│                                                                    │
│  Your daemon is connected. Start a new session from here.          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Clicking "New" opens a modal:

```
┌────────────────────────────────────────────────────────────────────┐
│  Start New Session                                            [×]  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Working Directory                                                 │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ /Users/me/myproject                                      [▼] │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  Initial Prompt                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Help me implement user authentication with JWT tokens        │ │
│  │                                                              │ │
│  │                                                              │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  Model: claude-sonnet-4-20250514                             [▼]   │
│                                                                    │
│                                                  [Cancel] [Start]  │
└────────────────────────────────────────────────────────────────────┘
```

**Directory selection:**
- Dropdown populated from daemon's allowed repos
- Or type custom path (daemon validates it exists)

### Session Startup States

After clicking "Start", show progress through the startup sequence:

```
┌────────────────────────────────────────────────────────────────────┐
│  Starting Session...                                               │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ◐ Connecting to daemon...                                         │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Startup progression:**
1. `Connecting to daemon...` - Sending spawn request to server
2. `Spawning Claude Code...` - Daemon is starting the process
3. `Initializing session...` - Waiting for first output
4. → Transitions to live session view

**Startup failure states:**

| Error | Message | Action |
|-------|---------|--------|
| Daemon disconnected | "Daemon is not connected" | Show reconnect guidance |
| Invalid directory | "Directory not found: /path" | Let user edit path |
| Not in allowed repos | "Directory not in allowed repos" | Link to repo settings |
| Spawn timeout (30s) | "Session failed to start" | Retry button |
| Claude error | "Claude exited with error: {message}" | Show logs, retry button |

### Live Session View

Browser-initiated sessions show an input field with state-aware behavior:

```
┌────────────────────────────────────────────────────────────────────┐
│  ● LIVE  Implementing auth feature          [Interrupt] [End]      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  USER                                                              │
│  Help me implement user authentication with JWT tokens             │
│                                                                    │
│  ─────────────────────────────────────────────────────────────────│
│                                                                    │
│  CLAUDE                                                            │
│  I'll help you implement JWT authentication. Let me first          │
│  check your existing auth setup...                                 │
│                                                                    │
│  ▶ Read  src/auth/index.ts  ✓                                      │
│  ▶ Read  package.json       ✓                                      │
│                                                                    │
│  Based on your project structure, I'll...                          │
│                                                                    │
│  ● Claude is working...                                            │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Type your message... (queued until Claude finishes)     [⏎] │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

**Input behavior by state:**

| State | Input field | Behavior |
|-------|-------------|----------|
| `starting` | Disabled | Show "Starting session..." |
| `running` | Enabled | Input is queued, show "(queued until Claude finishes)" |
| `waiting` | Enabled | Send immediately on Enter |
| `ending` | Disabled | Show "Session ending..." |
| `ended` | Hidden | Show "Session ended" banner |

**Queued input:** When user types while Claude is generating, the message is queued locally. Visual indicator shows "Your message will be sent when Claude finishes." If the user sends multiple messages while queued, they are concatenated or the user is warned.

### Interrupt Capability

The **[Interrupt]** button sends SIGINT to stop Claude mid-generation:

```typescript
// Server → Daemon message
type ServerToDaemonMessage =
  // ... existing messages
  | {
      type: "interrupt_session";
      session_id: string;
    };
```

**Daemon handling:**
```typescript
async interruptSession(sessionId: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) return;

  // Send SIGINT to Claude process
  session.proc.kill("SIGINT");
}
```

**UI behavior:**
1. User clicks [Interrupt]
2. Button changes to "Interrupting..." (disabled)
3. Claude acknowledges interrupt (outputs partial response)
4. Session transitions to `waiting` state
5. Input field enabled for next message

**When to show Interrupt:**
- Only visible when session is in `running` state
- Hidden during `starting`, `waiting`, `ending`, `ended`

### Connection Status Indicator

Show daemon connection status in the UI:

```
┌─────────────────────────────────────────────────────────────────┐
│  ● Connected to daemon                        [+ New Session]    │
└─────────────────────────────────────────────────────────────────┘
```

or

```
┌─────────────────────────────────────────────────────────────────┐
│  ○ Daemon not connected                       [Setup Guide]      │
└─────────────────────────────────────────────────────────────────┘
```

### Connection Loss Handling

When the daemon WebSocket disconnects during an active session:

```
┌────────────────────────────────────────────────────────────────────┐
│  ⚠ CONNECTION LOST  Implementing auth feature                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  [Previous conversation...]                                        │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  ⚠ Daemon connection lost                                    │ │
│  │                                                              │ │
│  │  Your session is still running locally. Reconnecting...      │ │
│  │                                                              │ │
│  │  ◐ Attempting to reconnect (3s)          [End Session]       │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Input disabled while reconnecting...                         │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

**Reconnection behavior:**

1. **Immediate feedback**: Show "Connection lost" banner within 1s of disconnect
2. **Auto-reconnect**: Daemon attempts with exponential backoff (1s, 2s, 4s, 8s, max 30s)
3. **Session continuity**: Claude process continues running locally during disconnect
4. **Message buffering**: Daemon buffers output during disconnect, replays on reconnect
5. **Recovery**: On reconnect, daemon sends buffered messages; browser catches up

**If reconnection fails after 2 minutes:**

```
┌──────────────────────────────────────────────────────────────────┐
│  ⚠ Connection lost. Unable to reconnect.                         │
│                                                                  │
│  Your session may still be running on your machine.              │
│                                                                  │
│  Options:                                                        │
│  • Check that the daemon is running: `openctl daemon status`     │
│  • View session locally: `claude --resume {session_id}`          │
│                                                                  │
│  [Retry Connection]                    [End Session]             │
└──────────────────────────────────────────────────────────────────┘
```

**Browser WebSocket disconnect (browser → server):**

Less critical since server maintains daemon connection. On browser reconnect:
1. Re-subscribe to session with `from_index` to catch up on missed messages
2. Restore UI state based on current session state from server

---

## Session State Machine

Browser-initiated sessions follow this state lifecycle:

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
                    ▼                                             │
┌──────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌───────┴───┐
│ starting │──►│ running │◄─►│ waiting │──►│ ending  │──►│  ended    │
└──────────┘   └─────────┘   └─────────┘   └─────────┘   └───────────┘
     │              │                            ▲
     │              └────────────────────────────┤
     ▼                                           │
┌──────────┐                              ┌──────┴────┐
│  failed  │                              │ interrupted│
└──────────┘                              └───────────┘
```

**States:**

| State | Description | User can send input? |
|-------|-------------|---------------------|
| `starting` | Daemon is spawning Claude process | No |
| `running` | Claude is generating a response | No (queued) |
| `waiting` | Claude finished, awaiting input | Yes |
| `ending` | Session is shutting down gracefully | No |
| `ended` | Session complete | No |
| `failed` | Session failed to start | No |
| `interrupted` | User interrupted Claude mid-generation | Transitions to `waiting` |

**Transitions:**

| From | To | Trigger |
|------|----|---------|
| `starting` | `running` | First output received from Claude |
| `starting` | `failed` | Spawn error, timeout, or validation failure |
| `running` | `waiting` | Claude finishes response (no pending tool calls) |
| `running` | `running` | Tool execution (tool_use → tool_result cycle) |
| `running` | `interrupted` | User sends interrupt signal |
| `interrupted` | `waiting` | Claude acknowledges interrupt |
| `waiting` | `running` | User sends input |
| `waiting` | `ending` | User clicks "End Session" |
| `running` | `ending` | User clicks "End Session" |
| `ending` | `ended` | Claude process exits |
| `*` | `ended` | Claude process exits unexpectedly |

---

## Automatic Collaboration Setup

When a session is started from the browser, it's automatically set up for collaboration:

1. **Interactive mode enabled**: Session marked as `interactive: true` immediately
2. **Live streaming active**: Messages broadcast to all connected viewers
3. **Feedback enabled**: Viewers can send diff comments and follow-ups
4. **No approval required**: Since there's no local terminal user, all remote input goes directly to Claude

This differs from daemon-streamed sessions where the local user runs Claude with the TUI and remote feedback is injected via plugin hooks during idle time. In browser-initiated sessions, the browser *is* the primary interface—there's no local user to approve input.

---

## Security Considerations

Browser-initiated sessions introduce a significant attack surface: anyone with web access can potentially start agent sessions on a user's local machine. This section defines the security model.

### Threat Model

| Threat | Impact | Mitigation |
|--------|--------|------------|
| Account compromise | Attacker starts sessions, accesses code | Auth + notification (v1), approval flow (future) |
| Session hijacking | Attacker joins and sends malicious prompts | Session ownership, attribution |
| Insider threat | Coworker runs sessions on your machine | Notification (v1), approval flow (future) |
| CSRF/XSS | Malicious site triggers session | CSRF tokens, origin validation |

### V1: Desktop Notification on Session Start

As a baseline security measure, the daemon shows a **desktop notification** whenever a remote session is started:

```
┌────────────────────────────────────────────────────────────┐
│  🤖 Remote Session Started                                 │
│                                                            │
│  A Claude Code session was started from the web:           │
│                                                            │
│  Directory: /Users/me/myproject                            │
│  Prompt: "Help me implement user auth..."                  │
│  From: Chrome on MacBook (192.168.1.5)                     │
│                                                            │
│  [View Session]                      [End Session]         │
└────────────────────────────────────────────────────────────┘
```

**Implementation:**

```typescript
import { notify } from "node-notifier";  // or native macOS notifier

function notifySessionStarted(session: SpawnedSession, request: StartSessionRequest) {
  notify({
    title: "Remote Session Started",
    message: `Claude session started in ${basename(request.cwd)}`,
    actions: ["View", "End"],
    wait: true,
    timeout: 30,
  });
}
```

**Behavior:**
- Notification appears immediately when session spawns
- Shows directory, prompt preview (truncated), and requesting browser/IP
- **[View Session]** opens web UI to the session
- **[End Session]** terminates the session immediately
- Notification persists for 30 seconds, then auto-dismisses
- If user clicks "End Session", daemon sends `session_ended` with `reason: "user_terminated"`

This provides **awareness** without blocking—users know when sessions start but aren't required to approve each one.

### Authentication Flow

1. Browser authenticates to server (existing auth, eventually)
2. Daemon authenticates via `X-Openctl-Client-ID` header on WebSocket
3. Server validates client owns the daemon before allowing spawn requests
4. Sessions inherit the spawning user's permissions

### Working Directory Validation

The daemon validates `cwd` before spawning:

```typescript
function validateWorkingDirectory(cwd: string): boolean {
  // Must be in allowed repos list
  if (!isAllowedRepo(cwd)) return false;

  // Must exist
  if (!existsSync(cwd)) return false;

  // Must be a directory
  if (!statSync(cwd).isDirectory()) return false;

  return true;
}
```

### Rate Limiting

| Action | Limit |
|--------|-------|
| Spawn session | 5/minute per client |
| Send input | 60/minute per session |
| Concurrent spawned sessions | 3 per daemon |

### Resource Limits

Spawned sessions should have resource limits:

- **Max runtime**: 4 hours (configurable)
- **Max output size**: 100MB total output
- **Idle timeout**: 30 minutes with no input

### Audit Logging

All session activity should be logged for review:

```typescript
interface SessionAuditLog {
  session_id: string;
  action: "started" | "input" | "ended";
  timestamp: Date;
  actor: {
    type: "browser" | "daemon" | "system";
    browser_session_id?: string;
    ip_address?: string;
    user_agent?: string;
  };
  details: Record<string, unknown>;
}
```

Logs stored locally at `~/.openctl/audit.log` and optionally pushed to server.

---

## Future Security Enhancements

The following security features are **not planned for v1** but are documented here for future implementation.

### Session Approval Modes

Instead of just notification, require explicit approval before sessions start:

```typescript
type SessionApprovalMode =
  | "notify_only"        // v1 default: notification, no blocking
  | "local_confirm"      // Desktop notification with approve/deny
  | "oob_confirm"        // Out-of-band (email/SMS/push)
  | "trusted_browsers"   // Pre-approved browser sessions only
  | "auto";              // No approval (for trusted setups)
```

**Local confirmation flow:**

```
Browser                    Server                    Daemon
   │                          │                         │
   │── start_session ────────►│                         │
   │                          │── session_requested ───►│
   │◄── pending ──────────────│                         │
   │                          │   [Desktop notification]│
   │   [Browser shows         │   "Allow session in     │
   │    "Waiting for          │    /myproject?"         │
   │     approval..."]        │   [Approve] [Deny]      │
   │                          │                         │
   │                          │◄── approved/denied ─────│
   │◄── started/rejected ─────│                         │
```

### Out-of-Band Confirmation

When user is away from computer, send approval request via:

- **Email**: Simple link-based approve/deny
- **SMS**: For high-security setups
- **Push notification**: Via mobile app (requires app development)

```
┌────────────────────────────────────────────────────────────┐
│  Subject: Session Request on your machine                  │
│                                                            │
│  Someone requested a Claude Code session:                  │
│                                                            │
│  Directory: /Users/me/myproject                            │
│  Prompt: "Help me implement user authentication"           │
│  From: Chrome (IP: 192.168.1.5)                            │
│  Time: 2025-01-18 10:32 AM                                 │
│                                                            │
│  [Approve]  [Deny]  [Block all for 24h]                    │
│                                                            │
│  This request expires in 5 minutes.                        │
└────────────────────────────────────────────────────────────┘
```

### Trusted Browser Sessions

Pre-authorize specific browsers to skip approval:

```bash
# Generate trust token on local machine
openctl trust generate
# Output: Trust token: abc123-def456

# In browser settings, enter the token
# Browser session is now trusted for this daemon
```

Properties:
- Per-browser session (cleared on logout)
- Per-daemon (trust laptop daemon, not work desktop)
- Revocable: `openctl trust list` / `openctl trust revoke <id>`
- Expiring: tokens valid for 30 days by default

### Capability Scoping

Limit what browser-initiated sessions can do:

| Capability Level | Permissions |
|-----------------|-------------|
| `read_only` | Read files only, no writes, no bash |
| `sandboxed` | Write to temp dir only, restricted bash |
| `project_scoped` | Write only within project directory |
| `full` | Full Claude Code capabilities |

Browser could request capability level; daemon enforces via Claude Code flags or a sandboxing layer.

### Anomaly Detection

Flag unusual requests for extra scrutiny:

- New browser/device not seen before → escalate to OOB
- Unusual time (outside normal hours) → require confirmation
- Unusual location/IP → require confirmation
- High-risk prompt keywords ("delete", "sudo", "credentials", "rm -rf") → require confirmation
- Rapid successive requests → rate limit + alert

### Kill Switch

Emergency termination of all spawned sessions:

```bash
# CLI
openctl sessions kill-all

# Or via web UI panic button
```

Also: `openctl daemon pause` to temporarily stop accepting spawn requests without killing existing sessions

---

## Implementation Phases

### Phase 1: Daemon WebSocket Connection

**Daemon:**
- [ ] Add WebSocket connection to server alongside existing HTTP
- [ ] Send `daemon_connected` message with capabilities
- [ ] Handle reconnection with exponential backoff
- [ ] Graceful shutdown (close spawned sessions)

**Server:**
- [ ] WebSocket handler for daemon connections
- [ ] Track connected daemons by client ID
- [ ] `GET /api/daemon/status` endpoint

### Phase 2: Session Spawning

**Daemon:**
- [ ] `SpawnedSessionManager` class
- [ ] Handle `start_session` messages
- [ ] Spawn Claude with stream-json flags
- [ ] Stream stdout to server via WebSocket
- [ ] Handle `send_input` messages (write to stdin)
- [ ] Detect session end, send `session_ended`
- [ ] **Desktop notification on session start** (security baseline)
- [ ] Handle "End Session" action from notification

**Server:**
- [ ] `POST /api/sessions/spawn` endpoint
- [ ] Create live session record for spawned sessions
- [ ] Relay between browser WebSocket and daemon WebSocket
- [ ] Mark session complete when daemon reports end

### Phase 3: Browser UI

**Browser:**
- [ ] Daemon connection status indicator
- [ ] "New Session" button (when daemon connected)
- [ ] Session start modal (directory, prompt, model selection)
- [ ] Input field for browser-initiated sessions
- [ ] Send `user_message` messages via WebSocket

### Phase 4: Polish & Robustness

- [ ] Working directory dropdown (populated from allowed repos)
- [ ] Model selection dropdown
- [ ] Session resource limits
- [ ] Rate limiting
- [ ] Input queueing when Claude is generating
- [ ] Session resume (pick up where left off)
- [ ] Multiple concurrent sessions per daemon

---

## Open Questions

1. **Directory selection UX**: How do users specify which directory to work in?
   - Option A: Dropdown of allowed repos ← **Recommended for v1**
   - Option B: Text input with autocomplete
   - Option C: File picker (requires daemon to expose directory listing)

2. ~~**Permission prompts**: How to handle Claude requesting permissions in headless mode?~~
   - **Resolved**: See "Permission Prompt Handling" section. Relay via `--permission-prompt-tool stdio` flag with browser UI for approve/deny.

3. ~~**Tool limitations**: Some tools don't work well in headless mode (e.g., `AskUserQuestion`).~~
   - **Resolved**: AskUserQuestion is handled via browser relay (see "AskUserQuestion Browser Relay" section). Permission prompts use the same pattern.

4. **Multi-user scenarios**: If multiple browsers are viewing, who can send input?
   - Option B with attribution is recommended, but specifics TBD:
   - How is attribution displayed in the conversation?
   - Do we show who is currently typing?
   - How do we handle conflicting inputs?

5. ~~**Session continuity**: What happens if daemon disconnects mid-session?~~
   - **Resolved**: See "Connection Loss Handling" section. Daemon buffers output and replays on reconnect. Claude process continues locally.

6. **Cost visibility**: Users should see token usage for spawned sessions.
   - Parse `usage` fields from stream-json output
   - Display running total in UI
   - Consider showing estimated cost in real-time

7. **Harness availability detection**: How do we detect which harnesses are installed?
   - Check if CLI exists in PATH (`which claude`, `which aider`, etc.)
   - Version detection for capability checking
   - Graceful fallback when harness is unavailable

---

## Appendix: Stream-JSON Message Examples

### Initialization

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "a1b2c3d4",
  "cwd": "/Users/me/myproject",
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
}
```

### Text Response

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_01XYZ",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "I'll help you implement that feature. Let me start by examining your codebase."
      }
    ],
    "model": "claude-sonnet-4-20250514",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 56
    }
  }
}
```

### Tool Use

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_01ABC",
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01DEF",
        "name": "Read",
        "input": {
          "file_path": "src/index.ts"
        }
      }
    ]
  }
}
```

### Tool Result (automatic)

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01DEF",
        "content": "// Contents of src/index.ts\nexport function main() { ... }"
      }
    ]
  }
}
```

### Session Complete

```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "a1b2c3d4",
  "duration_ms": 45000,
  "cost_usd": 0.0234,
  "is_error": false
}
```

---

## UI Design

This section specifies how users interact with browser-initiated sessions through the web interface.

### Design Decision: Enhanced Session List with Global Status

After evaluating three approaches, we recommend **Option B: Enhanced Session List** combined with a global header indicator:

| Option | Pros | Cons |
|--------|------|------|
| A: Personal Dashboard | Dedicated space, clear separation | Adds new navigation paradigm, fragments experience |
| **B: Enhanced Session List** | Builds on existing patterns, natural location | Header can feel crowded |
| C: Floating/Global UI | Always accessible | Disconnected from session context, intrusive |

**Rationale**: The session list (`/sessions`) is already where users go to see their sessions. Adding "start a new session" here is the natural extension. A small global indicator in the header provides visibility without disrupting the existing navigation.

### Information Architecture

```
/                          Landing page (unchanged)
/sessions                  Session list + daemon status + "New Session" button
/sessions/:id              Session detail (enhanced for spawned sessions)
/s/:shareToken             Shared session (unchanged)
```

No new routes are needed. The session list gains new functionality when a daemon is connected.

---

### Global Header Enhancement

Add a daemon status indicator to the site header. This provides at-a-glance connection status on every page.

**Header with connected daemon:**

```
+--------------------------------------------------------------------------------+
|                                                                                |
|  []penctl                          @ bryce-macbook   [Sessions]                |
|                                    ^^^^^^^^^^^^                                |
|                                    daemon indicator                            |
+--------------------------------------------------------------------------------+
```

**Header with disconnected daemon:**

```
+--------------------------------------------------------------------------------+
|                                                                                |
|  []penctl                                            [Sessions]                |
|                                                                                |
+--------------------------------------------------------------------------------+
```

**States:**

| State | Display | Hover tooltip |
|-------|---------|---------------|
| Connected | `@ {device-name}` (green text, subtle) | "Connected to daemon on bryce-macbook" |
| Disconnected | Hidden (no indicator) | - |
| Multiple devices | `@ 2 devices` with dropdown | List of connected devices |

**Design notes:**
- The `@` prefix echoes terminal/SSH conventions
- Device name is truncated to 20 chars, full name on hover
- Green accent color (`#86efac`) for connected state
- Clicking opens a dropdown for multi-device scenarios

**Multi-device dropdown:**

```
+--------------------------------------+
|  Connected Devices                   |
+--------------------------------------+
|  @ bryce-macbook                     |
|    /Users/bryce                      |
|    Claude Code, Aider                |
|                                      |
|  @ work-desktop                      |
|    /home/bryce                       |
|    Claude Code                       |
+--------------------------------------+
```

---

### Session List Page Enhancement

When a daemon is connected, the session list gains new functionality.

**Session list with connected daemon:**

```
+--------------------------------------------------------------------------------+
|                                                                                |
|  Sessions                                    [+  New Session]   [___Search___] |
|                                              ^^^^^^^^^^^^^^^^^                 |
|                                              Primary CTA (cyan)                |
+--------------------------------------------------------------------------------+
|                                                                                |
|  +------------------------+  +------------------------+  +---------------------+
|  |  LIVE  Fixing auth bug |  |  Implement user signup |  |  Refactor API      |
|  |                        |  |                        |  |                     |
|  |  Working on JWT...     |  |  Added registration... |  |  Moved endpoints...|
|  |                        |  |                        |  |                     |
|  |  Jan 18 . myproject    |  |  Jan 17 . myproject    |  |  Jan 16 . api-srv  |
|  +------------------------+  +------------------------+  +---------------------+
|                                                                                |
+--------------------------------------------------------------------------------+
```

**Session list with no daemon:**

```
+--------------------------------------------------------------------------------+
|                                                                                |
|  Sessions                                                       [___Search___] |
|                                                                                |
+--------------------------------------------------------------------------------+
|                                                                                |
|  +---------------------------------------------------------------------------+
|  |                                                                           |
|  |                 No active sessions                                        |
|  |                                                                           |
|  |  Start the daemon to stream and create sessions from here.                |
|  |                                                                           |
|  |  $ openctl daemon start                          [Copy]                   |
|  |                                                                           |
|  +---------------------------------------------------------------------------+
|                                                                                |
+--------------------------------------------------------------------------------+
```

**Button behavior:**

| Daemon state | Button | Action |
|--------------|--------|--------|
| Connected | `[+ New Session]` (cyan, enabled) | Opens new session modal |
| Disconnected | Hidden | - |

---

### New Session Modal

Clicking "New Session" opens a modal to configure and start a browser-initiated session.

**Modal layout:**

```
+----------------------------------------------------------------------+
|  New Session                                                     [x] |
+----------------------------------------------------------------------+
|                                                                      |
|  Device                                                              |
|  +----------------------------------------------------------------+ |
|  |  bryce-macbook                                              [v] | |
|  +----------------------------------------------------------------+ |
|                                                                      |
|  Directory                                                           |
|  +----------------------------------------------------------------+ |
|  |  ~/projects/myapp                                           [v] | |
|  +----------------------------------------------------------------+ |
|  Allowed: myapp, api-server, shared-libs                             |
|                                                                      |
|  Initial Prompt                                                      |
|  +----------------------------------------------------------------+ |
|  |                                                                | |
|  |  Help me implement user authentication with JWT tokens...      | |
|  |                                                                | |
|  |                                                                | |
|  +----------------------------------------------------------------+ |
|                                                                      |
|  [v] Advanced options                                                |
|                                                                      |
|                                            [Cancel]  [Start Session] |
+----------------------------------------------------------------------+
```

**Advanced options (collapsed by default):**

```
|  [^] Advanced options                                                |
|                                                                      |
|  Agent                                                               |
|  +----------------------------------------------------------------+ |
|  |  Claude Code                                                [v] | |
|  +----------------------------------------------------------------+ |
|                                                                      |
|  Model                                                               |
|  +----------------------------------------------------------------+ |
|  |  claude-sonnet-4-20250514                                   [v] | |
|  +----------------------------------------------------------------+ |
|                                                                      |
|  Permission mode                                                     |
|  (o) Ask for each permission     <- default, most secure             |
|  ( ) Auto-approve safe operations (reads only)                       |
|  ( ) Auto-approve all (trust this session)                           |
```

**Field specifications:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| Device | Dropdown | Yes (auto-select if single) | Populated from connected daemons |
| Directory | Dropdown + text | Yes | Dropdown shows allowed repos, can type custom path |
| Initial Prompt | Textarea | Yes | Min 10 chars, max 10,000 chars |
| Agent | Dropdown | No | Default: Claude Code. Others: Aider (if available) |
| Model | Dropdown | No | Default: daemon's configured default |
| Permission mode | Radio | No | Default: "Ask for each permission" |

**Directory selection UX:**

The dropdown shows a list of allowed repositories with recent directories first:

```
+----------------------------------------------------------------+
|  ~/projects/myapp                                         (recent) |
|  ~/projects/api-server                                    (recent) |
|  ---------------------------------------------------------------- |
|  ~/projects/shared-libs                                            |
|  ~/work/internal-tools                                             |
|  ---------------------------------------------------------------- |
|  Type a custom path...                                             |
+----------------------------------------------------------------+
```

If the user types a custom path, the daemon validates it:
- Must exist
- Must be a directory
- Must be in allowed repos (if enforced)

Validation happens on blur with inline error messages.

---

### Session Startup Flow

After clicking "Start Session", show progress through the startup sequence.

**In-modal progress:**

```
+----------------------------------------------------------------------+
|  Starting Session...                                                 |
+----------------------------------------------------------------------+
|                                                                      |
|  [=====>                                        ]                    |
|                                                                      |
|  Connecting to daemon...                                             |
|                                                                      |
|                                                           [Cancel]   |
+----------------------------------------------------------------------+
```

**Progress steps:**

1. `Connecting to daemon...` - Sending spawn request
2. `Spawning Claude Code...` - Daemon is starting the process
3. `Waiting for response...` - First output expected

**Transition to session view:**

On first output from Claude, redirect to `/sessions/{new_session_id}` automatically. The modal closes and the user sees the live session.

**Error states:**

```
+----------------------------------------------------------------------+
|  Failed to Start Session                                         [x] |
+----------------------------------------------------------------------+
|                                                                      |
|  [!] Daemon disconnected                                             |
|                                                                      |
|  Your daemon lost connection. Make sure it's running:                |
|                                                                      |
|  $ openctl daemon status                                             |
|                                                                      |
|                                            [Cancel]  [Retry]         |
+----------------------------------------------------------------------+
```

| Error | Message | Actions |
|-------|---------|---------|
| Daemon disconnected | "Daemon disconnected" | Cancel, Retry |
| Directory not found | "Directory not found: /path" | Edit path, Cancel |
| Not in allowed repos | "Directory not in allowed repos" | Cancel |
| Spawn timeout (30s) | "Session failed to start" | Retry, Cancel |
| Claude error | "Claude exited: {message}" | Show logs, Retry |

---

### Live Session View (Spawned Sessions)

Spawned sessions use the existing `SessionDetailPage` with enhancements for input.

**Key differences from streamed sessions:**

| Aspect | Streamed (daemon mode) | Spawned (browser-initiated) |
|--------|----------------------|------------------------------|
| Input | Feedback box (queued, needs approval) | Direct input (sent immediately when waiting) |
| Header actions | [Share] [Export] | [Interrupt] [End] [Share] [Export] |
| Status | LIVE badge | LIVE badge + state indicator |

**Session header with state indicator:**

```
+--------------------------------------------------------------------------------+
|                                                                                |
|  o LIVE  Implementing authentication            [Interrupt]  [End]  [Share]    |
|                                                                                |
|  Claude Code . claude-sonnet-4 . ~/projects/myapp . 5m 32s                     |
|                                                                                |
+--------------------------------------------------------------------------------+
```

**State indicator in header:**

The dot next to "LIVE" reflects Claude's current state:

| State | Indicator | Description |
|-------|-----------|-------------|
| `starting` | Orange pulse | Session initializing |
| `running` | Cyan pulse | Claude is generating/executing |
| `waiting` | Green solid | Awaiting user input |
| `ending` | Gray | Session shutting down |

**Full session layout:**

```
+--------------------------------------------------------------------------------+
|  o LIVE  Implementing authentication            [Interrupt]  [End]  [Share]    |
|  Claude Code . claude-sonnet-4 . ~/projects/myapp . 5m 32s                     |
+--------------------------------------------------------------------------------+
|                                                     |                          |
|  USER                                               |  DIFFS                   |
|  Help me implement user authentication...           |                          |
|                                                     |  src/auth/index.ts       |
|  -------------------------------------------------- |  +import jwt from 'jsonw |
|                                                     |  +                       |
|  CLAUDE                                             |  +export function sign...|
|  I'll help you implement JWT authentication.        |                          |
|  Let me check your project structure...             |                          |
|                                                     |                          |
|  > Read  src/index.ts  [checkmark]                  |                          |
|  > Read  package.json  [checkmark]                  |                          |
|                                                     |                          |
|  Based on your setup, I'll create an auth module... |                          |
|                                                     |                          |
|  o Claude is working...                             |                          |
|                                                     |                          |
+--------------------------------------------------------------------------------+
|  +----------------------------------------------------------------------+     |
|  |  Type your message...                                           [->] |     |
|  +----------------------------------------------------------------------+     |
|  Your message will be sent when Claude finishes                              |
+--------------------------------------------------------------------------------+
```

---

### Input Behavior

The input field at the bottom of the session view has state-dependent behavior.

**Input states:**

| Session state | Input state | Placeholder | Behavior |
|--------------|-------------|-------------|----------|
| `starting` | Disabled | "Starting session..." | No input |
| `running` | Enabled | "Type your message... (queued)" | Queue locally, show pending count |
| `waiting` | Enabled + focused | "Type your message..." | Send immediately on Enter |
| `ending` | Disabled | "Session ending..." | No input |
| `ended` | Hidden | - | Input removed, show "Session ended" |

**Queued message indicator:**

When user types while Claude is generating:

```
+----------------------------------------------------------------------+
|  Can you also add password hashing?                             [->] |
+----------------------------------------------------------------------+
  1 message queued . Will send when Claude finishes
```

If user tries to queue multiple messages:

```
+----------------------------------------------------------------------+
|  [Warning: You already have a message queued. Send anyway?]          |
|                                                                      |
|  And add rate limiting too                                      [->] |
+----------------------------------------------------------------------+
  2 messages queued
```

**Keyboard shortcuts:**

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message (when input is focused) |
| `Cmd/Ctrl + Enter` | Send message (from anywhere in input) |
| `Cmd/Ctrl + I` | Focus input field |
| `Escape` | Cancel queued messages (with confirmation) |

---

### Interrupt and End Session

**Interrupt button:**

Visible only when Claude is in `running` state. Sends SIGINT to gracefully stop generation.

```
Before:    [Interrupt]  [End]
During:    [Interrupting...]  [End]   <- disabled, shows spinner
After:     [Interrupt]  [End]         <- re-enabled after Claude stops
```

**End Session button:**

Always visible during active session. Behavior depends on state:

| State | Click behavior |
|-------|----------------|
| `running` | Show confirmation: "Claude is still working. End session?" |
| `waiting` | End immediately (no confirmation) |

**End session confirmation:**

```
+----------------------------------------------------------------------+
|  End Session?                                                    [x] |
+----------------------------------------------------------------------+
|                                                                      |
|  Claude is still working on your request. Are you sure you want      |
|  to end this session?                                                |
|                                                                      |
|  The session will be saved and you can review it later.              |
|                                                                      |
|                                          [Cancel]  [End Session]     |
+----------------------------------------------------------------------+
```

---

### Permission Prompt UI

When Claude requests permission for a dangerous operation, show a modal overlay.

**Permission modal:**

```
+----------------------------------------------------------------------+
|  Permission Required                                             [x] |
+----------------------------------------------------------------------+
|                                                                      |
|  Claude wants to run a bash command:                                 |
|                                                                      |
|  +----------------------------------------------------------------+ |
|  |  rm -rf ./node_modules && npm install                          | |
|  +----------------------------------------------------------------+ |
|                                                                      |
|  [ ] Allow all bash commands this session                            |
|                                                                      |
|                                             [Deny]  [Allow]          |
+----------------------------------------------------------------------+
```

**Permission types with contextual display:**

| Tool | Title | Shows |
|------|-------|-------|
| Bash | "Run a bash command" | Command in code block |
| Write | "Write to a file" | File path + content preview |
| Edit | "Edit a file" | File path + diff preview |
| MCP | "Use external tool" | Tool name + parameters |

**"Remember" checkbox behavior:**

| Option | Effect |
|--------|--------|
| "Allow all bash commands" | Auto-approve bash for this session |
| "Allow writes to this directory" | Auto-approve writes in cwd |
| Not checked | Ask each time |

---

### AskUserQuestion UI

When Claude uses the `AskUserQuestion` tool, display a question modal.

**Question modal with options:**

```
+----------------------------------------------------------------------+
|  Claude is asking                                                [x] |
+----------------------------------------------------------------------+
|                                                                      |
|  "How would you like me to handle authentication?"                   |
|                                                                      |
|  ( ) Use JWT tokens with refresh                                     |
|  ( ) Use session-based auth with cookies                             |
|  ( ) Use OAuth with third-party providers                            |
|                                                                      |
|  Or type a custom response:                                          |
|  +----------------------------------------------------------------+ |
|  |                                                                | |
|  +----------------------------------------------------------------+ |
|                                                                      |
|                                                          [Submit]    |
+----------------------------------------------------------------------+
```

**Question modal without options (open-ended):**

```
+----------------------------------------------------------------------+
|  Claude is asking                                                [x] |
+----------------------------------------------------------------------+
|                                                                      |
|  "What email address should I use for the admin account?"            |
|                                                                      |
|  +----------------------------------------------------------------+ |
|  |                                                                | |
|  +----------------------------------------------------------------+ |
|                                                                      |
|                                                          [Submit]    |
+----------------------------------------------------------------------+
```

**Behavior notes:**
- Modal blocks session input until answered
- Can select an option OR type a custom response, not both
- Submit is disabled until user makes a selection or types something
- Timeout after 5 minutes shows warning, auto-dismisses after 10 (configurable)

---

### Connection Loss Handling

**Inline banner when connection lost:**

```
+--------------------------------------------------------------------------------+
|  [!] Connection to daemon lost . Reconnecting...              [End Session]    |
+--------------------------------------------------------------------------------+
|                                                     |                          |
|  [Previous conversation content...]                 |                          |
|                                                     |                          |
|  -------------------------------------------------- |                          |
|                                                     |                          |
|  [Grayed out recent content]                        |                          |
|                                                     |                          |
+--------------------------------------------------------------------------------+
|  +----------------------------------------------------------------------+     |
|  |  Input disabled while reconnecting...                                |     |
|  +----------------------------------------------------------------------+     |
+--------------------------------------------------------------------------------+
```

**After extended disconnect (2 minutes):**

```
+--------------------------------------------------------------------------------+
|  [!] Unable to reconnect to daemon                                             |
+--------------------------------------------------------------------------------+
|                                                                                |
|  +------------------------------------------------------------------------+   |
|  |                                                                        |   |
|  |  Connection to your daemon was lost and we couldn't reconnect.         |   |
|  |                                                                        |   |
|  |  Your session may still be running locally. You can:                   |   |
|  |                                                                        |   |
|  |  - Check daemon status:  $ openctl daemon status                       |   |
|  |  - Resume locally:       $ claude --resume abc123                      |   |
|  |                                                                        |   |
|  |                          [Retry Connection]  [End Session]             |   |
|  +------------------------------------------------------------------------+   |
|                                                                                |
+--------------------------------------------------------------------------------+
```

---

### Session Card Badge for Spawned Sessions

In the session list, spawned sessions get a special badge indicating they were started from the browser.

```
+----------------------------------+
|  LIVE  REMOTE  Implementing auth |   <- "REMOTE" badge indicates browser-initiated
|                                  |
|  Working on JWT tokens...        |
|                                  |
|  Jan 18 . myproject              |
+----------------------------------+
```

**Badge legend:**

| Badge | Meaning |
|-------|---------|
| LIVE | Session is currently active |
| REMOTE | Session was started from browser (not local terminal) |
| Interactive | Session accepts feedback (daemon-streamed) |
| PR | Session has an associated pull request |

---

### Mobile Considerations (v1)

While full mobile support is not critical for v1, the UI should be usable:

| Feature | Mobile behavior |
|---------|-----------------|
| Session list | Single column, full-width cards |
| New Session modal | Full-screen takeover |
| Session view | Conversation only (diffs collapsed) |
| Input field | Fixed at bottom, auto-focuses |
| Permission modals | Full-screen |

**Touch targets:** All buttons minimum 44x44px tap target.

---

### Component Summary

New components to implement:

| Component | Location | Description |
|-----------|----------|-------------|
| `DaemonStatusIndicator` | Header | Shows connected device(s) |
| `NewSessionButton` | SessionListPage | Opens new session modal |
| `NewSessionModal` | Modal | Form to configure and start session |
| `SessionStartProgress` | Modal | Progress indicator during spawn |
| `SessionInput` | SessionDetailPage | Enhanced input with state awareness |
| `InterruptButton` | SessionDetailPage header | Sends SIGINT |
| `EndSessionButton` | SessionDetailPage header | Ends session |
| `PermissionModal` | Modal | Permission request UI |
| `QuestionModal` | Modal | AskUserQuestion response UI |
| `ConnectionLostBanner` | SessionDetailPage | Reconnection status |
| `RemoteBadge` | SessionCard | Indicates browser-initiated session |

---

### Implementation Order

Recommended implementation sequence:

1. **DaemonStatusIndicator** - Add to header, requires daemon connection tracking
2. **NewSessionButton + NewSessionModal** - Core session initiation flow
3. **SessionInput enhancements** - State-aware input with queueing
4. **Interrupt/End buttons** - Session control
5. **PermissionModal** - Permission relay UI
6. **QuestionModal** - AskUserQuestion relay UI
7. **ConnectionLostBanner** - Reconnection handling
8. **RemoteBadge** - Visual distinction in session list

---

## References

- [Claude Code Headless Documentation](https://code.claude.com/docs/en/headless)
- [Stream-JSON Chaining (claude-flow wiki)](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)
- [Tool Result via stdin issue (#16712)](https://github.com/anthropics/claude-code/issues/16712)
- [Claude Agent SDK stdin/stdout Communication](https://buildwithaws.substack.com/p/inside-the-claude-agent-sdk-from)
