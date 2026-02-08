/**
 * OpenCode TUI compatible type definitions.
 *
 * These match the shapes expected by the OpenCode TUI SDK and event reducer.
 * See opencode-compat-context.md for full documentation.
 */

// ============================================
// Session
// ============================================

export interface OCSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    archived?: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  share?: {
    url: string;
  };
}

// ============================================
// Messages
// ============================================

export interface OCAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  cost: number;
  finish?: string;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

export interface OCUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: {
    created: number;
  };
  agent: string;
  model: {
    providerID: string;
    modelID: string;
  };
}

export type OCMessage = OCAssistantMessage | OCUserMessage;

// ============================================
// Parts
// ============================================

interface PartBase {
  id: string;
  sessionID: string;
  messageID: string;
}

export interface OCTextPart extends PartBase {
  type: "text";
  text: string;
  time?: {
    start: number;
    end?: number;
  };
}

export interface OCReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
  time?: {
    start: number;
  };
}

export interface OCToolPart extends PartBase {
  type: "tool";
  callID: string;
  tool: string;
  state: OCToolState;
}

export interface OCStepStartPart extends PartBase {
  type: "step-start";
}

export interface OCStepFinishPart extends PartBase {
  type: "step-finish";
  reason: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

export type OCPart =
  | OCTextPart
  | OCReasoningPart
  | OCToolPart
  | OCStepStartPart
  | OCStepFinishPart;

// ============================================
// Tool States
// ============================================

export interface OCToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface OCToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  time: {
    start: number;
  };
}

export interface OCToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
}

export interface OCToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  time: {
    start: number;
    end: number;
  };
}

export type OCToolState =
  | OCToolStatePending
  | OCToolStateRunning
  | OCToolStateCompleted
  | OCToolStateError;

// ============================================
// FileDiff
// ============================================

export interface OCFileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

// ============================================
// Session Status
// ============================================

export type OCSessionStatus = { type: "busy" } | { type: "idle" };

// ============================================
// SSE Events
// ============================================

export interface OCEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface OCGlobalEvent {
  directory: string;
  payload: OCEvent;
}

// ============================================
// Message with Parts (API response)
// ============================================

export interface OCMessageWithParts {
  info: OCMessage;
  parts: OCPart[];
}

// ============================================
// Bootstrap types
// ============================================

export interface OCProvider {
  id: string;
  name: string;
  env: string[];
  models: OCModel[];
}

export interface OCModel {
  id: string;
  name: string;
  limit: {
    context: number;
    output: number;
  };
  attachment: boolean;
  family: string;
  release_date: string;
  capabilities: {
    interleaved: boolean;
  };
}

export interface OCConfigProvider {
  id: string;
  name: string;
  source: string;
  env: string[];
  models: Record<string, OCModel>;
}

export interface OCAgent {
  name: string;
  description: string;
  mode: string;
  native: boolean;
  options: Record<string, unknown>;
  permission: string[];
}

export interface OCProject {
  id: string;
  worktree: string;
  vcs: string;
  sandboxes: unknown[];
  time: {
    created: number;
    updated: number;
  };
}

// ============================================
// Permission / Question types
// ============================================

export interface OCPermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: boolean;
}

export interface OCQuestion {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    options?: string[];
    custom?: boolean;
  }>;
}
