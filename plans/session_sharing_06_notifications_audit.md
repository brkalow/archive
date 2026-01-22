# Session Sharing Plan 6: Email Notifications & Audit

Implementation plan for email notifications and audit logging display. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

**Prereqs:** Plan 3 (API endpoints)

## Overview

This plan implements email notifications for collaborator invitations and displays audit history in the Share Modal.

## Tasks

### 6.1 Choose and configure email provider

**Recommended:** Resend (simple API, good DX, generous free tier)

Install dependency:
```bash
bun add resend
```

Add environment variables:
```env
RESEND_API_KEY=re_...
APP_URL=https://openctl.dev
RESEND_FROM_EMAIL=notifications@openctl.dev
```

### 6.2 Create email service

Create `src/lib/email.ts`:

```typescript
import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const APP_URL = process.env.APP_URL || 'https://openctl.dev';
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'openctl <notifications@openctl.dev>';

interface InvitationEmailParams {
  recipientEmail: string;
  sharerName: string;
  sessionTitle: string;
  sessionId: string;
  role: 'viewer' | 'contributor';
}

/**
 * Send an invitation email when a user is added as a collaborator.
 */
export async function sendInvitationEmail({
  recipientEmail,
  sharerName,
  sessionTitle,
  sessionId,
  role,
}: InvitationEmailParams): Promise<void> {
  if (!resend) {
    console.warn('Email not configured (RESEND_API_KEY missing)');
    return;
  }

  const sessionUrl = `${APP_URL}/sessions/${sessionId}`;
  const roleDescription = role === 'contributor'
    ? 'You can view and add comments.'
    : 'You can view this session.';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: recipientEmail,
      subject: `${sharerName} shared a session with you on openctl`,
      text: `
${sharerName} shared a session with you.

"${sessionTitle}"

${roleDescription}

View session: ${sessionUrl}

---
You're receiving this because ${recipientEmail} was added as a ${role} on this session.
      `.trim(),
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p style="margin-bottom: 20px;">
    <strong>${sharerName}</strong> shared a session with you.
  </p>

  <div style="background: #f5f5f5; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
    <p style="margin: 0; font-size: 18px; font-weight: 500;">"${sessionTitle}"</p>
    <p style="margin: 8px 0 0; color: #666; font-size: 14px;">${roleDescription}</p>
  </div>

  <a href="${sessionUrl}" style="display: inline-block; background: #000; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
    View Session
  </a>

  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">

  <p style="font-size: 12px; color: #666;">
    You're receiving this because ${recipientEmail} was added as a ${role} on this session.
  </p>
</body>
</html>
      `.trim(),
    });

    console.log(`Invitation email sent to ${recipientEmail}`);
  } catch (error) {
    console.error(`Failed to send invitation email to ${recipientEmail}:`, error);
    // Don't throw - email failure shouldn't block the invitation
  }
}

interface RemovalEmailParams {
  recipientEmail: string;
  sessionTitle: string;
}

/**
 * Send a notification email when a user is removed from a session.
 * (Optional - Phase 2)
 */
export async function sendRemovalEmail({
  recipientEmail,
  sessionTitle,
}: RemovalEmailParams): Promise<void> {
  if (!resend) return;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: recipientEmail,
      subject: `You've been removed from a session on openctl`,
      text: `
You no longer have access to "${sessionTitle}".

If you believe this was a mistake, contact the session owner.

---
openctl
      `.trim(),
    });
  } catch (error) {
    console.error(`Failed to send removal email to ${recipientEmail}:`, error);
  }
}
```

### 6.3 Integrate email sending in API

Update the POST collaborators endpoint in `src/routes/api.ts`:

```typescript
import { sendInvitationEmail } from '@/lib/email';
import { getUserInfo } from '@/lib/clerk';

// POST /api/sessions/:id/collaborators
if (method === 'POST' && collaboratorsMatch) {
  // ... existing validation ...

  const collaborator = repo.addCollaborator(sessionId, email, role, auth.userId);

  // Audit log
  repo.logAuditEvent(sessionId, 'collaborator_added', auth.userId, normalizeEmail(email), undefined, role);

  // Send invitation email (fire and forget)
  const sharerInfo = await getUserInfo(auth.userId);
  sendInvitationEmail({
    recipientEmail: normalizeEmail(email),
    sharerName: sharerInfo
      ? `${sharerInfo.firstName || ''} ${sharerInfo.lastName || ''}`.trim() || sharerInfo.email || 'Someone'
      : 'Someone',
    sessionTitle: session.title,
    sessionId: session.id,
    role,
  }).catch(err => {
    console.error('Failed to send invitation email:', err);
  });

  return jsonResponse({ ... }, 201);
}
```

### 6.4 Add rate limiting for email

Create `src/lib/rate-limit.ts`:

```typescript
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory rate limiter (use Redis for production with multiple instances)
const rateLimits = new Map<string, RateLimitEntry>();

interface RateLimitConfig {
  window: number;  // Window in milliseconds
  max: number;     // Max requests per window
}

/**
 * Check if a request should be rate limited.
 * Returns true if the request is allowed, false if rate limited.
 */
export function checkRateLimit(key: string, config: RateLimitConfig): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);

  // Clean up expired entries periodically
  if (Math.random() < 0.01) {
    for (const [k, v] of rateLimits) {
      if (v.resetAt < now) rateLimits.delete(k);
    }
  }

  if (!entry || entry.resetAt < now) {
    // New window
    rateLimits.set(key, { count: 1, resetAt: now + config.window });
    return true;
  }

  if (entry.count >= config.max) {
    return false;
  }

  entry.count++;
  return true;
}

// Rate limit configs
export const RATE_LIMITS = {
  // 50 collaborator additions per hour per user
  collaboratorAdditions: { window: 60 * 60 * 1000, max: 50 },
  // 10 invitation emails per hour per user
  invitationEmails: { window: 60 * 60 * 1000, max: 10 },
};
```

Update API to use rate limiting:

```typescript
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

// POST /api/sessions/:id/collaborators
if (method === 'POST' && collaboratorsMatch) {
  // ... existing validation ...

  // Rate limit: 50 additions per hour
  if (!checkRateLimit(`collab:${auth.userId}`, RATE_LIMITS.collaboratorAdditions)) {
    return jsonResponse({
      error: "TooManyRequests",
      message: "Too many collaborator additions. Try again later.",
      code: "RATE_LIMITED",
    }, 429);
  }

  const collaborator = repo.addCollaborator(sessionId, email, role, auth.userId);

  // Rate limit email separately: 10 per hour
  if (checkRateLimit(`email:${auth.userId}`, RATE_LIMITS.invitationEmails)) {
    sendInvitationEmail({ ... }).catch(...);
  } else {
    console.log(`Email rate limited for user ${auth.userId}`);
  }

  // ... rest of handler ...
}
```

### 6.5 Add audit log API endpoint

Add endpoint to retrieve audit logs:

```typescript
// GET /api/sessions/:id/audit-log
if (method === 'GET' && auditLogMatch) {
  const sessionId = auditLogMatch[1];
  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonResponse({ error: "NotFound" }, 404);
  }

  const auth = await extractAuth(req);
  const { isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);

  // Only owner can view audit log
  if (!isOwner) {
    return jsonResponse({ error: "Forbidden", message: "Only owner can view audit log" }, 403);
  }

  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);

  const logs = repo.getAuditLogs(sessionId, Math.min(limit, 100));

  // Enrich with actor info
  const enriched = await Promise.all(logs.map(async (log) => {
    const actorInfo = await getUserInfo(log.actor_user_id);
    return {
      ...log,
      actor_name: actorInfo
        ? `${actorInfo.firstName || ''} ${actorInfo.lastName || ''}`.trim() || actorInfo.email
        : 'Unknown user',
    };
  }));

  return jsonResponse({ logs: enriched });
}
```

### 6.6 Create AuditLogDisplay component

Create `src/client/components/AuditLogDisplay.tsx`:

```tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface AuditLogEntry {
  id: number;
  action: string;
  actor_user_id: string;
  actor_name: string;
  target_email: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

interface AuditLogDisplayProps {
  sessionId: string;
  isOwner: boolean;
}

export function AuditLogDisplay({ sessionId, isOwner }: AuditLogDisplayProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadLogs = async () => {
    if (logs.length > 0) return; // Already loaded

    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/audit-log`, {
        credentials: 'include',
      });
      const data = await res.json();
      setLogs(data.logs);
    } finally {
      setLoading(false);
    }
  };

  if (!isOwner) return null;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={loadLogs}
        >
          <History className="h-4 w-4 mr-2" />
          Share history
          {isOpen ? (
            <ChevronUp className="h-4 w-4 ml-auto" />
          ) : (
            <ChevronDown className="h-4 w-4 ml-auto" />
          )}
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="pt-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sharing activity yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {logs.map((log) => (
              <li key={log.id} className="flex items-start gap-2">
                <span className="text-muted-foreground">
                  {formatRelativeTime(log.created_at)}
                </span>
                <span>{formatAuditAction(log)}</span>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatAuditAction(log: AuditLogEntry): string {
  switch (log.action) {
    case 'collaborator_added':
      return `${log.actor_name} added ${log.target_email} as ${log.new_value}`;
    case 'collaborator_removed':
      return `${log.actor_name} removed ${log.target_email}`;
    case 'collaborator_role_changed':
      return `${log.actor_name} changed ${log.target_email} from ${log.old_value} to ${log.new_value}`;
    case 'visibility_changed':
      return `${log.actor_name} made session ${log.new_value}`;
    default:
      return `${log.actor_name} performed ${log.action}`;
  }
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
```

### 6.7 Add audit log to Share Modal

Update `ShareModal.tsx` to include audit log:

```tsx
import { AuditLogDisplay } from './AuditLogDisplay';

export function ShareModal({ ... }) {
  return (
    <Dialog ...>
      <DialogContent>
        {/* ... existing content ... */}

        {/* Audit log section */}
        {isOwner && (
          <div className="border-t pt-4 mt-4">
            <AuditLogDisplay sessionId={session.id} isOwner={isOwner} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

## Testing Checklist

### Email Notifications
- [ ] Email sent when collaborator added
- [ ] Email contains correct session title
- [ ] Email contains correct sharer name
- [ ] Email contains working session link
- [ ] Email not sent when RESEND_API_KEY missing (graceful degradation)
- [ ] Email not sent when rate limited
- [ ] Email failure doesn't block API response

### Rate Limiting
- [ ] 50 collaborator additions per hour enforced
- [ ] 10 emails per hour enforced
- [ ] 429 response returned when rate limited
- [ ] Rate limits reset after window expires

### Audit Log
- [ ] All sharing actions logged
- [ ] Audit log API returns entries
- [ ] Only owner can view audit log
- [ ] Audit log displays in Share Modal
- [ ] Collapsible UI for audit log
- [ ] Relative time formatting correct

## Environment Variables

Add to `.env.example`:

```env
# Email (optional - notifications disabled if not set)
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=notifications@openctl.dev

# App URL (for email links)
APP_URL=https://openctl.dev
```

## Rollout

1. Add environment variables to production
2. Deploy email service
3. Monitor email delivery rates
4. Add audit log endpoint
5. Deploy UI updates
