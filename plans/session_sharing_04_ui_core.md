# Session Sharing Plan 4: Share Modal UI - Core

Implementation plan for the core Share Modal UI components. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

**Prereqs:** Plan 3 (API endpoints)

## Overview

This plan implements the Share Modal with collaborator management and visibility controls. The design is inspired by Notion's share menu.

## Tasks

### 4.1 Create API hooks for sharing

Create `src/client/hooks/useCollaborators.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';

export interface Collaborator {
  id: number;
  email: string;
  user_id: string | null;
  role: 'viewer' | 'contributor';
  status: 'invited' | 'active';
  created_at: string;
  accepted_at: string | null;
  name: string | null;
  image_url: string | null;
}

interface UseCollaboratorsReturn {
  collaborators: Collaborator[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addCollaborator: (email: string, role: 'viewer' | 'contributor') => Promise<Collaborator>;
  updateRole: (collaboratorId: number, role: 'viewer' | 'contributor') => Promise<void>;
  removeCollaborator: (collaboratorId: number) => Promise<void>;
}

export function useCollaborators(sessionId: string): UseCollaboratorsReturn {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/collaborators`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load collaborators');
      const data = await res.json();
      setCollaborators(data.collaborators);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addCollaborator = async (email: string, role: 'viewer' | 'contributor'): Promise<Collaborator> => {
    const res = await fetch(`/api/sessions/${sessionId}/collaborators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, role }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.message || 'Failed to add collaborator');
    }

    const collaborator = await res.json();
    await refresh();
    return collaborator;
  };

  const updateRole = async (collaboratorId: number, role: 'viewer' | 'contributor') => {
    const res = await fetch(`/api/sessions/${sessionId}/collaborators/${collaboratorId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.message || 'Failed to update role');
    }

    await refresh();
  };

  const removeCollaborator = async (collaboratorId: number) => {
    const res = await fetch(`/api/sessions/${sessionId}/collaborators/${collaboratorId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!res.ok && res.status !== 204) {
      const data = await res.json();
      throw new Error(data.message || 'Failed to remove collaborator');
    }

    await refresh();
  };

  return {
    collaborators,
    loading,
    error,
    refresh,
    addCollaborator,
    updateRole,
    removeCollaborator,
  };
}
```

### 4.2 Create visibility hook

Create `src/client/hooks/useSessionVisibility.ts`:

```typescript
import { useState, useCallback } from 'react';
import type { Session } from '@/db/schema';

interface UseSessionVisibilityReturn {
  visibility: 'private' | 'public';
  updating: boolean;
  error: string | null;
  setVisibility: (visibility: 'private' | 'public') => Promise<void>;
}

export function useSessionVisibility(session: Session): UseSessionVisibilityReturn {
  const [visibility, setVisibilityState] = useState(session.visibility);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setVisibility = useCallback(async (newVisibility: 'private' | 'public') => {
    setUpdating(true);
    setError(null);

    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ visibility: newVisibility }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to update visibility');
      }

      setVisibilityState(newVisibility);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      throw err;
    } finally {
      setUpdating(false);
    }
  }, [session.id]);

  return {
    visibility,
    updating,
    error,
    setVisibility,
  };
}
```

### 4.3 Create Share Modal component

Create `src/client/components/ShareModal.tsx`:

```tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CollaboratorList } from './CollaboratorList';
import { CollaboratorInvite } from './CollaboratorInvite';
import { VisibilitySelector } from './VisibilitySelector';
import { CopyLinkButton } from './CopyLinkButton';
import { useCollaborators } from '@/hooks/useCollaborators';
import { useSessionVisibility } from '@/hooks/useSessionVisibility';
import type { Session } from '@/db/schema';

interface ShareModalProps {
  session: Session;
  isOwner: boolean;
  ownerEmail: string | null;
  ownerName: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export function ShareModal({
  session,
  isOwner,
  ownerEmail,
  ownerName,
  isOpen,
  onClose,
}: ShareModalProps) {
  const [activeTab, setActiveTab] = useState<'share' | 'publish'>('share');

  const {
    collaborators,
    loading,
    error,
    refresh,
    addCollaborator,
    updateRole,
    removeCollaborator,
  } = useCollaborators(session.id);

  const {
    visibility,
    updating: visibilityUpdating,
    error: visibilityError,
    setVisibility,
  } = useSessionVisibility(session);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Share</span>
            {/* Publish tab could go here as a tab switcher */}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'share' | 'publish')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="share">Share</TabsTrigger>
            <TabsTrigger value="publish">Publish</TabsTrigger>
          </TabsList>

          <TabsContent value="share" className="space-y-6 mt-4">
            {/* Invite section - only for owner */}
            {isOwner && (
              <CollaboratorInvite
                onInvite={addCollaborator}
              />
            )}

            {/* People with access section */}
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                People with access
              </h3>
              <CollaboratorList
                collaborators={collaborators}
                loading={loading}
                error={error}
                isOwner={isOwner}
                ownerEmail={ownerEmail}
                ownerName={ownerName}
                onUpdateRole={updateRole}
                onRemove={removeCollaborator}
                onRetry={refresh}
              />
            </div>

            {/* Visibility section */}
            <div className="border-t pt-4">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                General access
              </h3>
              <VisibilitySelector
                visibility={visibility}
                isRemote={session.remote}
                isOwner={isOwner}
                updating={visibilityUpdating}
                error={visibilityError}
                onChange={setVisibility}
              />
            </div>

            {/* Copy link */}
            <div className="flex justify-end">
              <CopyLinkButton
                sessionId={session.id}
                visibility={visibility}
              />
            </div>
          </TabsContent>

          <TabsContent value="publish" className="mt-4">
            {/* Legacy share token UI - existing functionality */}
            <p className="text-sm text-muted-foreground">
              Generate a shareable link for this session.
            </p>
            {/* Existing publish/share token UI goes here */}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
```

### 4.4 Create CollaboratorInvite component

Create `src/client/components/CollaboratorInvite.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface CollaboratorInviteProps {
  onInvite: (email: string, role: 'viewer' | 'contributor') => Promise<void>;
}

export function CollaboratorInvite({ onInvite }: CollaboratorInviteProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'contributor'>('viewer');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !isValidEmail(email)) {
      setError('Enter a valid email address');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onInvite(email.trim(), role);
      setEmail('');
      // Toast: "Invitation sent to {email}"
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          disabled={loading}
          className="flex-1"
          aria-label="Email address to invite"
        />
        <Select value={role} onValueChange={(v) => setRole(v as 'viewer' | 'contributor')}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="viewer">Viewer</SelectItem>
            <SelectItem value="contributor">Contributor</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={loading || !email.trim()}>
          {loading ? 'Inviting...' : 'Invite'}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </form>
  );
}
```

### 4.5 Create CollaboratorList component

Create `src/client/components/CollaboratorList.tsx`:

```tsx
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, Mail, User } from 'lucide-react';
import type { Collaborator } from '@/hooks/useCollaborators';

interface CollaboratorListProps {
  collaborators: Collaborator[];
  loading: boolean;
  error: string | null;
  isOwner: boolean;
  ownerEmail: string | null;
  ownerName: string | null;
  onUpdateRole: (id: number, role: 'viewer' | 'contributor') => Promise<void>;
  onRemove: (id: number) => Promise<void>;
  onRetry: () => void;
}

export function CollaboratorList({
  collaborators,
  loading,
  error,
  isOwner,
  ownerEmail,
  ownerName,
  onUpdateRole,
  onRemove,
  onRetry,
}: CollaboratorListProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-9 w-24" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground mb-3">Failed to load collaborators</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const isEmpty = collaborators.length === 0;

  return (
    <div className="space-y-1">
      {/* Owner row - always first */}
      <CollaboratorRow
        email={ownerEmail || 'Unknown'}
        name={ownerName}
        imageUrl={null}
        role="owner"
        status="active"
        isOwner={true}
        canEdit={false}
        onUpdateRole={() => {}}
        onRemove={() => {}}
      />

      {/* Collaborator rows */}
      {collaborators.map((collab) => (
        <CollaboratorRow
          key={collab.id}
          email={collab.email}
          name={collab.name}
          imageUrl={collab.image_url}
          role={collab.role}
          status={collab.status}
          isOwner={false}
          canEdit={isOwner}
          onUpdateRole={(role) => onUpdateRole(collab.id, role)}
          onRemove={() => onRemove(collab.id)}
        />
      ))}

      {/* Empty state */}
      {isEmpty && (
        <div className="flex flex-col items-center py-8 text-center">
          <User className="h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-sm font-medium">No collaborators yet</p>
          <p className="text-sm text-muted-foreground">
            Share this session by inviting people via email above.
          </p>
        </div>
      )}
    </div>
  );
}

interface CollaboratorRowProps {
  email: string;
  name: string | null;
  imageUrl: string | null;
  role: 'viewer' | 'contributor' | 'owner';
  status: 'invited' | 'active';
  isOwner: boolean;
  canEdit: boolean;
  onUpdateRole: (role: 'viewer' | 'contributor') => void;
  onRemove: () => void;
}

function CollaboratorRow({
  email,
  name,
  imageUrl,
  role,
  status,
  isOwner,
  canEdit,
  onUpdateRole,
  onRemove,
}: CollaboratorRowProps) {
  const [updating, setUpdating] = useState(false);

  const handleRoleChange = async (newRole: string) => {
    if (newRole === 'remove') {
      setUpdating(true);
      try {
        await onRemove();
      } finally {
        setUpdating(false);
      }
      return;
    }

    setUpdating(true);
    try {
      await onUpdateRole(newRole as 'viewer' | 'contributor');
    } finally {
      setUpdating(false);
    }
  };

  const initials = name
    ? name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : email[0].toUpperCase();

  return (
    <div className={`flex items-center gap-3 py-2 px-2 rounded-md ${isOwner ? 'bg-accent/50' : ''}`}>
      <Avatar className="h-10 w-10">
        {imageUrl && <AvatarImage src={imageUrl} alt={name || email} />}
        <AvatarFallback>
          {status === 'invited' ? <Mail className="h-4 w-4" /> : initials}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">
            {name || email}
          </span>
          {isOwner && (
            <span className="text-xs text-muted-foreground">(you)</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {name && <span className="truncate">{email}</span>}
          {status === 'invited' && (
            <span className="text-amber-600 text-xs">Invited · Pending</span>
          )}
        </div>
      </div>

      {role === 'owner' ? (
        <span className="text-sm text-muted-foreground px-3">Owner</span>
      ) : canEdit ? (
        <Select
          value={role}
          onValueChange={handleRoleChange}
          disabled={updating}
        >
          <SelectTrigger className="w-[130px]" aria-label={`Change role for ${name || email}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="viewer">Viewer</SelectItem>
            <SelectItem value="contributor">Contributor</SelectItem>
            <SelectItem value="remove" className="text-destructive">Remove</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <span className="text-sm text-muted-foreground px-3 capitalize">{role}</span>
      )}
    </div>
  );
}
```

### 4.6 Create VisibilitySelector component

Create `src/client/components/VisibilitySelector.tsx`:

```tsx
import { useState } from 'react';
import { Globe, Lock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface VisibilitySelectorProps {
  visibility: 'private' | 'public';
  isRemote: boolean;
  isOwner: boolean;
  updating: boolean;
  error: string | null;
  onChange: (visibility: 'private' | 'public') => Promise<void>;
}

export function VisibilitySelector({
  visibility,
  isRemote,
  isOwner,
  updating,
  error,
  onChange,
}: VisibilitySelectorProps) {
  const [confirmDialog, setConfirmDialog] = useState<'private' | null>(null);

  const handleChange = async (newVisibility: string) => {
    if (newVisibility === 'private' && visibility === 'public') {
      // Show confirmation dialog when making private
      setConfirmDialog('private');
      return;
    }

    await onChange(newVisibility as 'private' | 'public');
  };

  const confirmMakePrivate = async () => {
    setConfirmDialog(null);
    await onChange('private');
  };

  const isDisabled = !isOwner || updating || isRemote;

  return (
    <>
      <div className="flex items-start gap-3 p-3 border rounded-lg">
        <div className="mt-0.5">
          {visibility === 'public' ? (
            <Globe className="h-5 w-5 text-muted-foreground" />
          ) : (
            <Lock className="h-5 w-5 text-muted-foreground" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            {isDisabled ? (
              <span className="font-medium">
                {visibility === 'public' ? 'Public' : 'Private'}
              </span>
            ) : (
              <Select
                value={visibility}
                onValueChange={handleChange}
                disabled={isDisabled}
              >
                <SelectTrigger className="w-auto border-0 p-0 h-auto font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">
                    <div className="flex items-center gap-2">
                      <Lock className="h-4 w-4" />
                      Private
                    </div>
                  </SelectItem>
                  <SelectItem value="public">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      Public
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          <p className="text-sm text-muted-foreground mt-0.5">
            {visibility === 'public'
              ? 'Anyone with the link can view'
              : 'Only people with access can view'}
          </p>

          {isRemote && (
            <p className="text-xs text-amber-600 mt-1">
              Remote sessions cannot be made public
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive mt-1">{error}</p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDialog === 'private'}
        onOpenChange={(open) => !open && setConfirmDialog(null)}
        title="Make this session private?"
        description="Anyone viewing via public link will lose access. Collaborators will keep their access."
        confirmText="Make Private"
        onConfirm={confirmMakePrivate}
      />
    </>
  );
}
```

### 4.7 Create CopyLinkButton component

Create `src/client/components/CopyLinkButton.tsx`:

```tsx
import { useState } from 'react';
import { Link2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CopyLinkButtonProps {
  sessionId: string;
  visibility: 'private' | 'public';
}

export function CopyLinkButton({ sessionId, visibility }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const url = `${window.location.origin}/sessions/${sessionId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: show URL in prompt
      prompt('Copy this link:', url);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className={copied ? 'bg-accent' : ''}
      >
        {copied ? (
          <>
            <Check className="h-4 w-4 mr-2" />
            Copied!
          </>
        ) : (
          <>
            <Link2 className="h-4 w-4 mr-2" />
            Copy link
          </>
        )}
      </Button>
      <span className="text-xs text-muted-foreground">
        {visibility === 'public'
          ? 'Anyone with this link can view'
          : 'Link works for people with access'}
      </span>
    </div>
  );
}
```

### 4.8 Create Share button with avatar stack

Create `src/client/components/ShareButton.tsx`:

```tsx
import { Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { Collaborator } from '@/hooks/useCollaborators';

interface ShareButtonProps {
  collaborators: Collaborator[];
  onClick: () => void;
}

export function ShareButton({ collaborators, onClick }: ShareButtonProps) {
  const hasCollaborators = collaborators.length > 0;
  const displayCount = Math.min(collaborators.length, 3);
  const extraCount = collaborators.length - displayCount;

  return (
    <Button variant="outline" onClick={onClick} className="gap-2">
      {hasCollaborators && (
        <div className="flex -space-x-2">
          {collaborators.slice(0, displayCount).map((collab, i) => (
            <Avatar key={collab.id} className="h-6 w-6 border-2 border-background">
              {collab.image_url && <AvatarImage src={collab.image_url} />}
              <AvatarFallback className="text-xs">
                {collab.name?.[0] || collab.email[0].toUpperCase()}
              </AvatarFallback>
            </Avatar>
          ))}
          {extraCount > 0 && (
            <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs border-2 border-background">
              +{extraCount}
            </div>
          )}
        </div>
      )}
      <Share2 className="h-4 w-4" />
      Share
    </Button>
  );
}
```

### 4.9 Add ConfirmDialog component

Create `src/client/components/ui/confirm-dialog.tsx`:

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

## Testing Checklist

- [ ] Share modal opens when Share button clicked
- [ ] Owner info displayed at top of collaborator list
- [ ] Email input validates format
- [ ] Role selector works for new invites
- [ ] Invite button adds collaborator
- [ ] Collaborator list shows all collaborators
- [ ] Role dropdown allows changing roles
- [ ] Remove option in dropdown removes collaborator
- [ ] Visibility selector shows current state
- [ ] Visibility selector disabled for remote sessions
- [ ] Visibility change shows confirmation when making private
- [ ] Copy link button copies URL to clipboard
- [ ] Copy link shows success feedback
- [ ] Share button shows avatar stack when collaborators exist

## Next Steps

Plan 5 will add polish: loading states, error handling, animations, and accessibility.
