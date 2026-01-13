# TODO

Minor issues noticed are logged here. Once resolved, remove them from the file.

---

## Unformatted markdown in messages:

```
<command-name>/context</command-name>
<command-message>context</command-message>
<command-args></command-args>
<local-command-stdout>## Context Usage

Model: claude-opus-4-5-20251101
Tokens: 27.6k / 200.0k (14%)

### Categories

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.0k | 1.5% |
| System tools | 16.1k | 8.1% |
| Custom agents | 152 | 0.1% |
| Memory files | 453 | 0.2% |
| Skills | 241 | 0.1% |
| Messages | 7.6k | 3.8% |
| Free space | 127.4k | 63.7% |
| Autocompact buffer | 45.0k | 22.5% |

### Custom Agents

| Agent Type | Source | Tokens |
|------------|--------|--------|
| feature-dev:code-reviewer | Plugin | 52 |
| feature-dev:code-explorer | Plugin | 47 |
| feature-dev:code-architect | Plugin | 53 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | /Users/bryce/conductor/workspaces/archive/lansing/CLAUDE.md | 453 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| save-plan-to-notion | User | 61 |
| review | User | 46 |
| ralph-loop:help | Plugin | 16 |
| ralph-loop:cancel-ralph | Plugin | 12 |
| ralph-loop:ralph-loop | Plugin | 14 |
| feature-dev:feature-dev | Plugin | 25 |
| frontend-design | Plugin | 67 |

</local-command-stdout>
```

## Extra spacing in code snippets

Maybe an issue with how we're parsing the inline line numbers / diff indicators?

```
     interface ActiveSession {
       adapter: HarnessAdapter;
       localPath: string;
       sessionId: string;
       streamToken: string;
       tail: Tail;
       lastActivity: Date;
       parseContext: ParseContext;
       titleDerived: boolean;
       lineQueue: string[];
       isProcessing: boolean;
     }
```

## Skill usage shows skill prompt

When a skill is used, the subsequent message shows a user prompt with the skill context. These should be collapsed.

## Figure out SSR

we should SSR pages if we have the data available

## Streaming

Support streaming instead of message by message for live chats

## tags in title

<system_instruction> tags showing up in session titles

##
