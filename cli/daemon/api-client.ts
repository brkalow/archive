/**
 * API client for communicating with the archive server's live streaming endpoints.
 * Includes retry logic with exponential backoff for resilience.
 */

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
  stream_token: string;
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

export class ApiClient {
  private baseUrl: string;
  private retryOptions: RetryOptions;

  constructor(baseUrl: string, retryOptions: RetryOptions = DEFAULT_RETRY) {
    // Remove trailing slash if present
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.retryOptions = retryOptions;
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to create live session: ${res.status} - ${error}`);
    }

    return res.json();
  }

  /**
   * Push messages to a live session.
   */
  async pushMessages(
    sessionId: string,
    streamToken: string,
    messages: unknown[]
  ): Promise<PushMessagesResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${streamToken}`,
        },
        body: JSON.stringify({ messages }),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push messages: ${res.status} - ${error}`);
    }

    return res.json();
  }

  /**
   * Push tool results to a live session.
   */
  async pushToolResults(
    sessionId: string,
    streamToken: string,
    results: unknown[]
  ): Promise<PushToolResultsResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/tool-results`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${streamToken}`,
        },
        body: JSON.stringify({ results }),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push tool results: ${res.status} - ${error}`);
    }

    return res.json();
  }

  /**
   * Update the diff for a live session.
   */
  async pushDiff(
    sessionId: string,
    streamToken: string,
    diff: string
  ): Promise<PushDiffResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/diff`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${streamToken}`,
        },
        body: diff,
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push diff: ${res.status} - ${error}`);
    }

    return res.json();
  }

  /**
   * Mark a live session as complete.
   */
  async completeSession(
    sessionId: string,
    streamToken: string,
    data: CompleteSessionRequest = {}
  ): Promise<CompleteSessionResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${streamToken}`,
        },
        body: JSON.stringify(data),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to complete session: ${res.status} - ${error}`);
    }

    return res.json();
  }

  /**
   * Update the session title.
   */
  async updateTitle(
    sessionId: string,
    streamToken: string,
    title: string
  ): Promise<UpdateSessionResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/api/sessions/${sessionId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${streamToken}`,
        },
        body: JSON.stringify({ title }),
      },
      this.retryOptions
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to update title: ${res.status} - ${error}`);
    }

    return res.json();
  }
}
