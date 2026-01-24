# Repository View

A dedicated view for browsing sessions and activity aggregated by repository.

## Motivation

The current HomePage groups sessions by project, but lacks repository-level context:
- No repository metadata (GitHub links, description, visibility)
- No contributor statistics (who's active, token usage, code changes)
- No repository-scoped activity feed

A repository view provides a focused lens on AI-assisted development within a single codebase.

## Data Model

### Repository Identification

Repositories are derived from session data, not stored as separate entities. Identification rules:

1. **Primary**: `repo_url` takes precedence when present (GitHub URL like `https://github.com/org/repo`)
2. **Fallback**: `project_path` only when `repo_url` is null (local directory like `/Users/x/projects/foo`)

**Important**: Sessions with matching `repo_url` always group together, regardless of `project_path`. This prevents the same GitHub repo from fragmenting across different local paths.

### Schema Additions

#### `touched_files` Table

Tracks files modified per session for efficient aggregation:

```sql
CREATE TABLE touched_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, filename),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_touched_files_session ON touched_files(session_id);
```

Populated during session upload from existing diff extraction logic (data already available in memory at `repository.ts:1227-1333`).

### Computed Statistics (per repository)

| Stat | Source | Description |
|------|--------|-------------|
| `session_count` | COUNT sessions | Total sessions in repo |
| `live_session_count` | COUNT where status='live' | Currently active sessions |
| `contributor_count` | COUNT DISTINCT user_id/client_id | Unique contributors |
| `total_lines_added` | SUM from touched_files | Lines added across all sessions |
| `total_lines_removed` | SUM from touched_files | Lines removed across all sessions |
| `files_changed_count` | COUNT DISTINCT filename | Unique files touched |
| `total_input_tokens` | SUM input_tokens | Total input tokens consumed |
| `total_output_tokens` | SUM output_tokens | Total output tokens generated |
| `last_activity_at` | MAX last_activity_at | Most recent session activity |

### Contributor Statistics (per user per repository)

| Stat | Description |
|------|-------------|
| `session_count` | Sessions created by this contributor |
| `lines_added` | Lines added by this contributor's sessions |
| `lines_removed` | Lines removed by this contributor's sessions |
| `input_tokens` | Input tokens from this contributor's sessions |
| `output_tokens` | Output tokens from this contributor's sessions |

## Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/repos` | RepositoryListPage | Browse all repositories |
| `/repos/github/:owner/:repo` | RepositoryDetailPage | GitHub repository |
| `/repos/local/:encodedPath` | RepositoryDetailPage | Local project (no GitHub URL) |

The `encodedPath` uses base64url encoding for local paths without a `repo_url`.

## API Endpoints

### `GET /api/repositories`

Returns repositories accessible to the current user.

```typescript
interface RepositoryListItem {
  id: string;                  // repo_url or encoded project_path
  name: string;                // "repo" or project folder name
  owner: string | null;        // "org" for GitHub, null for local
  repo_url: string | null;     // Full GitHub URL
  project_path: string | null; // Local path (fallback)
  visibility: 'public' | 'private' | 'mixed';  // Derived from sessions
  stats: {
    session_count: number;
    live_session_count: number;
    contributor_count: number;
    total_lines_changed: number;  // added + removed
    last_activity_at: string;
  };
}
```

Query params:
- `sort`: `recent` (default), `sessions`, `contributors`
- `limit`: Max results (default 50)
- `offset`: Pagination offset (default 0)

### `GET /api/repositories/github/:owner/:repo`

Returns repository detail with sessions and statistics.

```typescript
interface RepositoryDetail {
  id: string;
  name: string;
  owner: string | null;
  repo_url: string | null;
  project_path: string | null;
  github_url: string | null;   // Clickable link
  visibility: 'public' | 'private' | 'mixed';

  // Aggregate stats
  stats: {
    session_count: number;
    live_session_count: number;
    contributor_count: number;
    total_lines_added: number;
    total_lines_removed: number;
    files_changed_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };

  // Top contributors
  contributors: Contributor[];

  // Recent sessions (paginated)
  sessions: Session[];
  sessions_total: number;
}

interface Contributor {
  user_id: string | null;      // null for anonymous
  client_id: string | null;    // Present for anonymous contributors
  display_name: string;        // "Anonymous" for anonymous users
  avatar_url: string | null;   // null for anonymous
  session_count: number;
  lines_added: number;
  lines_removed: number;
  input_tokens: number;
  output_tokens: number;
}
```

Query params:
- `sessions_limit`: Max sessions to return (default 10)
- `sessions_offset`: Session pagination offset (default 0)
- `contributor_limit`: Max contributors to return (default 6)
- `session_status`: Filter by `live`, `complete`, `archived` (optional)

### `GET /api/repositories/local/:encodedPath`

Same response shape as GitHub endpoint.

## Access Control

Repository visibility is derived from session visibility, including collaborator access:

```sql
-- A session is accessible if:
-- 1. User owns it (user_id match)
-- 2. Client owns it (client_id match)
-- 3. User is a collaborator
-- 4. Session is public

WHERE (
  s.user_id = :userId
  OR s.client_id = :clientId
  OR s.visibility = 'public'
  OR s.id IN (
    SELECT session_id FROM session_collaborators
    WHERE user_id = :userId OR email = :userEmail
  )
)
```

**Privacy Notice**: Stats reflect only sessions the user can access. When viewing a repository with mixed visibility:
- Show disclaimer: "Stats based on N accessible sessions"
- Don't expose existence of private sessions to non-owners

Repository visibility classification:
- `public`: All sessions are public
- `private`: All sessions are private/collaborator-only
- `mixed`: Some public, some private sessions

## UI Design

### Repository List Page (`/repos`)

Header section:
- Title: "Repositories"
- Subtitle: "AI-assisted development across your codebases"

Repository cards in a responsive grid:
- Desktop: 2 columns
- Mobile: 1 column

```
┌─────────────────────────────────────────┐
│  [GitHub icon] anthropic/claude-code    │
│                                         │
│  42 sessions  •  3 live  •  2h ago      │
│  12 contributors  •  +8.2K lines        │
└─────────────────────────────────────────┘
```

Each card shows:
- Repository icon (GitHub icon or folder icon for local)
- Repository name (org/repo or project folder)
- Session count with live indicator
- Contributor count
- Total lines changed (compact format)
- Last activity timestamp

Clicking a card navigates to the repository detail page.

### Repository Detail Page

#### Header

```
┌─────────────────────────────────────────────────────────────┐
│  [GitHub icon]                                              │
│  anthropic / claude-code                      [View on GH]  │
│                                                             │
│  42 sessions  •  3 live  •  12 contributors                 │
│  Stats based on 38 accessible sessions                      │
└─────────────────────────────────────────────────────────────┘
```

- Repository icon (large)
- Owner / repo name as breadcrumb-style heading
- "View on GitHub" button (external link, only if `repo_url` exists)
- Summary stats row
- Privacy disclaimer when viewing mixed-visibility repo

#### Stats Cards

Responsive layout:
- Desktop: 3 columns
- Tablet: 2 columns
- Mobile: 1 column (stacked)

```
Desktop:
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Code Changes    │  │  Token Usage     │  │  Activity        │
│                  │  │                  │  │                  │
│  +12,450 lines   │  │  2.4M input      │  │  42 sessions     │
│  -3,210 lines    │  │  890K output     │  │  156 files       │
│                  │  │                  │  │                  │
│  79% additions   │  │                  │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘

Mobile (stacked):
┌────────────────────────────────────────┐
│  Code Changes      +12,450 / -3,210    │
├────────────────────────────────────────┤
│  Token Usage       2.4M in / 890K out  │
├────────────────────────────────────────┤
│  Activity          42 sessions, 156 files │
└────────────────────────────────────────┘
```

**Code Changes card:**
- Lines added (green, `diff-add` color)
- Lines removed (red, `diff-del` color)
- Percentage breakdown (e.g., "79% additions")

**Token Usage card:**
- Input tokens (formatted with K/M suffix)
- Output tokens
- Tooltip: "Tokens consumed by AI model interactions"

**Activity card:**
- Total session count
- Files changed count

#### Top Contributors

Responsive grid with horizontal scroll on mobile:

```
Top Contributors

┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  [avatar]   │  │  [avatar]   │  │  [?]        │
│  Alice      │  │  Bob        │  │  Anonymous  │
│             │  │             │  │             │
│  18 sess    │  │  12 sess    │  │  8 sess     │
│  +4.2K /-1K │  │  +3.1K /-2K │  │  +2.8K /-0K │
└─────────────┘  └─────────────┘  └─────────────┘
```

Contributor display rules:
- **Authenticated users**: Avatar from Clerk, display name, full stats
- **Anonymous contributors**: Generic avatar (question mark or silhouette), display as "Anonymous", aggregate all anonymous sessions under one entry
- Sort by session count descending
- Show top 6 by default, "Show all" expands

#### Sessions Activity List

Below stats, a chronological list of sessions:

```
Sessions (showing 10 of 42)

┌─────────────────────────────────────────────────────────────┐
│  ● Fix authentication bug                           2h ago  │
│    brkalow/auth-fix • claude-sonnet-4                       │
├─────────────────────────────────────────────────────────────┤
│    Implement retry logic for API calls              1d ago  │
│    main • claude-sonnet-4                                   │
└─────────────────────────────────────────────────────────────┘

                    [Load more]
```

Features:
- Uses existing `SessionRow` component
- Live indicator (green dot) for active sessions
- Pagination with "Load more" button
- Filter tabs: All | Live | Complete

### View Toggle

Two view modes (consistent with HomePage terminology):

1. **Activity** (default): Chronological session list with stats cards
2. **Contributors**: Expanded contributor grid with detailed stats per person

Toggle button in the header area, persists via URL query param (`?view=contributors`).

## GitHub Integration

When `repo_url` matches GitHub format (`github.com/:owner/:repo`):

1. **Display**: Show GitHub icon, format as "owner/repo"
2. **Link**: "View on GitHub" button opens repository page
3. **Branch links**: Session branch names link to GitHub branch view

Future enhancements (out of scope for v1):
- Fetch repository description, stars, language via GitHub API
- Sync open PRs with sessions
- Display repository avatar

## Component Structure

```
src/client/components/
├── RepositoryListPage.tsx    # /repos route
├── RepositoryDetailPage.tsx  # /repos/github/:owner/:repo route
├── RepositoryCard.tsx        # Card for list view
├── RepositoryHeader.tsx      # Detail page header with privacy notice
├── StatsCard.tsx             # Reusable stat card (responsive)
├── ContributorCard.tsx       # Contributor avatar + stats
└── ContributorGrid.tsx       # Grid of contributors with anonymous handling
```

Reuse existing components:
- `SessionRow` for session list items
- `LiveIndicator` for activity status
- Design tokens from `ui_overview.md`

## Database Considerations

### Indexes

Composite indexes optimized for access control + aggregation:

```sql
-- Repository list aggregation with access control
CREATE INDEX idx_sessions_repo_access
  ON sessions(repo_url, user_id, client_id, visibility, last_activity_at);

CREATE INDEX idx_sessions_project_access
  ON sessions(project_path, user_id, client_id, visibility, last_activity_at);

-- Contributor aggregation by repository
CREATE INDEX idx_sessions_repo_user
  ON sessions(repo_url, user_id);

CREATE INDEX idx_sessions_repo_client
  ON sessions(repo_url, client_id);

-- Touched files aggregation
CREATE INDEX idx_touched_files_session
  ON touched_files(session_id);

-- Collaborator lookup optimization
CREATE INDEX idx_collaborators_user
  ON session_collaborators(user_id, session_id);

CREATE INDEX idx_collaborators_email
  ON session_collaborators(email, session_id);
```

### Query Patterns

#### Repository List Query

Use CTE for better query planning and access control:

```sql
WITH accessible_sessions AS (
  SELECT
    id,
    COALESCE(repo_url, project_path) as repo_id,
    repo_url,
    project_path,
    status,
    visibility,
    user_id,
    client_id,
    last_activity_at
  FROM sessions s
  WHERE (
    s.user_id = :userId
    OR s.client_id = :clientId
    OR s.visibility = 'public'
    OR s.id IN (
      SELECT session_id FROM session_collaborators
      WHERE user_id = :userId OR email = :userEmail
    )
  )
),
repo_stats AS (
  SELECT
    repo_id,
    repo_url,
    project_path,
    COUNT(*) as session_count,
    SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) as live_count,
    COUNT(DISTINCT COALESCE(user_id, client_id)) as contributor_count,
    MAX(last_activity_at) as last_activity,
    CASE
      WHEN MIN(visibility) = MAX(visibility) THEN MIN(visibility)
      ELSE 'mixed'
    END as visibility
  FROM accessible_sessions
  GROUP BY repo_id
)
SELECT * FROM repo_stats
ORDER BY last_activity DESC
LIMIT :limit OFFSET :offset;
```

#### Contributor Stats Query

Aggregate from `touched_files` to avoid N+1 with diffs:

```sql
WITH accessible_sessions AS (
  -- Same access control CTE as above, filtered to specific repo
  SELECT id, user_id, client_id, input_tokens, output_tokens
  FROM sessions s
  WHERE s.repo_url = :repoUrl
    AND (/* access control conditions */)
),
contributor_stats AS (
  SELECT
    s.user_id,
    s.client_id,
    COUNT(DISTINCT s.id) as session_count,
    SUM(s.input_tokens) as input_tokens,
    SUM(s.output_tokens) as output_tokens
  FROM accessible_sessions s
  GROUP BY COALESCE(s.user_id, s.client_id)
),
file_stats AS (
  SELECT
    COALESCE(s.user_id, s.client_id) as contributor_id,
    SUM(tf.lines_added) as lines_added,
    SUM(tf.lines_removed) as lines_removed
  FROM accessible_sessions s
  JOIN touched_files tf ON tf.session_id = s.id
  GROUP BY contributor_id
)
SELECT
  cs.*,
  COALESCE(fs.lines_added, 0) as lines_added,
  COALESCE(fs.lines_removed, 0) as lines_removed
FROM contributor_stats cs
LEFT JOIN file_stats fs ON fs.contributor_id = COALESCE(cs.user_id, cs.client_id)
ORDER BY cs.session_count DESC
LIMIT :limit;
```

### Caching Strategy

**Initial approach (Option A)**: In-memory cache with TTL

```typescript
// Cache key: `repo:${repoId}:stats`
// TTL: 5 minutes
// Invalidation: On session create/update/delete for matching repo_url
```

**Cache invalidation triggers**:
1. Session created with matching `repo_url`
2. Session updated (status change, token counts)
3. Session deleted
4. Collaborator added/removed

**Migration to Option B**: If P95 latency exceeds 200ms or repositories exceed 100 with 500+ sessions each, pre-compute to `repository_stats` table.

## Implementation Phases

### Phase 1: Data Layer (1-2 days)
- [ ] Add `touched_files` table migration
- [ ] Update session upload to populate `touched_files`
- [ ] Add composite indexes
- [ ] Implement repository aggregation queries with collaborator access
- [ ] Add in-memory cache layer
- [ ] Unit tests for queries and cache invalidation

### Phase 2: API Endpoints (1 day)
- [ ] `GET /api/repositories` with pagination
- [ ] `GET /api/repositories/github/:owner/:repo`
- [ ] `GET /api/repositories/local/:encodedPath`
- [ ] Integration tests for access control

### Phase 3: UI - List Page (1 day)
- [ ] `RepositoryListPage` component
- [ ] `RepositoryCard` component
- [ ] Responsive grid layout
- [ ] Add route to `App.tsx`

### Phase 4: UI - Detail Page (2 days)
- [ ] `RepositoryDetailPage` component
- [ ] `RepositoryHeader` with privacy notice
- [ ] `StatsCard` (responsive)
- [ ] `ContributorCard` with anonymous handling
- [ ] `ContributorGrid`
- [ ] Session list with pagination
- [ ] View toggle (Activity/Contributors)

### Phase 5: Polish (1 day)
- [ ] GitHub link integration
- [ ] Filter tabs for session list
- [ ] Mobile responsive testing
- [ ] E2E tests

## Edge Cases

### Empty Repositories
If all sessions in a repository are deleted:
- Repository disappears from list (derived, not stored)
- No orphan cleanup needed

### Anonymous Contributors
- All sessions without `user_id` aggregate under "Anonymous"
- Show generic avatar (silhouette icon)
- Display as single entry in contributor list
- Track by `client_id` internally but don't expose

### Mixed Visibility
When a repository has both public and private sessions:
- Show `visibility: 'mixed'` indicator
- Stats reflect only accessible sessions
- Show disclaimer: "Stats based on N accessible sessions"

### Cross-Repository Sessions
Out of scope for v1. Sessions belong to exactly one repository based on `repo_url` or `project_path`.

## Decisions Made

1. **Local projects interleaved with GitHub repos**: Same list, sorted by activity, distinguished by icon

2. **Anonymous sessions included**: Aggregated under "Anonymous" contributor with generic avatar

3. **Collaborator access included**: All queries respect `session_collaborators` table

4. **Stats privacy**: Only show stats from accessible sessions, with disclaimer for mixed-visibility repos

5. **Routing pattern**: `/repos/github/:owner/:repo` and `/repos/local/:encodedPath` for clarity

6. **Cache strategy**: Start with 5-minute TTL in-memory cache, invalidate on session mutations

## Future Enhancements

- Real-time updates via WebSocket for live session counts
- GitHub API integration for repo metadata
- Cross-repository analytics dashboard
- Repository-level settings/preferences
- Export repository activity report
