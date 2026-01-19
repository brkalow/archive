/**
 * Desktop Notification Utilities
 *
 * Provides cross-platform desktop notifications for alerting users
 * about remote session events (session start, questions, etc.)
 */

import { basename } from "path";

interface NotificationOptions {
  title: string;
  message: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  viewUrl?: string;
}

// Cache whether terminal-notifier is available
let hasTerminalNotifier: boolean | null = null;

/**
 * Check if a command is available in PATH.
 */
async function checkCommand(cmd: string): Promise<boolean> {
  try {
    const result = Bun.spawnSync(["which", cmd]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Show a desktop notification when a remote session starts.
 * Uses native system notification mechanisms:
 * - macOS: terminal-notifier (preferred, with action buttons) or osascript (fallback)
 * - Linux: notify-send
 * - Windows: Not currently supported
 */
export async function notifySessionStarted(
  options: NotificationOptions
): Promise<void> {
  const { title, cwd, prompt, sessionId, viewUrl } = options;

  // Truncate long prompts
  const truncatedPrompt =
    prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;

  // Escape special characters for shell/AppleScript
  const escapedPrompt = escapeForNotification(truncatedPrompt);
  const escapedDir = escapeForNotification(basename(cwd));

  if (process.platform === "darwin") {
    await showMacOSNotification(title, escapedPrompt, escapedDir, sessionId, viewUrl);
  } else if (process.platform === "linux") {
    await showLinuxNotification(title, escapedPrompt, cwd);
  }
  // Windows: would need different approach (PowerShell or node-notifier)
}

/**
 * Show a notification on macOS.
 * Uses terminal-notifier if available (better UX with clickable notifications).
 * Falls back to osascript if terminal-notifier is not installed.
 */
async function showMacOSNotification(
  title: string,
  message: string,
  subtitle: string,
  sessionId: string,
  viewUrl?: string
): Promise<void> {
  try {
    // Check for terminal-notifier once and cache result
    if (hasTerminalNotifier === null) {
      hasTerminalNotifier = await checkCommand("terminal-notifier");
    }

    if (hasTerminalNotifier) {
      // Use terminal-notifier for better macOS notifications with actions
      const args = [
        "-title", title,
        "-subtitle", `Directory: ${subtitle}`,
        "-message", message,
        "-group", `openctl-${sessionId}`,
        "-sender", "com.apple.Terminal",
        "-appIcon", "https://claude.ai/favicon.ico",
      ];

      // Add click action to open the session view URL
      if (viewUrl) {
        args.push("-open", viewUrl);
      }

      const proc = Bun.spawn(["terminal-notifier", ...args], {
        stdout: "ignore",
        stderr: "ignore",
      });
      // Fire and forget
      proc.exited.catch(() => {});
    } else {
      // Fallback to osascript
      const script = `display notification "${message}" with title "${title}" subtitle "Directory: ${subtitle}"`;

      const proc = Bun.spawn(["osascript", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
      });
      // Fire and forget
      proc.exited.catch(() => {});
    }
  } catch (error) {
    console.error("[notification] Failed to show macOS notification:", error);
  }
}

/**
 * Show a notification on Linux using notify-send.
 */
async function showLinuxNotification(
  title: string,
  message: string,
  cwd: string
): Promise<void> {
  try {
    const proc = Bun.spawn(
      [
        "notify-send",
        title,
        `${message}\nDirectory: ${cwd}`,
        "--app-name=openctl",
        "--urgency=normal",
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    // Fire and forget
    proc.exited.catch(() => {});
  } catch (error) {
    console.error("[notification] Failed to show Linux notification:", error);
  }
}

/**
 * Escape special characters for use in notifications.
 * Handles quotes and backslashes that could break AppleScript or shell commands.
 */
function escapeForNotification(text: string): string {
  return text
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\n/g, " ") // Replace newlines with spaces
    .replace(/\r/g, ""); // Remove carriage returns
}
