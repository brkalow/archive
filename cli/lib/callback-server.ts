/**
 * Local HTTP callback server for OAuth 2.0 CLI authentication.
 * Listens on localhost for the authorization code callback.
 */

import { createHmac, randomBytes } from "crypto";

const STATE_HMAC_KEY = randomBytes(32);

/**
 * Result of the OAuth callback.
 */
export interface CallbackResult {
  code: string;
  state: string;
}

/**
 * Options for creating a callback server.
 */
export interface CallbackServerOptions {
  /** Port to listen on. If 0, a random available port will be chosen. */
  port?: number;
  /** Timeout in milliseconds (default: 5 minutes). */
  timeout?: number;
}

/**
 * Find an available port for the callback server.
 */
export async function findAvailablePort(): Promise<number> {
  const server = Bun.serve({
    port: 0, // Let OS assign a port
    fetch() {
      return new Response("", { status: 404 });
    },
  });
  const port = server.port;
  server.stop();

  if (!port) {
    throw new Error("Failed to find available port");
  }

  return port;
}

/**
 * Sign a state parameter with HMAC to prevent CSRF attacks.
 * The state includes the port number to ensure the callback reaches the right server.
 */
export function signState(data: { port: number; nonce: string; timestamp: number }): string {
  const payload = JSON.stringify(data);
  const signature = createHmac("sha256", STATE_HMAC_KEY)
    .update(payload)
    .digest("hex");

  // Encode as base64url: payload.signature
  const encodedPayload = Buffer.from(payload).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

/**
 * Validate and parse a signed state parameter.
 * Returns the parsed data if valid, or throws an error.
 */
export function validateState(state: string): { port: number; nonce: string; timestamp: number } {
  const [encodedPayload, signature] = state.split(".");

  if (!encodedPayload || !signature) {
    throw new Error("Invalid state format");
  }

  const payload = Buffer.from(encodedPayload, "base64url").toString();
  const expectedSignature = createHmac("sha256", STATE_HMAC_KEY)
    .update(payload)
    .digest("hex");

  if (signature !== expectedSignature) {
    throw new Error("Invalid state signature");
  }

  const data = JSON.parse(payload);

  // Check timestamp is not too old (max 10 minutes)
  if (Date.now() - data.timestamp > 10 * 60 * 1000) {
    throw new Error("State expired");
  }

  return data;
}

/**
 * Create a local HTTP server to receive the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
export function createCallbackServer(
  port: number,
  options: { timeout?: number } = {}
): { promise: Promise<CallbackResult>; server: ReturnType<typeof Bun.serve>; stop: () => void } {
  const { timeout = 5 * 60 * 1000 } = options;

  let resolveCallback: (result: CallbackResult) => void;
  let rejectCallback: (error: Error) => void;

  const promise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const timeoutId = setTimeout(() => {
    rejectCallback(new Error("OAuth callback timed out. Please try again."));
    server.stop();
  }, timeout);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        clearTimeout(timeoutId);

        if (error) {
          const errorMessage = errorDescription || error;
          rejectCallback(new Error(`OAuth error: ${errorMessage}`));
          return new Response(getErrorPage(errorMessage), {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code || !state) {
          rejectCallback(new Error("Missing code or state in callback"));
          return new Response(getErrorPage("Missing authorization code"), {
            headers: { "Content-Type": "text/html" },
          });
        }

        resolveCallback({ code, state });
        return new Response(getSuccessPage(), {
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const stop = () => {
    clearTimeout(timeoutId);
    server.stop();
  };

  return { promise, server, stop };
}

/**
 * HTML page shown on successful authentication.
 */
function getSuccessPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
    .container { background: white; border-radius: 12px; padding: 40px; max-width: 400px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #22c55e; margin-bottom: 16px; }
    p { color: #666; }
    .icon { font-size: 48px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10003;</div>
    <h1>Authentication Successful!</h1>
    <p>You can close this tab and return to the terminal.</p>
  </div>
</body>
</html>`;
}

/**
 * HTML page shown on authentication error.
 */
function getErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authentication Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
    .container { background: white; border-radius: 12px; padding: 40px; max-width: 400px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #ef4444; margin-bottom: 16px; }
    p { color: #666; }
    .icon { font-size: 48px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10060;</div>
    <h1>Authentication Failed</h1>
    <p>${escapeHtml(message)}</p>
    <p>Please return to the terminal and try again.</p>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
