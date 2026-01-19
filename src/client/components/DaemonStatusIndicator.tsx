import { useDaemonStatus } from "../hooks/useDaemonStatus";

interface DaemonStatusIndicatorProps {
  className?: string;
}

/**
 * Shows daemon connection status in the header.
 * Only visible when a daemon is connected.
 */
export function DaemonStatusIndicator({ className }: DaemonStatusIndicatorProps) {
  const status = useDaemonStatus();

  if (!status.connected) {
    return null; // Don't show anything when disconnected
  }

  const deviceName = status.clientId || "Unknown device";
  const truncatedName = deviceName.length > 20
    ? deviceName.slice(0, 20) + "..."
    : deviceName;

  return (
    <div
      className={`flex items-center gap-1.5 text-sm text-green-400 ${className || ""}`}
      title={`Connected to daemon on ${deviceName}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
      <span className="text-text-muted">@</span>
      <span>{truncatedName}</span>
    </div>
  );
}
