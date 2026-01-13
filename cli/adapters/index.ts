import type { HarnessAdapter } from "./types";
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

// Re-export types for convenience
export type {
  ContentBlock,
  NormalizedMessage,
  SessionInfo,
  ParseContext,
  HarnessAdapter,
} from "./types";
