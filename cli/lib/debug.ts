/**
 * Simple debug logger that can be enabled via --verbose flag
 */

let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function isVerbose(): boolean {
  return verboseEnabled;
}

export function debug(...args: unknown[]): void {
  if (verboseEnabled) {
    console.log("  [DEBUG]", ...args);
  }
}
