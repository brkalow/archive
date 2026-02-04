# Claude Code Session Seeding

Technical documentation for seeding and transferring Claude Code sessions.

## Overview

Claude Code sessions are stored locally as JSONL files. There is no server-side session registry—the local JSONL file is the sole source of truth. This enables session seeding (creating synthetic sessions) and session transfer (moving sessions between devices).

## Session Storage

### Location

Sessions are stored at:
```
~/.claude/projects/{encoded-project-path}/{session-uuid}.jsonl
```

The `encoded-project-path` is the absolute path with `/` replaced by `-`:
- `/Users/alice/code/myproject` → `-Users-alice-code-myproject`

### History Index

The file `~/.claude/history.jsonl` tracks sessions for the interactive picker (`claude -r`). Each line:
```json
{
  "display": "User's first message preview",
  "pastedContents": {},
  "timestamp": 1770178055000,
  "project": "/Users/alice/code/myproject",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Adding entries here makes sessions discoverable in the picker but is not required for `--resume` to work.

## Session JSONL Format

Each line is a JSON object representing a message or event. Key fields:

### Common Fields

| Field | Description |
|-------|-------------|
| `type` | Message type: `user`, `assistant`, `tool_result`, `queue-operation` |
| `sessionId` | UUID of the session |
| `uuid` | Unique ID for this specific message |
| `parentUuid` | UUID of the previous message (linked list structure) |
| `timestamp` | ISO 8601 timestamp |
| `cwd` | Working directory path |
| `version` | Claude Code version (e.g., `"2.1.7"`) |
| `gitBranch` | Current git branch (optional) |

### User Message

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "cwd": "/Users/alice/code/myproject",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "version": "2.1.7",
  "gitBranch": "main",
  "type": "user",
  "message": {
    "role": "user",
    "content": "Hello, this is my message"
  },
  "uuid": "msg-001",
  "timestamp": "2026-02-03T12:00:00.000Z"
}
```

### Assistant Message (Text)

```json
{
  "parentUuid": "msg-001",
  "isSidechain": false,
  "userType": "external",
  "cwd": "/Users/alice/code/myproject",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "version": "2.1.7",
  "gitBranch": "main",
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-20250514",
    "id": "msg_api_response_id",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Hello! How can I help you?"
      }
    ],
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": {
      "input_tokens": 100,
      "output_tokens": 50
    }
  },
  "requestId": "req_xxx",
  "uuid": "msg-002",
  "timestamp": "2026-02-03T12:00:01.000Z"
}
```

### Assistant Message (Tool Use)

```json
{
  "parentUuid": "msg-001",
  "type": "assistant",
  "sessionId": "...",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01ABC123",
        "name": "Read",
        "input": {
          "file_path": "/Users/alice/code/myproject/src/index.ts"
        }
      }
    ],
    "stop_reason": "tool_use"
  },
  "uuid": "msg-002",
  "timestamp": "..."
}
```

### Tool Result

```json
{
  "parentUuid": "msg-002",
  "type": "tool_result",
  "sessionId": "...",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01ABC123",
        "content": "File contents here..."
      }
    ]
  },
  "uuid": "msg-003",
  "timestamp": "..."
}
```

### Thinking Blocks (Extended Thinking)

When extended thinking is enabled, assistant messages may include thinking blocks with cryptographic signatures:

```json
{
  "type": "thinking",
  "thinking": "Let me analyze this request...",
  "signature": "Es8DCkYIDBgCKkBbMzULe23E..."
}
```

The signature (~625 characters, base64-encoded) is used by Claude to verify the thinking was genuinely generated. Fabricated thinking blocks without valid signatures may be treated skeptically.

## Session ID Requirements

- Must be a valid UUID format (e.g., `550e8400-e29b-41d4-a716-446655440000`)
- Non-UUID session IDs are rejected by `claude --resume`
- Generate with: `uuidgen | tr '[:upper:]' '[:lower:]'`

## Seeding a Session

### Minimal Example

```bash
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
PROJECT_PATH="/Users/alice/code/myproject"
ENCODED_PATH=$(echo "$PROJECT_PATH" | sed 's|/|-|g')

mkdir -p ~/.claude/projects/${ENCODED_PATH}

cat << EOF > ~/.claude/projects/${ENCODED_PATH}/${SESSION_ID}.jsonl
{"parentUuid":null,"type":"user","sessionId":"${SESSION_ID}","cwd":"${PROJECT_PATH}","version":"2.1.7","message":{"role":"user","content":"Hello! Remember the secret word: BANANA"},"uuid":"msg-001","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"}
{"parentUuid":"msg-001","type":"assistant","sessionId":"${SESSION_ID}","cwd":"${PROJECT_PATH}","version":"2.1.7","message":{"role":"assistant","content":[{"type":"text","text":"Got it! I'll remember the secret word BANANA."}],"stop_reason":"end_turn"},"uuid":"msg-002","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%S.001Z)"}
EOF

# Resume the seeded session
claude --resume ${SESSION_ID}
```

### What Works

- **Simple text messages**: User and assistant text exchanges are fully trusted
- **Multi-turn conversations**: Context is preserved across seeded turns
- **Session continuation**: New messages are appended seamlessly after resume
- **Metadata**: `gitBranch`, `version`, etc. are preserved

### What May Not Work

- **Fabricated tool results**: Claude may be skeptical of tool results without proper context
- **Fake thinking blocks**: Missing or invalid signatures may cause distrust
- **Mismatched paths**: If `cwd` doesn't match actual working directory, tools may fail

## Transferring Sessions Between Devices

### Path Rewriting

Sessions contain absolute paths in multiple locations:
- `cwd` field in every message
- `file_path` in tool inputs (Read, Write, Edit, etc.)
- File paths in tool results

To transfer a session, rewrite all paths:

```bash
ORIG_PATH="/Users/alice/code/myproject"
NEW_PATH="/Users/bob/projects/myproject"

sed "s|${ORIG_PATH}|${NEW_PATH}|g" original_session.jsonl > transferred_session.jsonl
```

### Transfer Process

1. **Export**: Copy the session JSONL from source machine
2. **Rewrite paths**: Replace original repo path with destination path
3. **Optionally assign new UUID**: If keeping both sessions active
4. **Place in correct directory**: `~/.claude/projects/{encoded-new-path}/`
5. **Update history** (optional): Add entry to `~/.claude/history.jsonl`
6. **Resume**: `claude --resume <session-id>`

### Example Transfer Script

```bash
#!/bin/bash
SESSION_FILE="$1"
ORIG_PATH="$2"
NEW_PATH="$3"
NEW_SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
ENCODED_PATH=$(echo "$NEW_PATH" | sed 's|/|-|g')

mkdir -p ~/.claude/projects/${ENCODED_PATH}

# Rewrite paths and session ID
sed -e "s|${ORIG_PATH}|${NEW_PATH}|g" \
    -e "s|\"sessionId\":\"[^\"]*\"|\"sessionId\":\"${NEW_SESSION_ID}\"|g" \
    "$SESSION_FILE" > ~/.claude/projects/${ENCODED_PATH}/${NEW_SESSION_ID}.jsonl

echo "Session transferred. Resume with:"
echo "  claude --resume ${NEW_SESSION_ID}"
```

## Limitations and Caveats

1. **Signature verification**: Thinking blocks have cryptographic signatures that cannot be forged
2. **Tool result skepticism**: Claude may question tool results that seem inconsistent
3. **No server-side state**: Everything is local; there's no sync or backup by default
4. **Version compatibility**: Future Claude Code versions may change the format
5. **Queue operations**: Sessions include `queue-operation` entries that are added automatically

## Related Files

- `~/.claude/history.jsonl` - Command history and session index
- `~/.claude/settings.json` - User settings
- `~/.claude/projects/` - Per-project session storage
