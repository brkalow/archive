import { useState, useCallback, useEffect } from 'react';
import type { CollaboratorRole, SessionVisibility } from '../../db/schema';

export interface Collaborator {
  id: number;
  email: string;
  role: CollaboratorRole;
  status: 'invited' | 'active';
  invited_at: string;
  accepted_at: string | null;
  user: {
    name: string | null;
    email: string | null;
    imageUrl: string | null;
  } | null;
}

export interface AuditLogEntry {
  id: number;
  action: string;
  actor_user_id: string;
  target_email: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
  actor: {
    name: string | null;
    email: string | null;
    imageUrl: string | null;
  } | null;
}

interface UseCollaboratorsResult {
  collaborators: Collaborator[];
  visibility: SessionVisibility;
  auditLogs: AuditLogEntry[];
  loading: boolean;
  error: string | null;
  addCollaborator: (email: string, role: CollaboratorRole) => Promise<boolean>;
  updateCollaboratorRole: (id: number, role: CollaboratorRole) => Promise<boolean>;
  removeCollaborator: (id: number) => Promise<boolean>;
  setVisibility: (visibility: SessionVisibility) => Promise<boolean>;
  refreshCollaborators: () => Promise<void>;
  refreshAuditLogs: () => Promise<void>;
}

export function useCollaborators(sessionId: string): UseCollaboratorsResult {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [visibility, setVisibilityState] = useState<SessionVisibility>('private');
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshCollaborators = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/collaborators`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setCollaborators(data.collaborators || []);
        setVisibilityState(data.visibility || 'private');
        setError(data.error || null);
      } else if (res.status === 403) {
        setError('You do not have permission to view collaborators');
      } else {
        setError('Failed to load collaborators');
      }
    } catch {
      setError('Failed to load collaborators');
    }
  }, [sessionId]);

  const refreshAuditLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/audit`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.logs || []);
      }
    } catch {
      // Silently fail for audit logs
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([refreshCollaborators(), refreshAuditLogs()]).finally(() => {
      setLoading(false);
    });
  }, [refreshCollaborators, refreshAuditLogs]);

  const addCollaborator = useCallback(async (email: string, role: CollaboratorRole): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/collaborators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, role }),
      });

      if (res.ok) {
        await Promise.all([refreshCollaborators(), refreshAuditLogs()]);
        return true;
      }

      const data = await res.json();
      setError(data.error || 'Failed to add collaborator');
      return false;
    } catch {
      setError('Failed to add collaborator');
      return false;
    }
  }, [sessionId, refreshCollaborators, refreshAuditLogs]);

  const updateCollaboratorRole = useCallback(async (id: number, role: CollaboratorRole): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/collaborators/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role }),
      });

      if (res.ok) {
        await Promise.all([refreshCollaborators(), refreshAuditLogs()]);
        return true;
      }

      const data = await res.json();
      setError(data.error || 'Failed to update role');
      return false;
    } catch {
      setError('Failed to update role');
      return false;
    }
  }, [sessionId, refreshCollaborators, refreshAuditLogs]);

  const removeCollaborator = useCallback(async (id: number): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/collaborators/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        await Promise.all([refreshCollaborators(), refreshAuditLogs()]);
        return true;
      }

      const data = await res.json();
      setError(data.error || 'Failed to remove collaborator');
      return false;
    } catch {
      setError('Failed to remove collaborator');
      return false;
    }
  }, [sessionId, refreshCollaborators, refreshAuditLogs]);

  const setVisibility = useCallback(async (newVisibility: SessionVisibility): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/visibility`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ visibility: newVisibility }),
      });

      if (res.ok) {
        setVisibilityState(newVisibility);
        await refreshAuditLogs();
        return true;
      }

      const data = await res.json();
      setError(data.error || 'Failed to update visibility');
      return false;
    } catch {
      setError('Failed to update visibility');
      return false;
    }
  }, [sessionId, refreshAuditLogs]);

  return {
    collaborators,
    visibility,
    auditLogs,
    loading,
    error,
    addCollaborator,
    updateCollaboratorRole,
    removeCollaborator,
    setVisibility,
    refreshCollaborators,
    refreshAuditLogs,
  };
}
