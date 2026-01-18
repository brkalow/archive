import type { HarnessAdapter } from "./types";
import { DEFAULT_ADAPTER_ID } from "./types";
import { claudeCodeAdapter } from "./claude-code";

export const adapters: HarnessAdapter[] = [claudeCodeAdapter];

export function getAdapterForPath(filePath: string): HarnessAdapter | null {
  return adapters.find((a) => a.canHandle(filePath)) || null;
}

export function getAdapterById(id: string): HarnessAdapter | null {
  return adapters.find((a) => a.id === id) || null;
}

export function getEnabledAdapters(enabledIds?: string[]): HarnessAdapter[] {
  if (!enabledIds || enabledIds.length === 0) {
    return adapters;
  }
  return adapters.filter((a) => enabledIds.includes(a.id));
}

/**
 * Get adapter by ID, falling back to default if not found.
 */
export function getAdapterOrDefault(id: string): HarnessAdapter {
  const adapter = getAdapterById(id);
  if (adapter) return adapter;
  console.warn(`Adapter '${id}' not found, using default`);
  return getAdapterById(DEFAULT_ADAPTER_ID)!;
}

/**
 * Get file-modifying tools for an adapter (with fallback to common defaults).
 */
export function getFileModifyingToolsForAdapter(adapter: HarnessAdapter): string[] {
  return adapter.getFileModifyingTools?.() || ["Write", "Edit", "NotebookEdit"];
}

/**
 * Extract file path from a tool call using adapter method (with fallback).
 */
export function extractFilePathFromTool(
  adapter: HarnessAdapter,
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (adapter.extractFilePath) return adapter.extractFilePath(toolName, input);
  // Fallback for adapters without extractFilePath
  if (toolName === "Write" || toolName === "Edit") return input.file_path as string || null;
  if (toolName === "NotebookEdit") return input.notebook_path as string || null;
  return null;
}

// Re-export types for convenience
export type {
  ContentBlock,
  NormalizedMessage,
  SessionInfo,
  ParseContext,
  HarnessAdapter,
  ToolIconCategory,
  ToolConfig,
  SystemTagPattern,
  AdapterUIConfig,
} from "./types";

export { DEFAULT_ADAPTER_ID } from "./types";
