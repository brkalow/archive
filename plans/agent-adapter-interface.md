# Agent Adapter Interface - Implementation Plan

Extend the existing `HarnessAdapter` interface to support multiple agents (Claude Code, Cursor, Codex, opencode) with full UI control, file modification detection, and backward compatibility.

## Phase 1: Types and Interface Extension

**File:** `/cli/adapters/types.ts`

### 1.1 Add New Types (after line 24)

```typescript
export type ToolIconCategory =
  | "file" | "edit" | "terminal" | "search" | "web"
  | "todo" | "question" | "task" | "thinking" | "mcp" | "default";

export interface ToolConfig {
  icon: ToolIconCategory;
  modifiesFiles?: boolean;
  filePathProperty?: string;
  renderer?: string;
}

export interface SystemTagPattern {
  tag: string;
  style?: "xml" | "regex";
  pattern?: RegExp;
}

export interface AdapterUIConfig {
  tools?: Record<string, ToolConfig>;
  systemTags?: SystemTagPattern[];
  defaultToolIcon?: ToolIconCategory;
  mcpToolPrefixes?: string[];
}
```

### 1.2 Extend HarnessAdapter Interface (lines 25-46)

Add optional methods:
```typescript
  // UI Configuration
  getUIConfig?(): AdapterUIConfig;
  getToolIcon?(toolName: string): ToolIconCategory;
  getToolSummary?(toolName: string, input: Record<string, unknown>): string;

  // File Modification Detection
  getFileModifyingTools?(): string[];
  extractFilePath?(toolName: string, input: Record<string, unknown>): string | null;

  // Content Processing
  stripSystemTags?(text: string): string;
  normalizeRole?(rawRole: string): "user" | "assistant" | null;
```

### 1.3 Add Constants

```typescript
export const DEFAULT_ADAPTER_ID = "claude-code";
```

---

## Phase 2: Claude Code Adapter Implementation

**File:** `/cli/adapters/claude-code.ts`

### 2.1 Define Tool Configuration (after imports)

```typescript
const CLAUDE_CODE_TOOLS: Record<string, ToolConfig> = {
  Read: { icon: "file" },
  Write: { icon: "edit", modifiesFiles: true, filePathProperty: "file_path" },
  Edit: { icon: "edit", modifiesFiles: true, filePathProperty: "file_path" },
  NotebookEdit: { icon: "edit", modifiesFiles: true, filePathProperty: "notebook_path" },
  Bash: { icon: "terminal" },
  KillShell: { icon: "terminal" },
  Glob: { icon: "search" },
  Grep: { icon: "search" },
  WebFetch: { icon: "web" },
  WebSearch: { icon: "web" },
  Task: { icon: "task", renderer: "task" },
  TaskOutput: { icon: "task" },
  TodoWrite: { icon: "todo", renderer: "todo_write" },
  AskUserQuestion: { icon: "question", renderer: "ask_user_question" },
  "mcp__conductor__AskUserQuestion": { icon: "question", renderer: "ask_user_question" },
};

const CLAUDE_CODE_SYSTEM_TAGS: SystemTagPattern[] = [
  { tag: "system_instruction" },
  { tag: "system-instruction" },
  { tag: "system-reminder" },
  { tag: "local-command-caveat" },
  { tag: "local-command-stdout" },
];

const CLAUDE_CODE_UI_CONFIG: AdapterUIConfig = {
  tools: CLAUDE_CODE_TOOLS,
  systemTags: CLAUDE_CODE_SYSTEM_TAGS,
  defaultToolIcon: "default",
  mcpToolPrefixes: ["mcp__"],
};
```

### 2.2 Implement New Methods (add to adapter object after line 203)

```typescript
getUIConfig(): AdapterUIConfig {
  return CLAUDE_CODE_UI_CONFIG;
},

getFileModifyingTools(): string[] {
  return Object.entries(CLAUDE_CODE_TOOLS)
    .filter(([_, config]) => config.modifiesFiles)
    .map(([name]) => name);
},

extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  const config = CLAUDE_CODE_TOOLS[toolName];
  if (!config?.filePathProperty) return null;
  const value = input[config.filePathProperty];
  return typeof value === "string" ? value : null;
},

getToolIcon(toolName: string): ToolIconCategory {
  if (CLAUDE_CODE_TOOLS[toolName]) return CLAUDE_CODE_TOOLS[toolName].icon;
  for (const prefix of CLAUDE_CODE_UI_CONFIG.mcpToolPrefixes || []) {
    if (toolName.startsWith(prefix)) return "mcp";
  }
  return "default";
},

stripSystemTags(text: string): string {
  return stripSystemTags(text);
},

normalizeRole(rawRole: string): "user" | "assistant" | null {
  if (rawRole === "human" || rawRole === "user") return "user";
  if (rawRole === "assistant") return "assistant";
  return null;
},
```

---

## Phase 3: Adapter Registry Updates

**File:** `/cli/adapters/index.ts`

### 3.1 Add Helper Functions (after line 19)

```typescript
import { DEFAULT_ADAPTER_ID } from "./types";

export function getAdapterOrDefault(id: string): HarnessAdapter {
  const adapter = getAdapterById(id);
  if (adapter) return adapter;
  console.warn(`Adapter '${id}' not found, using default`);
  return getAdapterById(DEFAULT_ADAPTER_ID)!;
}

export function getFileModifyingToolsForAdapter(adapter: HarnessAdapter): string[] {
  return adapter.getFileModifyingTools?.() || ["Write", "Edit", "NotebookEdit"];
}

export function extractFilePathFromTool(
  adapter: HarnessAdapter,
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (adapter.extractFilePath) return adapter.extractFilePath(toolName, input);
  // Fallback
  if (toolName === "Write" || toolName === "Edit") return input.file_path as string || null;
  if (toolName === "NotebookEdit") return input.notebook_path as string || null;
  return null;
}
```

### 3.2 Update Exports

Add to exports: `ToolIconCategory`, `ToolConfig`, `SystemTagPattern`, `AdapterUIConfig`, `DEFAULT_ADAPTER_ID`

---

## Phase 4: Database Migration

**Files:** `/src/db/schema.ts`, `/src/db/repository.ts`

### 4.1 Add Column (schema.ts, after line 108)

```typescript
safeAddColumn(db, "sessions", "agent_session_id", "TEXT");
db.run(`UPDATE sessions SET agent_session_id = claude_session_id WHERE agent_session_id IS NULL AND claude_session_id IS NOT NULL`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_agent_session_id ON sessions(agent_session_id)`);
```

### 4.2 Update Session Type

Add `agent_session_id: string | null;` to Session type (line 181-198)

### 4.3 Add Repository Method (repository.ts)

Add prepared statement:
```typescript
getSessionByAgentSessionId: db.prepare(`SELECT * FROM sessions WHERE agent_session_id = ? ORDER BY created_at DESC LIMIT 1`),
```

Add method:
```typescript
getSessionByAgentSessionId(agentSessionId: string): Session | null {
  const result = this.stmts.getSessionByAgentSessionId.get(agentSessionId);
  return result ? this.normalizeSession(result) : null;
}
```

---

## Phase 5: Daemon Updates

**File:** `/cli/daemon/session-tracker.ts`

### 5.1 Remove Hardcoded Constant (line 27)

Delete: `const FILE_MODIFYING_TOOLS = ["Write", "Edit", "NotebookEdit"];`

### 5.2 Update Imports

```typescript
import { getFileModifyingToolsForAdapter, extractFilePathFromTool } from "../adapters";
```

### 5.3 Update checkForFileModifications (line 334-364)

Replace hardcoded tool list:
```typescript
const fileModifyingTools = getFileModifyingToolsForAdapter(session.adapter);
// Use fileModifyingTools.includes(block.name) instead of FILE_MODIFYING_TOOLS
// Use extractFilePathFromTool(session.adapter, block.name, input) for file paths
```

### 5.4 Update scanExistingSessionForModifiedFiles (line 435-490)

Same pattern - use adapter methods instead of hardcoded list.

---

## Phase 6: API Updates

**File:** `/src/routes/api.ts`

### 6.1 Update extractTouchedFiles (line 1430-1444)

Make adapter-aware:
```typescript
function extractTouchedFiles(messages: Omit<Message, "id">[], adapterId?: string): Set<string> {
  const adapter = adapterId ? getAdapterById(adapterId) : null;
  const fileModifyingTools = adapter
    ? getFileModifyingToolsForAdapter(adapter)
    : ["Write", "Edit", "NotebookEdit"];
  // ... rest uses adapter.extractFilePath with fallback
}
```

### 6.2 Include Adapter Config in Session Detail (line 149-166)

```typescript
let adapterUIConfig: AdapterUIConfig | null = null;
if (session.harness) {
  const adapter = getAdapterById(session.harness);
  if (adapter?.getUIConfig) adapterUIConfig = adapter.getUIConfig();
}
return json({ session, messages, diffs, shareUrl, review, adapterUIConfig });
```

---

## Phase 7: Frontend Updates

**File:** `/src/client/blocks.ts`

### 7.1 Add Icon Category Map (after line 47)

```typescript
const iconsByCategory: Record<string, string> = {
  file: toolIcons.file,
  edit: toolIcons.edit,
  terminal: toolIcons.terminal,
  // ... map each category to existing SVG
};
```

### 7.2 Update getToolIcon (line 50-82)

Add optional `adapterConfig` parameter:
```typescript
export function getToolIcon(toolName: string, adapterConfig?: AdapterUIConfig | null): string {
  if (adapterConfig?.tools) {
    // Check exact match, then wildcards, then MCP prefixes
    // Return iconsByCategory[config.icon]
  }
  // Fallback to existing hardcoded logic
}
```

### 7.3 Update stripSystemTags (line 226-240)

Add optional `adapterConfig` parameter:
```typescript
export function stripSystemTags(text: string, adapterConfig?: AdapterUIConfig | null): string {
  if (adapterConfig?.systemTags) {
    // Use adapter's tag patterns
  }
  // Fallback to existing hardcoded logic
}
```

---

## Phase 8: Upload Command Updates

**File:** `/bin/upload-session.ts`

### 8.1 Update extractTouchedFiles (line 452-486)

Make adapter-aware - same pattern as API.

---

## Critical Files Summary

| File | Phase | Changes |
|------|-------|---------|
| `/cli/adapters/types.ts` | 1 | Add types, extend interface |
| `/cli/adapters/claude-code.ts` | 2 | Implement new methods |
| `/cli/adapters/index.ts` | 3 | Add helpers, update exports |
| `/src/db/schema.ts` | 4 | Add agent_session_id column |
| `/src/db/repository.ts` | 4 | Add getSessionByAgentSessionId() |
| `/cli/daemon/session-tracker.ts` | 5 | Remove hardcoded tools, use adapter |
| `/src/routes/api.ts` | 6 | Include adapter config in response |
| `/src/client/blocks.ts` | 7 | Refactor to use adapter config |
| `/bin/upload-session.ts` | 8 | Use adapter for file detection |

---

## Verification

1. **TypeScript compilation**: `bun run build` should pass
2. **Unit tests**: `bun test` should pass
3. **Upload existing session**: `openctl upload` should work with Claude Code sessions
4. **Live daemon**: Start daemon, create session, verify file modifications detected
5. **UI rendering**: View session detail, verify tool icons and system tag stripping
6. **Database**: Query `agent_session_id` column, verify backfill worked
