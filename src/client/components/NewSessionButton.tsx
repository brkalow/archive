import { useState } from "react";
import { useDaemonStatus } from "../hooks/useDaemonStatus";
import { NewSessionModal } from "./NewSessionModal";

interface NewSessionButtonProps {
  className?: string;
}

/**
 * Button that appears when daemon is connected and can spawn sessions.
 * Opens the NewSessionModal on click.
 */
export function NewSessionButton({ className }: NewSessionButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const status = useDaemonStatus();

  if (!status.connected || !status.capabilities?.can_spawn_sessions) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className={`
          inline-flex items-center gap-2 px-4 py-2
          bg-accent-primary hover:bg-accent-primary/90 text-bg-primary
          rounded-md font-medium text-sm
          transition-colors
          ${className || ""}
        `}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4v16m8-8H4"
          />
        </svg>
        New Session
      </button>

      {isModalOpen && (
        <NewSessionModal
          daemonStatus={status}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  );
}
