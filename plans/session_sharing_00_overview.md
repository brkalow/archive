# Session Sharing Implementation Overview

Master plan for implementing session sharing. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

## Summary

This feature enables users to share sessions with specific collaborators by email, with role-based permissions (viewer/contributor), and control session visibility (private/public).

## Plans

| Plan | Name | Description | Prereqs |
|------|------|-------------|---------|
| [01](./session_sharing_01_database.md) | Database Schema | Add visibility, collaborators, and audit tables | None |
| [02](./session_sharing_02_repository.md) | Repository & Access Control | CRUD methods and permission checks | Plan 1 |
| [03](./session_sharing_03_api.md) | API Endpoints | REST endpoints for sharing | Plan 2 |
| [04](./session_sharing_04_ui_core.md) | Share Modal - Core | Basic modal with collaborator management | Plan 3 |
| [05](./session_sharing_05_ui_polish.md) | Share Modal - Polish | Loading states, animations, accessibility | Plan 4 |
| [06](./session_sharing_06_notifications_audit.md) | Notifications & Audit | Email invitations and audit log display | Plan 3 |
| [07](./session_sharing_07_realtime.md) | Real-time Updates | WebSocket events for live collaboration | Plan 4 |

## Parallelization Strategy

```
Phase 1: Foundation (Sequential)
┌─────────────────────────────────────────────────────────────────────┐
│  Plan 1: Database    →    Plan 2: Repository    →    Plan 3: API   │
└─────────────────────────────────────────────────────────────────────┘

Phase 2: UI & Backend Polish (Parallel Tracks)
┌─────────────────────────────────────────────────────────────────────┐
│                         TRACK A (UI)                                │
│  Plan 4: Core UI    →    Plan 5: UI Polish    →    Plan 7: Realtime│
├─────────────────────────────────────────────────────────────────────┤
│                    TRACK B (Backend Services)                       │
│             Plan 6: Notifications & Audit                           │
└─────────────────────────────────────────────────────────────────────┘
```

Plans 4-7 can run in parallel after Plan 3 completes (Plan 6 and Plan 7 have no dependencies on each other or Plans 4-5).

## Execution Order

1. **Plan 1** - Database schema (backwards compatible, safe to deploy first)
2. **Plan 2** - Repository methods (internal, no user-facing changes)
3. **Plan 3** - API endpoints (can test with curl/Postman)
4. **Parallel execution:**
   - **Track A:** Plans 4 → 5 → 7 (UI flow)
   - **Track B:** Plan 6 (notifications/audit - independent of UI)

## Key Files to Modify

### Backend
- `src/db/schema.ts` - Add tables and types
- `src/db/repository.ts` - Add CRUD methods
- `src/routes/api.ts` - Add endpoints
- `src/middleware/auth.ts` - Access control helpers
- `src/lib/email.ts` - Email service (new)
- `src/lib/clerk.ts` - User lookup helpers (new)
- `src/lib/rate-limit.ts` - Rate limiting (new)

### Frontend
- `src/client/hooks/useCollaborators.ts` - Collaborator state (new)
- `src/client/hooks/useSessionVisibility.ts` - Visibility state (new)
- `src/client/components/ShareModal.tsx` - Main modal (new)
- `src/client/components/CollaboratorList.tsx` - List component (new)
- `src/client/components/CollaboratorInvite.tsx` - Invite form (new)
- `src/client/components/VisibilitySelector.tsx` - Visibility toggle (new)
- `src/client/components/ShareButton.tsx` - Header button (new)

## Environment Variables

Add to `.env.example`:

```env
# Email notifications (optional)
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=notifications@openctl.dev

# App URL for email links
APP_URL=https://openctl.dev
```

## Migration from Existing Share Tokens

The existing share token mechanism (`/s/:token`) continues to work:
- Share tokens provide public read-only access regardless of visibility
- Think of them as "secret public links"
- Future deprecation path outlined in spec (Phase 3+)

## Security Considerations

1. **Email enumeration prevention** - POST always returns 201 for valid emails
2. **Rate limiting** - 50 additions/hour, 10 emails/hour per user
3. **Collaborator limits** - Max 50 per session
4. **Remote session protection** - Cannot be made public
5. **Audit logging** - All changes tracked

## Testing Strategy

Each plan includes a testing checklist. Run tests after each plan:

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/integration/sharing.test.ts
```

## Rollout Strategy

1. **Deploy Plan 1** - Database migration (backwards compatible)
2. **Deploy Plans 2-3** - Backend (behind feature flag if needed)
3. **Deploy Plans 4-5** - UI (initially hidden, reveal via flag)
4. **Deploy Plan 6** - Enable email notifications
5. **Deploy Plan 7** - Enable real-time updates
6. **Remove feature flag** - Full launch

## Phase 2 (Future)

From the spec, these are deferred to Phase 2:
- "Shared with me" dedicated view/tab
- Access denied page improvements
- Email notification improvements (removal emails)
- Gmail-specific email normalization (dots, plus aliases)

## Non-Goals (This Phase)

- Team/organization-based access
- GitHub repo-based permissions
- Transferring ownership
- "Request access" workflow
