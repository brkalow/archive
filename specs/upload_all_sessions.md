# Upload All Sessions for Project

## Overview

Add an option to `openctl upload` that uploads all Claude Code sessions for the current project (or a specified project path) in a single command.

## Motivation

Currently, uploading sessions requires either:
- Running `openctl upload` from within a project directory (uploads the most recent session)
- Using `--list` to interactively select a session
- Specifying a session UUID or path explicitly

Users who want to bulk-import their session history for a project must run the command repeatedly. This is tedious and error-prone.

## Proposed Interface

### New Flags

```sh
# Upload all sessions for the current project
openctl upload --all

# Upload all sessions for a specific project path
openctl upload --all --project /path/to/project

# Upload sessions modified after a certain date
openctl upload --all --since 2025-01-01

# Skip sessions that have already been uploaded
openctl upload --all --skip-existing

# Dry run - show what would be uploaded without uploading
openctl upload --all --dry-run
```

### Flag Combinations

| Flag | Behavior |
|------|----------|
| `--all` | Upload all sessions for current project |
| `--all --project <path>` | Upload all sessions for specified project |
| `--all --since <date>` | Filter to sessions modified after date |
| `--all --skip-existing` | Skip sessions already uploaded (default) |
| `--all --dry-run` | Preview what would be uploaded |

### Mutual Exclusivity

`--all` is mutually exclusive with:
- Positional `<session>` argument (UUID or path)
- `--list` flag
- `--review` flag (code review generation is too slow/expensive for bulk uploads)

## Session Discovery

### Finding Sessions for a Project

1. Determine target project path:
   - If `--project` specified, use that path (validate it exists)
   - Otherwise, use `process.cwd()`

2. Encode the project path to Claude's format:
   - Replace `/` with `-`, URL-encode special characters
   - Look for directory at `~/.claude/projects/<encoded-path>/`

3. Scan the encoded directory for `.jsonl` files:
   - Skip files in `subagents/` subdirectory
   - Skip files that can't be parsed as valid session JSONL

4. Apply filters:
   - If `--since` specified, filter by file modification time
   - Sort by modification time (oldest first for chronological upload)

### Example Directory Structure

```
~/.claude/projects/
  -Users-bryce-code-warsaw/
    abc123.jsonl        # Include
    def456.jsonl        # Include
    subagents/
      sub789.jsonl      # Skip (subagent session)
```

## Deduplication

### Server-Side Detection

The server tracks `claude_session_id` (the UUID from the JSONL filename) as a unique identifier. Before uploading each session, query the server to check if it already exists:

```
GET /api/sessions?claude_session_id=<uuid>
```

This check happens per-session during the upload loop.

### Default Behavior

By default (`--skip-existing`), skip sessions that already exist on the server. This makes the command idempotent - running it multiple times won't create duplicates.

## Interactive Confirmation

Before uploading, display a summary and prompt for confirmation:

```
Scanning sessions for /Users/bryce/code/warsaw...
Found 12 sessions (8 new, 4 already uploaded)

Sessions to upload:
  - Fix authentication bug (abc123) - 2h ago
  - Add user settings page (def456) - 1d ago
  - Refactor database layer (ghi789) - 3d ago
  ...

Upload 8 sessions? [y/N]
```

- Default to "no" (user must explicitly confirm with `y` or `yes`)
- `--dry-run` skips the prompt and just shows what would be uploaded

## Progress Reporting

### Console Output

After confirmation:

```
Uploading sessions:
  [1/8] Fix authentication bug (abc123) ✓
  [2/8] Add user settings page (def456) ✓
  [3/8] Refactor database layer (ghi789) ✓
  ...
  [8/8] Update documentation (xyz999) ✓

Done. Uploaded 8 sessions, skipped 4 (already uploaded).
```

### Error Handling

If a session fails to upload:
1. Log the error with session details
2. Continue uploading remaining sessions
3. Report failures in final summary

```
Done. Uploaded 7 sessions, skipped 4 (already uploaded), 1 failed.

Failed:
  - xyz999: Network error - connection refused
```

## Implementation Notes

### Reusing Existing Logic

The current `upload.ts` has well-factored functions:
- `findCurrentSession()` - Find session for CWD
- `extractMetadata()` - Parse JSONL for title, model, etc.
- `extractGitInfo()` - Get diff, branch, repo URL
- `uploadSession()` - POST to server

For `--all`, create a wrapper that:
1. Discovers all sessions for the project
2. Checks which need uploading
3. Calls the existing upload logic for each

### Git Diff Considerations

The git diff is computed at upload time based on current working tree state. For bulk uploads of historical sessions, the diff may not accurately reflect what the code looked like at session time.

Options:
1. **Current approach**: Use current diff for all sessions (simplest, matches existing behavior)
2. **Per-session diff**: Attempt to checkout the session's branch and compute diff (complex, risky)
3. **Skip diff for old sessions**: Only include diff for most recent session (compromise)

Recommendation: Use option 1 (current approach) for initial implementation. The diff is useful but not critical - session content is the primary value.

### Rate Limiting

The server may rate limit uploads. Consider:
- Sequential uploads with small delay between requests
- Exponential backoff on 429 responses
- Progress indicator that accounts for delays

## Success Criteria

- [ ] `openctl upload --all` uploads all sessions for current project
- [ ] `--project` flag allows specifying a different project path
- [ ] `--since` flag filters sessions by modification date
- [ ] Skips already-uploaded sessions by default
- [ ] `--dry-run` shows what would be uploaded
- [ ] Interactive confirmation prompt before uploading (default no)
- [ ] `--all` is mutually exclusive with `--review`
- [ ] Clear progress reporting during upload
- [ ] Graceful error handling (continues on individual failures)
- [ ] Command is idempotent (safe to run multiple times)
