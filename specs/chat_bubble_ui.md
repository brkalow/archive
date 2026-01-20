# Chat Bubble Conversation UI

Design exploration for a simplified, chat-style conversation interface.

## Goals

1. **Simpler** — Reduce visual noise from role badges, borders, and nested containers
2. **Flatter** — Less visual hierarchy within messages; conversation flow is the hierarchy
3. **Conversational** — Feel like reading a chat history, not inspecting structured data
4. **Scannable** — Easy to quickly scroll through and find what you're looking for

## Design Direction

Hybrid layout: **user messages as bubbles** on the right, **agent turns as flat activity lists** on the left.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                              ┌──────────────────────────────┐   │
│                              │ Help me implement the auth   │   │
│                              │ flow for my app              │   │
│                              └──────────────────────────────┘   │
│                                                                 │
│   ── 6 tool calls, 3 messages ──────────────────────────────    │
│   💭 Thinking  The user wants to implement auth...              │
│   I'll help you implement the authentication flow.              │
│   📖 Read src/auth.ts                                           │
│   📖 Read src/header.tsx                                        │
│   💭 Thinking  Now I need to update the header...               │
│   ✎ Edit src/auth.ts                                           │
│   ✎ Edit src/header.tsx                                        │
│   Done. The auth flow is now implemented.                       │
│                                                                 │
│                              ┌──────────────────────────────┐   │
│                              │ Can you also add the logout  │   │
│                              │ button to the header?        │   │
│                              └──────────────────────────────┘   │
│                                                                 │
│   ── 2 tool calls, 1 message ───────────────────────────────    │
│   💭 Thinking  Simple change to add a button...                 │
│   ✎ Edit src/header.tsx                                        │
│   Added the logout button to the header.                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

This treats each agent turn as a **block of activity** rather than conversational text. The activity is scannable as a chronological list of actions taken.

## User Messages (Bubbles)

User prompts appear as right-aligned bubbles.

```
                              ┌──────────────────────────────┐
                              │ User's prompt or question    │
                              │ goes here                    │
                              └──────────────────────────────┘
```

- **Alignment**: Right side, `ml-auto`, ~70% max-width
- **Background**: `bg-tertiary` (slightly lighter than page)
- **Border radius**: `rounded-xl` for soft bubble shape
- **Padding**: `px-4 py-3`
- **No role label**: Position indicates speaker

## Agent Turns (Activity List)

Agent turns are flat, left-aligned lists—no bubble container. Each item in the turn is a line.

```
── 6 tool calls, 3 messages ──────────────────────────────────
💭 Thinking  The user wants to implement authentication...
I'll help you implement the authentication flow.
📖 Read src/auth.ts
📖 Read package.json
💭 Thinking  I see the current auth setup. Now I'll...
✎ Edit src/auth.ts
✎ Edit src/header.tsx
Done. The authentication flow is now implemented with logout.
```

### Turn Header

Summary line showing activity count:
- Format: `── {N} tool calls, {M} messages ──`
- Style: `text-muted`, `text-xs`, with horizontal rule styling
- Omit counts of zero (e.g., just "3 messages" if no tool calls)

### Line Types

| Type | Icon | Example |
|------|------|---------|
| Thinking | 💭 | `💭 Thinking  Preview of thinking text...` |
| Text | (none) | Plain text, full width |
| Read | 📖 | `📖 Read src/auth.ts` |
| Edit | ✎ | `✎ Edit src/auth.ts` |
| Write | ✎ | `✎ Write src/new-file.ts` |
| Bash | ▶ | `▶ Bash npm install` |
| Search | 🔍 | `🔍 Search **/*.ts` |
| Grep | 🔍 | `🔍 Search for "useAuth"` |
| Task | ⚡ | `⚡ Explore  Find auth patterns in codebase` |
| MCP | ⚙ | `⚙ {tool_name}` |

### Visual Hierarchy

- **Text blocks**: Full opacity, normal weight—these are the "conversation"
- **Tool calls**: Muted color (`text-muted`), smaller font (`text-sm`)
- **Thinking**: Muted, with inline preview truncated to ~50 chars

This creates a visual rhythm where text "pops" and tools recede.

## Tool Calls (Expanded)

Tool calls are collapsed by default (single line). Clicking expands inline.

### Collapsed (Default)

```
✎ Edit src/auth.ts
```

Single line: icon + filename/summary. Muted color.

### Expanded

```
▼ Edit src/auth.ts
┌─────────────────────────────────────────────────────────────┐
│  12   export function logout() {                            │
│  13     clearSession();                                     │
│  14     window.location.href = '/';                         │
│  15   }                                                     │
└─────────────────────────────────────────────────────────────┘
```

- Expanded content appears below the line
- Code/output uses `bg-secondary` with subtle border
- Icon changes to `▼` when expanded
- "Show all" link if output exceeds ~20 lines

### Tool Output Variations

**Read** — shows file content preview:
```
▼ Read 43 lines  src/auth.ts
┌─────────────────────────────────────────────────────────────┐
│  1   import { cookies } from 'next/headers';                │
│  2   ...                                                    │
└─────────────────────────────────────────────────────────────┘
```

**Bash** — shows command and output:
```
▼ Bash npm install
┌─────────────────────────────────────────────────────────────┐
│ added 127 packages in 4.2s                                  │
└─────────────────────────────────────────────────────────────┘
```

**Task** — shows agent description and result summary:
```
▼ Explore  Find auth patterns in codebase
┌─────────────────────────────────────────────────────────────┐
│ Found 3 auth-related files:                                 │
│ - src/auth.ts (main auth logic)                             │
│ - src/middleware.ts (route protection)                      │
│ - src/hooks/useAuth.ts (React hook)                         │
└─────────────────────────────────────────────────────────────┘
```

### Tool Summary Formats

| Tool | Collapsed Format |
|------|------------------|
| Edit | `✎ Edit {filename}` |
| Write | `✎ Write {filename}` |
| Read | `📖 Read {N} lines  {filename}` |
| Bash | `▶ Bash {command preview}` |
| Glob | `🔍 Search {pattern}` |
| Grep | `🔍 Search for "{pattern}"` |
| Task | `⚡ {agent_type}  {description}` |
| MCP | `⚙ {tool_name}` |

## Thinking Blocks

Thinking blocks are collapsed by default with an inline preview.

### Collapsed (Default)

```
💭 Thinking  The user wants to implement authentication...
```

- Icon + "Thinking" label + truncated preview (~50 chars)
- Muted color, same visual weight as tool calls

### Expanded

```
▼ Thinking (2.3s)
┌─────────────────────────────────────────────────────────────┐
│ Let me consider the best approach here. The user wants to   │
│ add logout functionality, which means I'll need to:         │
│ 1. Add a logout function to the auth module                 │
│ 2. Add a button to the header component                     │
│ 3. Wire up the click handler                                │
└─────────────────────────────────────────────────────────────┘
```

- Shows duration in parentheses
- Content in monospace, muted color
- `bg-secondary` background with subtle border

## Turn Boundaries

Each user message creates a natural boundary. The agent's response to that message is grouped as a single "turn."

```
                              ┌──────────────────────────────┐
                              │ First user message           │
                              └──────────────────────────────┘

── 3 tool calls, 2 messages ──────────────────────────────────
💭 Thinking  Analyzing the request...
I'll start by reading the existing code.
📖 Read src/auth.ts
📖 Read src/types.ts
Here's what I found...

                              ┌──────────────────────────────┐
                              │ Second user message          │
                              └──────────────────────────────┘

── 1 tool call, 1 message ────────────────────────────────────
💭 Thinking  Quick fix needed...
✎ Edit src/auth.ts
Done.
```

- **Turn header**: Separates agent turns, shows activity summary
- **Spacing**: More space before user bubbles (16px), less between items in a turn (4-8px)
- **No explicit grouping needed**: The turn header creates the boundary

## Timestamps

Light timestamps shown when there's a significant gap between turns.

```
                              ─── 2:34 PM ───

                              ┌──────────────────────────────┐
                              │ Follow-up question here      │
                              └──────────────────────────────┘
```

- Only shown when gap > 5 minutes between user messages
- Centered, muted, small text (`text-xs text-muted`)
- For completed sessions: consider hiding timestamps entirely (the session timestamp in the header is enough)

## Code Blocks in Text

When agent text contains code blocks, they render inline.

```
Try using the `useAuth` hook:

┌─────────────────────────────────────────────────────────────┐
│ const { user } = useAuth();                                 │
└─────────────────────────────────────────────────────────────┘

This will give you access to the current user.
```

- Code blocks use `bg-secondary` with subtle border
- Syntax highlighting preserved
- Copy button on hover
- Full width (not constrained like user bubbles)

## Full Layout with Diff Panel

```
┌────────────────────────────────────────────────────────────────────┐
│ Header                                                              │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                      ┌─────────────┐                               │
│                      │ User prompt │  ┌──────────────────────────┐ │
│                      └─────────────┘  │ src/auth.ts     +12 -3  │ │
│                                       │                          │ │
│ ── 3 tool calls, 2 messages ───────   │ ┌──────────────────────┐ │ │
│ 💭 Thinking  Analyzing...             │ │ export function...   │ │ │
│ I'll implement the auth flow.         │ │   clearSession();    │ │ │
│ 📖 Read src/auth.ts                   │ └──────────────────────┘ │ │
│ ✎ Edit src/auth.ts                   │                          │ │
│ Done.                                 └──────────────────────────┘ │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ Footer                                                              │
└────────────────────────────────────────────────────────────────────┘
```

The flat activity list takes less horizontal space than bubbles would, leaving more room for the diff panel.

## Conversation-Only View

When there are no diffs, the conversation expands with a max-width constraint.

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│                         ┌────────────────────────────────────┐     │
│                         │ Help me implement the auth flow    │     │
│                         └────────────────────────────────────┘     │
│                                                                    │
│      ── 4 tool calls, 2 messages ────────────────────────────      │
│      💭 Thinking  The user wants to implement authentication...    │
│      I'll help you implement the authentication flow. Let me       │
│      start by examining the existing code structure.               │
│      📖 Read src/auth.ts                                           │
│      📖 Read src/middleware.ts                                     │
│      ✎ Edit src/auth.ts                                           │
│      ✎ Edit src/header.tsx                                        │
│      Done. The authentication flow is now implemented.             │
│                                                                    │
│                         ┌────────────────────────────────────┐     │
│                         │ Can you explain how it works?      │     │
│                         └────────────────────────────────────┘     │
│                                                                    │
│      ── 1 message ───────────────────────────────────────────      │
│      The session management uses a combination of...               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- Max-width ~800px for readability
- Centered within available space
- User bubbles right-aligned within the centered container
- Agent activity left-aligned, full width of container

## Color Refinements

Current palette works well. Key assignments:

| Element | Token | Value |
|---------|-------|-------|
| User bubble bg | `bg-tertiary` | #1a1a1a |
| Agent text | `text-primary` | #e4e4e7 |
| Tool calls | `text-muted` | #52525b |
| Expanded content bg | `bg-secondary` | #141414 |
| Turn header | `text-muted` | #52525b |
| Code blocks | `bg-secondary` | #141414 |

No role-colored borders or labels needed. Position and visual weight indicate speaker.

## Removed Elements

Things we're explicitly simplifying away:

- **Role badges** ("YOU" / "CLAUDE") — position indicates role
- **Colored left borders** — unnecessary with layout differentiation
- **Bubble containers for agent** — flat list is cleaner, more scannable
- **Copy button on every message** — show on hover only
- **Per-message metadata** — keep timing/tokens in session header only

## Open Questions

### 1. Diff ↔ Tool Call Cross-Linking

When user clicks a file in the diff panel, should we highlight the tool call that created it?

**Options:**
- Scroll to and pulse/highlight the relevant tool line
- Show a subtle link icon on tool calls that connects to diff
- Bidirectional: clicking tool scrolls diff, clicking diff scrolls to tool
- No cross-linking (keep panels independent)

**Recommendation**: Implement bidirectional linking. When hovering a tool call that touched a file, highlight that file's diff. When clicking a file in the diff panel, scroll conversation to the tool call that created/modified it. This reinforces the "what happened → what changed" relationship.

### 2. Live Session Indicators

For streaming sessions:
- **Text streaming**: New text appears at the end of the turn, no special indicator needed
- **Tool in progress**: Pulsing/spinner on the tool line (`⏳ Running...`)
- **Thinking in progress**: Animated dots or pulse on thinking line

## Decisions Made

- **Long tool output**: Truncate to ~20 lines with "Show all" that expands inline
- **System messages**: Hide entirely (strip `<system-reminder>` tags, etc.)

## Trade-offs

### Pros
- **Familiar** — User bubbles feel like a chat app
- **Scannable** — Activity list format makes tool calls easy to skim
- **Cleaner** — No nested containers or heavy visual hierarchy
- **Space efficient** — Flat list takes less horizontal space than bubbles
- **Mobile-friendly** — Layout adapts well to narrow screens

### Cons
- **Asymmetric** — User gets bubbles, agent gets a list (intentional, but different)
- **Less "conversational"** — Agent responses feel more like logs than messages

### Mitigations
- Asymmetry reinforces the roles: user is human, agent is a tool
- Text blocks in agent turns still read naturally as prose
- The activity list format matches mental model of "what did the agent do?"

## Implementation Approach

1. **Phase 1**: New `UserBubble` component for user messages
2. **Phase 2**: New `AgentTurn` component with turn header + activity list
3. **Phase 3**: Tool call expand/collapse, thinking blocks
4. **Phase 4**: Cross-linking with diff panel
5. **Phase 5**: Polish animations, hover states, live indicators

## CSS Sketch

```css
/* Conversation container */
.conversation {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  max-width: 800px;
  margin: 0 auto;
}

/* User message bubble */
.user-bubble {
  align-self: flex-end;
  max-width: 70%;
  padding: 0.75rem 1rem;
  background: var(--bg-tertiary);
  border-radius: 1rem;
  border-bottom-right-radius: 0.25rem; /* subtle tail */
}

/* Agent turn container */
.agent-turn {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* Turn header */
.turn-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-muted);
  font-size: 0.75rem;
}

.turn-header::before,
.turn-header::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--bg-elevated);
}

/* Activity line (tool call, thinking) */
.activity-line {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.125rem 0;
  color: var(--text-muted);
  font-size: 0.8125rem;
  cursor: pointer;
}

.activity-line:hover {
  color: var(--text-secondary);
}

/* Text block in agent turn */
.agent-text {
  color: var(--text-primary);
  font-size: 0.875rem;
  line-height: 1.5;
}

/* Expanded content */
.expanded-content {
  margin-left: 1.25rem; /* align with text after icon */
  margin-top: 0.25rem;
  padding: 0.5rem;
  background: var(--bg-secondary);
  border-radius: 0.5rem;
  border: 1px solid var(--bg-elevated);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}
```

## Next Steps

1. Review this spec and confirm direction
2. Create a prototype with real session data
3. Implement cross-linking between conversation and diff panel
4. Test with various session types (short, long, tool-heavy, text-heavy)
