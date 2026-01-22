import { useState, useCallback, useEffect, useRef } from 'react';
import { useCollaborators, type Collaborator, type AuditLogEntry } from '../hooks/useCollaborators';
import type { CollaboratorRole, SessionVisibility } from '../../db/schema';

interface ShareModalProps {
  sessionId: string;
  shareUrl: string | null;
  isOwner: boolean;
  onClose: () => void;
  onCopy: (text: string) => void;
  onCreateShareLink: () => Promise<void>;
}

type Tab = 'people' | 'link' | 'activity';

export function ShareModal({
  sessionId,
  shareUrl,
  isOwner,
  onClose,
  onCopy,
  onCreateShareLink,
}: ShareModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('people');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<CollaboratorRole>('viewer');
  const [isAdding, setIsAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    collaborators,
    visibility,
    auditLogs,
    loading,
    error,
    addCollaborator,
    updateCollaboratorRole,
    removeCollaborator,
    setVisibility,
  } = useCollaborators(sessionId);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus input when modal opens
  useEffect(() => {
    if (activeTab === 'people') {
      inputRef.current?.focus();
    }
  }, [activeTab]);

  const handleAddCollaborator = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim() || !isOwner) return;

    setIsAdding(true);
    const success = await addCollaborator(newEmail.trim(), newRole);
    setIsAdding(false);

    if (success) {
      setNewEmail('');
      setNewRole('viewer');
    }
  }, [newEmail, newRole, isOwner, addCollaborator]);

  const handleVisibilityChange = useCallback(async (newVisibility: SessionVisibility) => {
    if (!isOwner) return;
    await setVisibility(newVisibility);
  }, [isOwner, setVisibility]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-secondary border border-bg-elevated rounded-lg w-full max-w-xl mx-4 shadow-xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-bg-elevated shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">Share Session</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors p-1 rounded"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-bg-elevated px-6 shrink-0">
          <TabButton active={activeTab === 'people'} onClick={() => setActiveTab('people')}>
            People
          </TabButton>
          <TabButton active={activeTab === 'link'} onClick={() => setActiveTab('link')}>
            Link
          </TabButton>
          <TabButton active={activeTab === 'activity'} onClick={() => setActiveTab('activity')}>
            Activity
          </TabButton>
        </div>

        {/* Content */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {error && (
            <div className="p-3 mb-4 bg-diff-del/20 border border-diff-del/30 rounded-md text-diff-del text-sm">
              {error}
            </div>
          )}

          {activeTab === 'people' && (
            <PeopleTab
              collaborators={collaborators}
              visibility={visibility}
              loading={loading}
              isOwner={isOwner}
              newEmail={newEmail}
              newRole={newRole}
              isAdding={isAdding}
              inputRef={inputRef}
              onEmailChange={setNewEmail}
              onRoleChange={setNewRole}
              onAdd={handleAddCollaborator}
              onUpdateRole={updateCollaboratorRole}
              onRemove={removeCollaborator}
              onVisibilityChange={handleVisibilityChange}
            />
          )}

          {activeTab === 'link' && (
            <LinkTab
              shareUrl={shareUrl}
              visibility={visibility}
              onCopy={onCopy}
              onCreateShareLink={onCreateShareLink}
            />
          )}

          {activeTab === 'activity' && (
            <ActivityTab logs={auditLogs} loading={loading} />
          )}
        </div>
      </div>
    </div>
  );
}

// Tab Button
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-accent-primary text-text-primary'
          : 'border-transparent text-text-muted hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

// People Tab
interface PeopleTabProps {
  collaborators: Collaborator[];
  visibility: SessionVisibility;
  loading: boolean;
  isOwner: boolean;
  newEmail: string;
  newRole: CollaboratorRole;
  isAdding: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onEmailChange: (email: string) => void;
  onRoleChange: (role: CollaboratorRole) => void;
  onAdd: (e: React.FormEvent) => void;
  onUpdateRole: (id: number, role: CollaboratorRole) => Promise<boolean>;
  onRemove: (id: number) => Promise<boolean>;
  onVisibilityChange: (visibility: SessionVisibility) => void;
}

function PeopleTab({
  collaborators,
  visibility,
  loading,
  isOwner,
  newEmail,
  newRole,
  isAdding,
  inputRef,
  onEmailChange,
  onRoleChange,
  onAdd,
  onUpdateRole,
  onRemove,
  onVisibilityChange,
}: PeopleTabProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Visibility Toggle */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-2">
          Session visibility
        </label>
        <div className="flex gap-2">
          <VisibilityButton
            active={visibility === 'private'}
            disabled={!isOwner}
            onClick={() => onVisibilityChange('private')}
            icon={<LockIcon />}
            label="Private"
            description="Only you and collaborators"
          />
          <VisibilityButton
            active={visibility === 'public'}
            disabled={!isOwner}
            onClick={() => onVisibilityChange('public')}
            icon={<GlobeIcon />}
            label="Public"
            description="Anyone with the link"
          />
        </div>
      </div>

      {/* Add collaborator form */}
      {isOwner && (
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            Add people
          </label>
          <form onSubmit={onAdd} className="flex gap-2">
            <input
              ref={inputRef}
              type="email"
              value={newEmail}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder="Email address"
              className="flex-1 px-3 py-2 bg-bg-tertiary border border-bg-elevated rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
              disabled={isAdding}
            />
            <select
              value={newRole}
              onChange={(e) => onRoleChange(e.target.value as CollaboratorRole)}
              className="px-3 py-2 bg-bg-tertiary border border-bg-elevated rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
              disabled={isAdding}
            >
              <option value="viewer">Viewer</option>
              <option value="contributor">Contributor</option>
            </select>
            <button
              type="submit"
              disabled={!newEmail.trim() || isAdding}
              className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 text-bg-primary rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAdding ? 'Adding...' : 'Add'}
            </button>
          </form>
        </div>
      )}

      {/* Collaborator list */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-2">
          People with access
        </label>
        {collaborators.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">
            No collaborators yet. Add people by email above.
          </p>
        ) : (
          <div className="space-y-2">
            {collaborators.map((collaborator) => (
              <CollaboratorRow
                key={collaborator.id}
                collaborator={collaborator}
                isOwner={isOwner}
                onUpdateRole={onUpdateRole}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Collaborator Row
interface CollaboratorRowProps {
  collaborator: Collaborator;
  isOwner: boolean;
  onUpdateRole: (id: number, role: CollaboratorRole) => Promise<boolean>;
  onRemove: (id: number) => Promise<boolean>;
}

function CollaboratorRow({ collaborator, isOwner, onUpdateRole, onRemove }: CollaboratorRowProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const handleRoleChange = async (role: CollaboratorRole) => {
    setIsUpdating(true);
    await onUpdateRole(collaborator.id, role);
    setIsUpdating(false);
  };

  const handleRemove = async () => {
    setIsUpdating(true);
    await onRemove(collaborator.id);
    setIsUpdating(false);
    setShowRemoveConfirm(false);
  };

  const displayName = collaborator.user?.name || collaborator.email;
  const initials = getInitials(displayName);

  return (
    <div className="flex items-center gap-3 p-2 rounded-md hover:bg-bg-tertiary/50 transition-colors">
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full bg-bg-tertiary flex items-center justify-center text-sm font-medium text-text-secondary shrink-0">
        {collaborator.user?.imageUrl ? (
          <img
            src={collaborator.user.imageUrl}
            alt={displayName}
            className="w-8 h-8 rounded-full"
          />
        ) : (
          initials
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">
            {displayName}
          </span>
          {collaborator.status === 'invited' && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-900/50 text-amber-300 rounded">
              Pending
            </span>
          )}
        </div>
        {collaborator.user?.name && (
          <span className="text-xs text-text-muted truncate block">
            {collaborator.email}
          </span>
        )}
      </div>

      {/* Role / Actions */}
      {isOwner ? (
        <div className="flex items-center gap-2">
          <select
            value={collaborator.role}
            onChange={(e) => handleRoleChange(e.target.value as CollaboratorRole)}
            disabled={isUpdating}
            className="px-2 py-1 text-xs bg-bg-tertiary border border-bg-elevated rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-primary"
          >
            <option value="viewer">Viewer</option>
            <option value="contributor">Contributor</option>
          </select>
          {showRemoveConfirm ? (
            <div className="flex items-center gap-1">
              <button
                onClick={handleRemove}
                disabled={isUpdating}
                className="px-2 py-1 text-xs bg-diff-del hover:bg-red-500 text-white rounded font-medium"
              >
                Remove
              </button>
              <button
                onClick={() => setShowRemoveConfirm(false)}
                className="px-2 py-1 text-xs text-text-muted hover:text-text-primary"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowRemoveConfirm(true)}
              className="p-1 text-text-muted hover:text-diff-del transition-colors rounded"
              title="Remove"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      ) : (
        <span className="text-xs text-text-muted capitalize">{collaborator.role}</span>
      )}
    </div>
  );
}

// Visibility Button
interface VisibilityButtonProps {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
}

function VisibilityButton({ active, disabled, onClick, icon, label, description }: VisibilityButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 p-3 rounded-md border transition-colors text-left ${
        active
          ? 'border-accent-primary bg-accent-primary/10'
          : 'border-bg-elevated hover:border-text-muted'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={active ? 'text-accent-primary' : 'text-text-muted'}>{icon}</span>
        <span className="text-sm font-medium text-text-primary">{label}</span>
      </div>
      <span className="text-xs text-text-muted">{description}</span>
    </button>
  );
}

// Link Tab
interface LinkTabProps {
  shareUrl: string | null;
  visibility: SessionVisibility;
  onCopy: (text: string) => void;
  onCreateShareLink: () => Promise<void>;
}

function LinkTab({ shareUrl, visibility, onCopy, onCreateShareLink }: LinkTabProps) {
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    await onCreateShareLink();
    setCreating(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-2">
          Share link
        </label>
        {shareUrl ? (
          <div className="flex items-center gap-2 p-3 bg-bg-tertiary rounded-md">
            <code className="flex-1 text-sm font-mono text-diff-add truncate">
              {shareUrl}
            </code>
            <button
              onClick={() => onCopy(shareUrl)}
              className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-bg-primary text-sm rounded font-medium transition-colors"
            >
              Copy
            </button>
          </div>
        ) : (
          <div className="p-4 bg-bg-tertiary rounded-md text-center">
            <p className="text-sm text-text-muted mb-3">
              Create a link that anyone can use to view this session.
            </p>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 text-bg-primary rounded-md font-medium transition-colors disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create share link'}
            </button>
          </div>
        )}
      </div>

      <div className="p-4 bg-bg-tertiary/50 rounded-md">
        <h4 className="text-sm font-medium text-text-primary mb-2">Link permissions</h4>
        <p className="text-xs text-text-muted">
          {visibility === 'public'
            ? 'Anyone with the link can view this session.'
            : 'Only people you add as collaborators can access this session. The share link provides read-only access.'}
        </p>
      </div>
    </div>
  );
}

// Activity Tab
interface ActivityTabProps {
  logs: AuditLogEntry[];
  loading: boolean;
}

function ActivityTab({ logs, loading }: ActivityTabProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <p className="text-sm text-text-muted py-8 text-center">
        No activity yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => (
        <ActivityLogItem key={log.id} log={log} />
      ))}
    </div>
  );
}

function ActivityLogItem({ log }: { log: AuditLogEntry }) {
  const actorName = log.actor?.name || log.actor?.email || 'Unknown user';
  const date = new Date(log.created_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const getMessage = () => {
    switch (log.action) {
      case 'collaborator_added':
        return (
          <>
            added <span className="font-medium text-text-primary">{log.target_email}</span> as{' '}
            <span className="font-medium">{log.new_value}</span>
          </>
        );
      case 'collaborator_removed':
        return (
          <>
            removed <span className="font-medium text-text-primary">{log.target_email}</span>
          </>
        );
      case 'collaborator_role_changed':
        return (
          <>
            changed <span className="font-medium text-text-primary">{log.target_email}</span>'s role from{' '}
            <span className="font-medium">{log.old_value}</span> to{' '}
            <span className="font-medium">{log.new_value}</span>
          </>
        );
      case 'visibility_changed':
        return (
          <>
            changed visibility from{' '}
            <span className="font-medium">{log.old_value}</span> to{' '}
            <span className="font-medium">{log.new_value}</span>
          </>
        );
      default:
        return log.action;
    }
  };

  return (
    <div className="flex gap-3 py-2">
      <div className="w-6 h-6 rounded-full bg-bg-tertiary flex items-center justify-center text-[10px] font-medium text-text-secondary shrink-0 mt-0.5">
        {log.actor?.imageUrl ? (
          <img src={log.actor.imageUrl} alt={actorName} className="w-6 h-6 rounded-full" />
        ) : (
          getInitials(actorName)
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-muted">
          <span className="font-medium text-text-primary">{actorName}</span>{' '}
          {getMessage()}
        </p>
        <span className="text-xs text-text-muted">{date}</span>
      </div>
    </div>
  );
}

// Icons
function LockIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

// Helpers
function getInitials(name: string): string {
  const parts = name.split(/[\s@]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
