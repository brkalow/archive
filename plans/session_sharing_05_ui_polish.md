# Session Sharing Plan 5: Share Modal UI - Polish

Implementation plan for Share Modal polish and accessibility. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

**Prereqs:** Plan 4 (core UI)

## Overview

This plan adds loading states, error handling, animations, mobile layout, and accessibility features to the Share Modal.

## Tasks

### 5.1 Add toast notifications

Create toast notification system for feedback:

```tsx
// src/client/components/ui/toast-provider.tsx
import { Toaster } from 'sonner';

export function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        duration: 3000,
      }}
    />
  );
}

// Usage in components
import { toast } from 'sonner';

// Success
toast.success('Invitation sent to jane@example.com');

// Error
toast.error('Failed to invite collaborator. Please try again.');

// Copy success
toast.success('Link copied to clipboard');
```

### 5.2 Add loading states to CollaboratorRow

Update `CollaboratorRow` with inline loading states:

```tsx
function CollaboratorRow({ ... }) {
  const [updating, setUpdating] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleRoleChange = async (newRole: string) => {
    if (newRole === 'remove') {
      setRemoving(true);
      try {
        await onRemove();
        toast.success(`${name || email} removed`);
      } catch {
        toast.error('Failed to remove. Please try again.');
      } finally {
        setRemoving(false);
      }
      return;
    }

    setUpdating(true);
    try {
      await onUpdateRole(newRole as 'viewer' | 'contributor');
      toast.success('Role updated');
    } catch {
      toast.error('Failed to update role. Please try again.');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className={`... ${removing ? 'opacity-50' : ''}`}>
      {/* ... avatar and name ... */}

      {updating ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Updating...
        </div>
      ) : (
        <Select ... />
      )}
    </div>
  );
}
```

### 5.3 Add row animations

Add enter/exit animations for collaborator rows:

```tsx
import { AnimatePresence, motion } from 'framer-motion';

// In CollaboratorList
<AnimatePresence mode="popLayout">
  {collaborators.map((collab) => (
    <motion.div
      key={collab.id}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
    >
      <CollaboratorRow ... />
    </motion.div>
  ))}
</AnimatePresence>
```

### 5.4 Add visibility change loading state

Update `VisibilitySelector` with transition state:

```tsx
export function VisibilitySelector({ ... }) {
  return (
    <div className={`... ${updating ? 'opacity-75' : ''}`}>
      {/* ... */}

      {updating && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
```

### 5.5 Add form validation feedback

Enhance `CollaboratorInvite` with real-time validation:

```tsx
function CollaboratorInvite({ onInvite }) {
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);

  const isValid = !email || isValidEmail(email);
  const showError = touched && email && !isValid;

  return (
    <form ...>
      <div className="space-y-1">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(true)}
              className={showError ? 'border-destructive' : ''}
              aria-invalid={showError}
              aria-describedby={showError ? 'email-error' : undefined}
            />
            {email && isValid && (
              <Check className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-500" />
            )}
          </div>
          {/* ... role select and button ... */}
        </div>
        {showError && (
          <p id="email-error" className="text-sm text-destructive">
            Enter a valid email address
          </p>
        )}
      </div>
    </form>
  );
}
```

### 5.6 Add stale data banner

Handle concurrent modifications:

```tsx
// In ShareModal
const [staleData, setStaleData] = useState(false);

// Listen for WebSocket events (Plan 7) or poll
useEffect(() => {
  const checkForUpdates = async () => {
    // Compare local state with server state
    // Set staleData if different
  };

  const interval = setInterval(checkForUpdates, 30000);
  return () => clearInterval(interval);
}, [sessionId]);

return (
  <Dialog ...>
    {staleData && (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between">
        <span className="text-sm text-amber-800">
          This session was updated.
        </span>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
    )}
    {/* ... rest of modal ... */}
  </Dialog>
);
```

### 5.7 Add remove confirmation dialog

Add confirmation when removing collaborators:

```tsx
function CollaboratorRow({ ... }) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  const handleRoleChange = (newRole: string) => {
    if (newRole === 'remove') {
      setConfirmRemove(true);
      return;
    }
    // ... update role
  };

  return (
    <>
      {/* ... row content ... */}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${name || email}?`}
        description="They will immediately lose access to this session."
        confirmText="Remove"
        variant="destructive"
        onConfirm={async () => {
          setConfirmRemove(false);
          await handleRemove();
        }}
      />
    </>
  );
}
```

### 5.8 Add keyboard navigation

Implement keyboard navigation and focus management:

```tsx
// In ShareModal
const emailInputRef = useRef<HTMLInputElement>(null);
const closeButtonRef = useRef<HTMLButtonElement>(null);

// Focus email input on open
useEffect(() => {
  if (isOpen) {
    emailInputRef.current?.focus();
  }
}, [isOpen]);

// Return focus to Share button on close
const handleClose = () => {
  onClose();
  // Focus is automatically returned by Dialog component
};

// In CollaboratorInvite
<Input
  ref={emailInputRef}
  onKeyDown={(e) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }}
/>

// Focus management after actions
const handleInvite = async () => {
  await onInvite(email, role);
  setEmail('');
  emailInputRef.current?.focus(); // Return focus to input
};

const handleRemove = async () => {
  await onRemove();
  // Focus moves to next row or email input if last
  const nextFocusTarget = document.querySelector('[data-collaborator-row]:focus-within')
    ?.nextElementSibling?.querySelector('button, select')
    || emailInputRef.current;
  (nextFocusTarget as HTMLElement)?.focus();
};
```

### 5.9 Add ARIA labels and live regions

Add accessibility attributes:

```tsx
// Live region for announcements
<div role="status" aria-live="polite" className="sr-only">
  {announcement}
</div>

// Update announcements on actions
const [announcement, setAnnouncement] = useState('');

const handleInvite = async () => {
  await onInvite(email, role);
  setAnnouncement(`${email} added as ${role}`);
};

const handleRoleChange = async (id, role) => {
  await updateRole(id, role);
  setAnnouncement(`Role changed to ${role}`);
};

const handleRemove = async (id, email) => {
  await removeCollaborator(id);
  setAnnouncement(`${email} removed`);
};

// ARIA labels for icon-only buttons
<Button
  variant="ghost"
  size="icon"
  aria-label={`Remove ${name || email} from session`}
>
  <Trash2 className="h-4 w-4" />
</Button>

// Dropdown labels
<Select aria-label={`Change role for ${name || email}`}>
  ...
</Select>
```

### 5.10 Add mobile layout

Create responsive layout for mobile:

```tsx
// ShareModal responsive styles
<DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
  {/* On mobile: full screen overlay */}
  <div className="fixed inset-0 sm:relative sm:inset-auto">
    {/* Header pinned on mobile */}
    <DialogHeader className="sticky top-0 bg-background z-10 pb-4 border-b sm:border-0">
      <DialogTitle>Share</DialogTitle>
    </DialogHeader>

    <div className="p-4 sm:p-0">
      {/* Mobile: stacked email input */}
      <div className="flex flex-col sm:flex-row gap-2">
        <Input className="w-full" ... />
        <div className="flex gap-2">
          <Select className="flex-1 sm:w-[130px]" ... />
          <Button className="flex-1 sm:flex-none">Invite</Button>
        </div>
      </div>

      {/* Mobile: stacked collaborator rows */}
      <CollaboratorRow className="flex flex-col sm:flex-row" ... />
    </div>
  </div>
</DialogContent>

// CollaboratorRow mobile layout
function CollaboratorRow({ ... }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 py-3 sm:py-2">
      <div className="flex items-center gap-3 flex-1">
        <Avatar ... />
        <div className="flex-1 min-w-0">
          <span className="font-medium truncate">{name || email}</span>
          {name && <span className="text-sm text-muted-foreground block truncate">{email}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 ml-[52px] sm:ml-0">
        <Select className="flex-1 sm:flex-none" ... />
        {canEdit && (
          <Button variant="ghost" size="icon" aria-label="Remove">
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
```

### 5.11 Add touch targets

Ensure 44x44px minimum touch targets:

```css
/* In global styles or tailwind config */
.touch-target {
  @apply min-h-[44px] min-w-[44px];
}

/* Or inline */
<Button className="min-h-[44px] min-w-[44px] p-3 sm:p-2" ... />

/* Mobile role selector as bottom sheet */
<SelectContent className="sm:max-h-[300px]">
  <SelectItem className="min-h-[44px]" value="viewer">Viewer</SelectItem>
  <SelectItem className="min-h-[44px]" value="contributor">Contributor</SelectItem>
  <SelectItem className="min-h-[44px] text-destructive" value="remove">Remove</SelectItem>
</SelectContent>
```

### 5.12 Add text truncation with tooltips

Handle long emails and names:

```tsx
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

function TruncatedText({ text, maxLength = 25 }: { text: string; maxLength?: number }) {
  const shouldTruncate = text.length > maxLength;
  const displayText = shouldTruncate
    ? text.slice(0, maxLength) + '...'
    : text;

  if (!shouldTruncate) {
    return <span>{text}</span>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default">{displayText}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Usage
<TruncatedText text={collab.email} />
```

### 5.13 Add copy link fallback

Handle clipboard API failures:

```tsx
function CopyLinkButton({ sessionId, visibility }) {
  const [showFallback, setShowFallback] = useState(false);
  const url = `${window.location.origin}/sessions/${sessionId}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied to clipboard');
    } catch {
      setShowFallback(true);
    }
  };

  return (
    <div className="space-y-2">
      <Button onClick={handleCopy}>
        <Link2 className="h-4 w-4 mr-2" />
        Copy link
      </Button>

      {showFallback && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Failed to copy. Select and copy manually:
          </p>
          <Input
            value={url}
            readOnly
            onFocus={(e) => e.target.select()}
            className="text-xs"
          />
        </div>
      )}
    </div>
  );
}
```

## Testing Checklist

### Loading States
- [ ] Skeleton shown while loading collaborators
- [ ] Inline spinner when updating role
- [ ] Opacity change when removing collaborator
- [ ] Visibility toggle shows loading state

### Error States
- [ ] Toast shown on invite failure
- [ ] Toast shown on role update failure
- [ ] Toast shown on remove failure
- [ ] Stale data banner shown on concurrent modification
- [ ] Retry button refreshes data

### Animations
- [ ] New collaborator slides in
- [ ] Removed collaborator slides out
- [ ] Modal has enter/exit animation

### Validation
- [ ] Email validation on blur
- [ ] Green checkmark for valid email
- [ ] Red border for invalid email
- [ ] Error message for invalid email

### Confirmation Dialogs
- [ ] Remove collaborator shows confirmation
- [ ] Make private shows confirmation

### Accessibility
- [ ] Focus moves to email input on modal open
- [ ] Focus returns to Share button on close
- [ ] Focus moves appropriately after invite/remove
- [ ] ARIA labels on all icon buttons
- [ ] Live region announces changes
- [ ] Keyboard navigation works (Tab, Escape)

### Mobile
- [ ] Full-screen modal on mobile
- [ ] Stacked layout for email input
- [ ] Stacked layout for collaborator rows
- [ ] 44px minimum touch targets
- [ ] Role selector as bottom sheet

### Copy Link
- [ ] Copy button shows "Copied!" feedback
- [ ] Fallback input shown if clipboard fails
- [ ] Context hint below button

### Truncation
- [ ] Long emails truncated with ellipsis
- [ ] Long names truncated with ellipsis
- [ ] Full text shown in tooltip on hover

## Performance Considerations

- Use `React.memo` for CollaboratorRow to prevent unnecessary re-renders
- Debounce email validation
- Use `AnimatePresence` mode="popLayout" for smooth list animations
- Lazy load user avatars with placeholders
