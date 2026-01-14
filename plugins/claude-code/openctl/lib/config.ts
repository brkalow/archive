export interface OpenctlConfig {
  serverUrl: string;
}

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  // UserPromptSubmit hook includes the user's prompt
  user_prompt?: string;
}

/**
 * Load openctl configuration from environment variables.
 * These are set by openctl when starting a Claude Code session.
 *
 * Note: Session ID is NOT loaded from env vars - it's read from stdin
 * which Claude Code provides to hooks.
 */
export function loadConfig(): OpenctlConfig | null {
  const serverUrl = process.env.OPENCTL_SERVER_URL;

  if (!serverUrl) {
    return null;
  }

  return { serverUrl };
}

/**
 * Read and parse the hook input from stdin.
 * Claude Code passes JSON to hooks via stdin containing session_id and other context.
 */
export async function readStdinInput(): Promise<HookInput | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString("utf-8").trim();
    if (!input) {
      return null;
    }
    return JSON.parse(input) as HookInput;
  } catch {
    return null;
  }
}
