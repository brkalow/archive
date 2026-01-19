import { useState, useEffect, useCallback } from "react";

export interface SpawnableHarness {
  id: string;
  name: string;
  available: boolean;
  supports_permission_relay: boolean;
  supports_streaming: boolean;
  default_model?: string;
}

export interface DaemonCapabilities {
  can_spawn_sessions: boolean;
  spawnable_harnesses: SpawnableHarness[];
}

export interface DaemonStatus {
  connected: boolean;
  clientId?: string;
  capabilities?: DaemonCapabilities;
}

/**
 * Hook to track daemon connection status via polling.
 * Returns the current daemon status and capabilities.
 */
export function useDaemonStatus(pollInterval = 5000): DaemonStatus {
  const [status, setStatus] = useState<DaemonStatus>({ connected: false });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/daemon/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      } else {
        setStatus({ connected: false });
      }
    } catch {
      setStatus({ connected: false });
    }
  }, []);

  useEffect(() => {
    fetchStatus();

    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, pollInterval]);

  return status;
}
