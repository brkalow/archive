/**
 * API client for communicating with the server's live streaming endpoints.
 * Includes retry logic with exponential backoff for resilience.
 *
 * Authentication:
 * - X-Openctl-Client-ID header is always sent for device identification
 * - Authorization: Bearer token is sent when authenticated (optional)
 */

import { getClientId } from "../lib/client-id";

interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
};

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = DEFAULT_RETRY
): Promise<Response> {
  const { maxRetries = 3, initialDelayMs = 1000, maxDelayMs = 10000 } = retryOptions;
  let lastError: Error | null = null;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);

      // Don't retry on client errors (4xx), only server errors (5xx) and network failures
      if (res.status < 500) {
        return res;
      }

      lastError = new Error(`Server error: ${res.status}`);
    } catch (err) {
      lastError = err as Error;
    }

    if (attempt < maxRetries) {
      console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw lastError || new Error("Request failed after retries");
}

// Request interfaces
export interface CreateLiveSessionRequest {
  title?: string;
  project_path: string;
  harness_session_id?: string;
  harness: string;
  model?: string;
  repo_url?: string;
}

export interface CompleteSessionRequest {
  final_diff?: string;
  summary?: string;
}

// Response interfaces
export interface CreateLiveSessionResponse {
  id: string;
  status: string;
  resumed: boolean;
  restored?: boolean;  // true if a completed session was restored to live
  message_count: number;
  last_index: number;
}

export interface PushMessagesResponse {
  appended: number;
  message_count: number;
  last_index: number;
}

export interface PushToolResultsResponse {
  appended: number;
  result_count: number;
}

export interface PushDiffResponse {
  updated: boolean;
  diff_size: number;
}

export interface CompleteSessionResponse {
  status: string;
  completed_at: string;
}

export interface UpdateSessionResponse {
  updated: boolean;
}

export interface MarkInteractiveResponse {
  success: boolean;
  interactive: boolean;
}

export class ApiClient {
  private baseUrl: string;
  private retryOptions: RetryOptions;
  private clientId: string;
  private authToken: string | null;

  constructor(baseUrl: string, retryOptions: RetryOptions = DEFAULT_RETRY, authToken?: string | null) {
    // Remove trailing slash if present
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.retryOptions = retryOptions;
    this.clientId = getClientId();
    this.authToken = authToken ?? null;
  }

  /**
   * Set the auth token for subsequent requests.
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  /**
   * Get common headers for all requests.
   * Client ID is used for device identification.
   * Auth token (if present) is used for user authentication.
   */
  private getHeaders(additionalHeaders: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Openctl-Client-ID": this.clientId,
      ...additionalHeaders,
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    return headers;
  }

  /**
   * Create a new live session.
   */
  async createLiveSession(
    data: CreateLiveSessionRequest
  ): Promise<CreateLiveSessionResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/live`,
      {
        method: "POST",
        headers: this.getHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(data),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to create live session: ${res.status} - ${error}`);
    }

    return res.json() as Promise<CreateLiveSessionResponse>;
  }

  /**
   * Push messages to a live session.
   */
  async pushMessages(
    sessionId: string,
    messages: unknown[]
  ): Promise<PushMessagesResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: this.getHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ messages }),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push messages: ${res.status} - ${error}`);
    }

    return res.json() as Promise<PushMessagesResponse>;
  }

  /**
   * Push tool results to a live session.
   */
  async pushToolResults(
    sessionId: string,
    results: unknown[]
  ): Promise<PushToolResultsResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/tool-results`,
      {
        method: "POST",
        headers: this.getHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ results }),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push tool results: ${res.status} - ${error}`);
    }

    return res.json() as Promise<PushToolResultsResponse>;
  }

  /**
   * Update the diff for a live session.
   */
  async pushDiff(
    sessionId: string,
    diff: string
  ): Promise<PushDiffResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/diff`,
      {
        method: "PUT",
        headers: this.getHeaders({
          "Content-Type": "text/plain",
        }),
        body: diff,
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push diff: ${res.status} - ${error}`);
    }

    return res.json() as Promise<PushDiffResponse>;
  }

  /**
   * Mark a live session as complete.
   */
  async completeSession(
    sessionId: string,
    data: CompleteSessionRequest = {}
  ): Promise<CompleteSessionResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/complete`,
      {
        method: "POST",
        headers: this.getHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(data),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to complete session: ${res.status} - ${error}`);
    }

    return res.json() as Promise<CompleteSessionResponse>;
  }

  /**
   * Update the session title.
   */
  async updateTitle(
    sessionId: string,
    title: string
  ): Promise<UpdateSessionResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}`,
      {
        method: "PATCH",
        headers: this.getHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ title }),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to update title: ${res.status} - ${error}`);
    }

    return res.json() as Promise<UpdateSessionResponse>;
  }

  /**
   * Mark a session as interactive (enables browser feedback).
   */
  async markInteractive(
    sessionId: string
  ): Promise<MarkInteractiveResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/interactive`,
      {
        method: "POST",
        headers: this.getHeaders(),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to mark session interactive: ${res.status} - ${error}`);
    }

    return res.json() as Promise<MarkInteractiveResponse>;
  }

  /**
   * Disable interactive mode for a session (called when daemon disconnects).
   */
  async disableInteractive(
    sessionId: string
  ): Promise<void> {
    // Use a short timeout since we're shutting down
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/interactive`,
      {
        method: "DELETE",
        headers: this.getHeaders(),
      },
      { maxRetries: 1, initialDelayMs: 500, maxDelayMs: 1000 }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to disable interactive: ${res.status} - ${error}`);
    }
  }

  /**
   * Delete a session (used for empty sessions that have no messages).
   */
  async deleteSession(
    sessionId: string
  ): Promise<void> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: this.getHeaders(),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to delete session: ${res.status} - ${error}`);
    }
  }
}
