# Session Detail View

This document specifies the UI for viewing an individual session.

## Overview

The session detail view displays a Claude Code session as a reviewable artifact. The **primary focus is the code changes and conversation**—the header and footer provide context and actions but should not dominate the viewport.

## Layout Structure

```
┌────────────────────────────────────────────────────────────────────┐
│ Header (compact, single line)                                      │
│   Title · project · date                   [View PR] [Share] [Export] │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────────┐  ┌───────────────────────────────────────────┐ │
│  │  Conversation  │  │  Code Changes                             │ │
│  │    (~1/3)      │  │    (~2/3)                                 │ │
│  │                │  │                                           │ │
│  │  ┌──────────┐  │  │  ┌─────────────────────────────────────┐  │ │
│  │  │ YOU      │  │  │  │ src/file.ts              -5 +12    │  │ │
│  │  │ message  │  │  │  ├─────────────────────────────────────┤  │ │
│  │  └──────────┘  │  │  │                                     │  │ │
│  │                │  │  │  syntax-highlighted unified diff    │  │ │
│  │  ┌──────────┐  │  │  │  via @pierre/diffs                  │  │ │
│  │  │ CLAUDE   │  │  │  │                                     │  │ │
│  │  │ response │  │  │  └─────────────────────────────────────┘  │ │
│  │  └──────────┘  │  │                                           │ │
│  │                │  │  ┌─────────────────────────────────────┐  │ │
│  │  (scrollable)  │  │  │ src/other.ts              -2 +8    │  │ │
│  │                │  │  │ ...                                 │  │ │
│  │                │  │  └─────────────────────────────────────┘  │ │
│  │                │  │                                           │ │
│  │                │  │  (scrollable)                             │ │
│  └────────────────┘  └───────────────────────────────────────────┘ │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ Footer (utility bar)                                               │
│   Resume: claude --resume abc123  [📋]    Share: url...  [📋]      │
└────────────────────────────────────────────────────────────────────┘
```

### Layout Principles

1. **Content-first**: Header ~48px, footer ~40px, panels fill remaining viewport height
2. **1/3 + 2/3 split**: Conversation is context; diffs are the main artifact being reviewed
3. **Independent scroll**: Each panel scrolls independently, no page-level scroll
4. **Responsive**: Panels stack vertically on mobile (`< lg` breakpoint)

### CSS Grid Structure

```css
/* Desktop (lg+) with diffs */
.session-detail {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100vh;
}

.content-panels {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 1rem;
  min-height: 0; /* Allow panels to shrink */
}

.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
}
```

## Header

Single-line header with title, metadata, and actions.

```
┌────────────────────────────────────────────────────────────────────┐
│  Session Title · project/path · Jan 11, 2025    [PR] [Share] [Export] │
└────────────────────────────────────────────────────────────────────┘
```

### Elements

| Element | Style | Notes |
|---------|-------|-------|
| Title | `text-lg font-semibold text-primary` | Primary visual anchor |
| Project path | `text-sm font-mono text-muted` | Truncate if long |
| Date | `text-sm text-muted` | Relative or absolute |
| Separator | `·` in `text-muted` | Between metadata items |
| Actions | Secondary buttons, `gap-2` | Right-aligned |

### Action Buttons

- **View PR**: Only shown if `pr_url` exists, opens in new tab
- **Share**: Creates share link (or shows "Shared" state if already shared)
- **Export**: Downloads session as JSON

### Description (Optional)

If the session has a description, show it on a second line below the title row:
```
Title · project · date                              [actions]
Description text here (text-sm text-secondary)
```

This makes the header 2 lines instead of 1, which is acceptable for added context.

## Footer

Utility bar for resume and share commands. Always visible but visually subdued.

```
┌────────────────────────────────────────────────────────────────────┐
│  RESUME  claude --resume abc123  [📋]     SHARE  https://...  [📋] │
└────────────────────────────────────────────────────────────────────┘
```

### Elements

| Element | Style |
|---------|-------|
| Labels | `text-xs uppercase tracking-wide text-muted` |
| Commands/URLs | `font-mono text-sm text-accent-primary` |
| Copy buttons | Icon button, `text-muted` → `text-primary` on hover |
| Container | `bg-secondary border-t border-elevated` |

### States

- **No share URL**: Only show resume command (left-aligned or centered)
- **With share URL**: Show both, separated by generous gap or divider

## Content Panels

### Conversation Panel (~1/3 width)

Shows the message exchange between user and Claude.

#### Panel Header
```
Conversation                                    42 messages
```
- Title: `text-sm font-medium`
- Count: `text-xs text-muted`

#### Message Block

```
┌─────────────────────────────────────────┐
│ YOU                                     │
│                                         │
│ Message content with formatting:        │
│ - `inline code` highlighted             │
│ - ```code blocks``` with syntax         │
│ - **bold** and line breaks              │
└─────────────────────────────────────────┘
```

| Element | Style |
|---------|-------|
| Role label | `text-xs font-semibold uppercase tracking-wider` |
| User role | `text-role-user` (#6eb5ff) |
| Claude role | `text-role-assistant` (#2dd4bf) |
| User message bg | Default (`bg-secondary`) |
| Claude message bg | `bg-tertiary` (subtle distinction) |
| Content | `text-sm leading-relaxed` |
| Dividers | `border-b border-elevated` between messages |

### Message Content Types

Messages contain an array of content blocks. Each block type has specific rendering behavior, following patterns from Claude Code's TUI.

#### Content Block Types

| Type | Description | Default State |
|------|-------------|---------------|
| `text` | Plain text or markdown | Expanded |
| `tool_use` | Claude invoking a tool | Collapsed |
| `tool_result` | Output from a tool (inline with tool_use) | Collapsed |
| `thinking` | Extended thinking block | Collapsed |
| `image` | Image attachment | Placeholder text |
| `file` | File attachment | Placeholder text |

#### Text Blocks

Standard markdown-formatted text. Render with:
- Inline code: `code` with accent highlight
- Code blocks: syntax highlighting, horizontal scroll
- Bold, italic, links
- Line breaks preserved

```
┌─────────────────────────────────────────┐
│ CLAUDE                                  │
│                                         │
│ I'll help you refactor that function.   │
│ Let me read the file first.             │
└─────────────────────────────────────────┘
```

#### Tool Use + Result (Inline)

Tool calls and their results are displayed together as a single unit, like the TUI. The result is nested under its tool_use, not shown as a separate message.

**Collapsed (default):**
```
┌─────────────────────────────────────────┐
│ ▶ Read  src/components/Button.tsx  ✓    │
└─────────────────────────────────────────┘
```

**Collapsed with error:**
```
┌─────────────────────────────────────────┐
│ ▶ Read  src/missing.tsx  ✗ Not found    │
└─────────────────────────────────────────┘
```

**Expanded:**
```
┌─────────────────────────────────────────┐
│ ▼ Read  src/components/Button.tsx  ✓    │
├─────────────────────────────────────────┤
│ Input:                                  │
│   file_path: src/components/Button.tsx  │
├─────────────────────────────────────────┤
│ Result: (142 lines)                     │
│ ┌─────────────────────────────────────┐ │
│ │ 1  import React from 'react';       │ │
│ │ 2  import { cn } from '../utils';   │ │
│ │ 3  ...                              │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

| Tool | Summary Format |
|------|----------------|
| Read | `Read {file_path}` |
| Write | `Write {file_path}` |
| Edit | `Edit {file_path}` |
| Bash | `Bash {command}` (truncated to ~40 chars) |
| Glob | `Glob {pattern}` |
| Grep | `Grep {pattern}` |
| Task | `Task {description}` |
| WebFetch | `WebFetch {url}` |
| WebSearch | `WebSearch {query}` |
| AskUser | `AskUser` |
| TodoWrite | `TodoWrite` |
| Other | `{tool_name}` |

**Styling:**
- Icon: `▶` / `▼` toggle indicator
- Tool name: `font-semibold text-accent-primary`
- Summary: `font-mono text-sm text-muted`, truncate with ellipsis
- Status: `✓` in `text-diff-add`, `✗` in `text-diff-del`
- Expanded input: key-value pairs, `text-xs text-muted`
- Expanded result: scrollable, syntax highlighting where applicable
- Large results (>100 lines): show truncated with "Show all" link

**Matching tool_use to tool_result:**

Tool results reference their tool_use by `tool_use_id`. When rendering:
1. Parse all content blocks in the message sequence
2. For each `tool_use`, find its matching `tool_result` (may be in next message)
3. Render them together as a single collapsible unit
4. If no result found (e.g., interrupted session), show `⋯ pending`

#### Image Blocks

Images are shown as text placeholders (no inline rendering).

```
┌─────────────────────────────────────────┐
│ [Image: screenshot.png (1.2 MB)]        │
└─────────────────────────────────────────┘
```

Or if no filename:
```
┌─────────────────────────────────────────┐
│ [Image: 1024×768 PNG]                   │
└─────────────────────────────────────────┘
```

**Styling:**
- Container: `bg-tertiary rounded px-2 py-1 inline-block`
- Text: `text-sm text-muted font-mono`

#### File Blocks

File attachments shown as text placeholders.

```
┌─────────────────────────────────────────┐
│ [File: data.csv (24 KB)]                │
└─────────────────────────────────────────┘
```

**Styling:** Same as image blocks.

#### Thinking Blocks

Extended thinking is private reasoning. Show presence but collapsed.

**Collapsed (default):**
```
┌─────────────────────────────────────────┐
│ ▶ Thinking  (12.4s)                     │
└─────────────────────────────────────────┘
```

**Expanded:**
```
┌─────────────────────────────────────────┐
│ ▼ Thinking  (12.4s)                     │
├─────────────────────────────────────────┤
│ Let me analyze the codebase structure.  │
│ The user wants to...                    │
│ ...                                     │
└─────────────────────────────────────────┘
```

**Styling:**
- Label: `text-muted italic`
- Duration: `text-xs text-muted` (if available)
- Content: `text-sm text-secondary`, no special formatting

#### Content Block Ordering

Within a rendered message, blocks appear in order:
1. Thinking (if present) — at top of assistant turn
2. Text — conversational content
3. Tool use + result pairs — actions and their outcomes together

Tool results are **not** shown as separate messages. They're matched to their tool_use and rendered inline.

**Example: A typical assistant turn**
```
┌─────────────────────────────────────────┐
│ CLAUDE                                  │
│                                         │
│ ▶ Thinking  (8.2s)                      │
│                                         │
│ I'll update the Button component to     │
│ support the new variant prop.           │
│                                         │
│ ▶ Read  src/components/Button.tsx  ✓    │
│ ▶ Edit  src/components/Button.tsx  ✓    │
│ ▶ Edit  src/components/Button.test.tsx ✓│
└─────────────────────────────────────────┘
```

**Example: With an error**
```
┌─────────────────────────────────────────┐
│ CLAUDE                                  │
│                                         │
│ Let me check that configuration file.   │
│                                         │
│ ▶ Read  config/settings.json  ✗ ENOENT  │
│                                         │
│ The file doesn't exist. Let me create   │
│ it with the default settings.           │
│                                         │
│ ▶ Write  config/settings.json  ✓        │
└─────────────────────────────────────────┘
```

**Example: User message with image**
```
┌─────────────────────────────────────────┐
│ YOU                                     │
│                                         │
│ Here's a screenshot of the error:       │
│                                         │
│ [Image: error-screenshot.png (340 KB)]  │
│                                         │
│ Can you help debug this?                │
└─────────────────────────────────────────┘
```

### Special Tool Rendering

Some tools have custom rendering beyond the standard collapsed/expanded pattern.

#### AskUserQuestion

Renders as a Q&A block showing the question and the user's response.

```
┌─────────────────────────────────────────┐
│ ❓ Question                             │
│                                         │
│ Which database do you want to use?      │
│                                         │
│ → PostgreSQL                            │
└─────────────────────────────────────────┘
```

If multiple options were selected (multiSelect):
```
┌─────────────────────────────────────────┐
│ ❓ Question                             │
│                                         │
│ Which features do you want to enable?   │
│                                         │
│ → Authentication                        │
│ → Rate limiting                         │
│ → Logging                               │
└─────────────────────────────────────────┘
```

**Styling:**
- Icon: `❓` or question mark icon
- Question text: `text-sm text-primary`
- Answer prefix: `→` in `text-accent-primary`
- Answer text: `text-sm font-medium`
- Container: `bg-tertiary/50 rounded-lg p-3`

#### TodoWrite

Renders as a checklist showing task status.

```
┌─────────────────────────────────────────┐
│ 📋 Tasks                                │
│                                         │
│ ✓ Set up project structure              │
│ ✓ Create database schema                │
│ ● Implement API endpoints               │
│ ○ Write tests                           │
│ ○ Add documentation                     │
└─────────────────────────────────────────┘
```

**Status indicators:**
- `✓` Completed - `text-diff-add`
- `●` In progress - `text-accent-primary`
- `○` Pending - `text-muted`

**Styling:**
- Header: `📋 Tasks` or checklist icon
- Items: `text-sm`, status icon + text
- Container: `bg-tertiary/50 rounded-lg p-3`

#### Task (Sub-agents)

Sub-agent output is shown nested with a visual indent.

**Collapsed:**
```
┌─────────────────────────────────────────┐
│ ▶ Task  Exploring codebase  ✓           │
└─────────────────────────────────────────┘
```

**Expanded:**
```
┌─────────────────────────────────────────┐
│ ▼ Task  Exploring codebase  ✓           │
├─────────────────────────────────────────┤
│ │ I'll search for authentication code.  │
│ │                                       │
│ │ ▶ Grep  "auth"  ✓                     │
│ │ ▶ Read  src/auth/index.ts  ✓          │
│ │                                       │
│ │ Found the auth module in src/auth/.   │
└─────────────────────────────────────────┘
```

**Styling:**
- Nested content has left border: `border-l-2 border-elevated pl-3`
- Sub-agent tool calls rendered recursively
- Description from Task input shown in header

### Timestamps

Timestamps are shown on hover to keep the UI clean.

**Default:** No timestamp visible
**On hover:** Timestamp appears near the role label

```
┌─────────────────────────────────────────┐
│ CLAUDE                      2:34:12 PM  │  ← appears on hover
│                                         │
│ I'll help you with that.                │
└─────────────────────────────────────────┘
```

**Styling:**
- Position: Right-aligned in message header
- Visibility: `opacity-0` → `opacity-100` on message hover
- Format: Time only for same-day, date+time otherwise
- Color: `text-muted text-xs`

### Long Text Truncation

Very long text blocks are truncated with a "Show more" control.

**Threshold:** Text blocks >50 lines or >4000 characters are truncated.

**Truncated state:**
```
┌─────────────────────────────────────────┐
│ CLAUDE                                  │
│                                         │
│ Here's a detailed explanation of the    │
│ authentication flow in your application │
│ ...                                     │
│ (showing 50 of 342 lines)               │
│                                         │
│ [Show more]                             │
└─────────────────────────────────────────┘
```

**Styling:**
- Fade: Last few lines have `bg-gradient-to-b from-transparent to-bg-tertiary`
- Count: `text-xs text-muted`
- Button: `text-sm text-accent-primary hover:underline`

### Copy Actions

Users can copy message content and code blocks.

#### Message Copy

Each message has a copy button on hover.

```
┌─────────────────────────────────────────┐
│ CLAUDE                            [📋]  │  ← copy button on hover
│                                         │
│ Here's the solution...                  │
└─────────────────────────────────────────┘
```

**Behavior:**
- Copies full message text content (excludes tool calls)
- Shows toast: "Copied to clipboard"

#### Code Block Copy

Code blocks have an individual copy button.

```
┌─────────────────────────────────────────┐
│ ```typescript                     [📋]  │
│ function greet(name: string) {          │
│   return `Hello, ${name}!`;             │
│ }                                       │
│ ```                                     │
└─────────────────────────────────────────┘
```

**Behavior:**
- Copies code content only (no markdown fences)
- Button appears on hover over code block

#### Tool Result Copy

Expanded tool results have a copy button.

**Styling for all copy buttons:**
- Icon: clipboard SVG, 16x16
- Position: top-right of container
- Visibility: `opacity-0 group-hover:opacity-100`
- Color: `text-muted hover:text-primary`

### Diff Linking

When a tool modifies a file that appears in the diff panel, show a link.

```
┌─────────────────────────────────────────┐
│ ▶ Edit  src/Button.tsx  ✓  [→ diff]     │
└─────────────────────────────────────────┘
```

**Behavior:**
- `[→ diff]` link appears if `filename` matches a diff
- Clicking scrolls diff panel to that file and highlights it briefly
- Link: `text-xs text-accent-primary hover:underline`

**Implementation notes:**
- Match tool input `file_path` against `diffs[].filename`
- Use `scrollIntoView()` with `behavior: 'smooth'`
- Add temporary highlight class that fades out

### Message Index

Messages have an index for reference and future "jump to" functionality.

```
┌─────────────────────────────────────────┐
│ #12  CLAUDE                             │
│                                         │
│ I'll help you with that.                │
└─────────────────────────────────────────┘
```

**Styling:**
- Index: `text-xs text-muted font-mono`
- Position: Before role label, or on hover only
- Format: `#1`, `#2`, etc. (1-indexed for human readability)

**Future use:**
- URL fragment: `/sessions/abc#msg-12`
- Search results: "Found in message #12"
- Cross-references: "As mentioned in #5..."

### Empty Text Messages

Messages with only tool calls (no text) render without the text block.

```
┌─────────────────────────────────────────┐
│ CLAUDE                                  │
│                                         │
│ ▶ Read  package.json  ✓                 │
│ ▶ Read  tsconfig.json  ✓                │
│ ▶ Glob  "src/**/*.ts"  ✓                │
└─────────────────────────────────────────┘
```

No special handling needed—just don't render empty text nodes.

### Interrupted Sessions

Sessions may be interrupted mid-response. Handle gracefully.

**Partial text (streaming interrupted):**
```
┌─────────────────────────────────────────┐
│ CLAUDE                                  │
│                                         │
│ I'll update the configuration to        │
│ ⋯                                       │  ← indicates incomplete
└─────────────────────────────────────────┘
```

**Tool call without result:**
```
┌─────────────────────────────────────────┐
│ ▶ Edit  src/config.ts  ⋯ interrupted    │
└─────────────────────────────────────────┘
```

**Styling:**
- Indicator: `⋯` in `text-muted`
- Label: "interrupted" in `text-xs text-muted italic`
- No error styling (not an error, just incomplete)

### Virtualization

For long conversations (100+ messages), use virtualization to maintain performance.

**Strategy:**
- Render only visible messages + buffer (e.g., ±10 messages)
- Use `IntersectionObserver` or virtual scroll library
- Maintain scroll position when expanding/collapsing content
- Preserve expanded state for tool calls across re-renders

**Threshold:** Enable virtualization when `messages.length > 100`

**Implementation options:**
- Custom implementation with `IntersectionObserver`
- Library: `@tanstack/virtual` or similar lightweight option

**Considerations:**
- Message heights vary (expanded tool calls, code blocks)
- Need to estimate heights or measure dynamically
- "Jump to message" must work with virtualization

### Code Changes Panel (~2/3 width)

Shows all file diffs from the session. This is the **primary artifact** being reviewed.

#### Panel Header
```
Code Changes                                     8 files
```

#### File Diff Block

```
┌─────────────────────────────────────────┐
│ src/components/Button.tsx      -5 +12   │  ← Sticky file header
├─────────────────────────────────────────┤
│                                         │
│  (rendered by @pierre/diffs)            │
│  - Syntax highlighting                  │
│  - Line numbers                         │
│  - Unified diff format                  │
│  - Dark theme                           │
│                                         │
└─────────────────────────────────────────┘
```

| Element | Style |
|---------|-------|
| Filename | `font-mono text-[13px] text-primary` |
| Deletions | `text-diff-del` (#f87171), e.g., "-5" |
| Additions | `text-diff-add` (#2dd4bf), e.g., "+12" |
| File header | `bg-tertiary`, sticky within scroll container |
| Diff content | Rendered via `@pierre/diffs` web component |

#### Collapsible Diffs

Large diffs should be collapsible, similar to GitHub's behavior:

- **Collapse threshold**: Files with >300 lines changed are collapsed by default
- **Collapsed state**: Show file header with +N/-M stats, "Show diff" button
- **Expanded state**: Full diff with "Hide diff" toggle in header
- **User control**: Click header or button to toggle; state persists during session

```
┌─────────────────────────────────────────────────────────────────┐
│ src/generated/schema.ts                   -1,240 +1,892  [Show] │
└─────────────────────────────────────────────────────────────────┘
```

#### @pierre/diffs Configuration

```typescript
new FileDiff({
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  disableFileHeader: true,  // We render our own header
  overflow: "scroll",
})
```

### Without Diffs

When a session has no diffs, the conversation panel takes full width:

```css
.content-panels.no-diffs {
  grid-template-columns: 1fr;
}
```

## Responsive Behavior

### Mobile (< lg)

```
┌─────────────────────────────┐
│ Header                      │
│ Title · date    [actions]   │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ Conversation            │ │
│ │ (full width, ~40vh)     │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ Code Changes            │ │
│ │ (full width, ~40vh)     │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ Footer (stacked or hidden)  │
└─────────────────────────────┘
```

- Panels stack vertically with fixed heights
- Footer may collapse to icon-only or hide behind a menu
- Horizontal scroll for wide diffs
- Touch-friendly tap targets (min 44px)

### Tablet (lg to xl)

- Side-by-side panels with 1/3 + 2/3 split
- Footer fully visible
- May reduce padding slightly

## Loading, Error, and Empty States

### Loading State

Shown while fetching session data.

```
┌────────────────────────────────────────────────────────────────────┐
│ Header (skeleton)                                                  │
│   ████████████ · ████████ · ████████        [░░░] [░░░░] [░░░░░]  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────────┐  ┌───────────────────────────────────────────┐ │
│  │ Conversation   │  │ Code Changes                              │ │
│  ├────────────────┤  ├───────────────────────────────────────────┤ │
│  │                │  │                                           │ │
│  │  ░░░░░░░░░░░   │  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ │
│  │  ░░░░░░░░░░░   │  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ │
│  │  ░░░░░░░░░░░   │  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │ │
│  │                │  │                                           │ │
│  └────────────────┘  └───────────────────────────────────────────┘ │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ Footer (skeleton)                                                  │
└────────────────────────────────────────────────────────────────────┘
```

**Implementation:**
- Skeleton placeholders with `bg-elevated animate-pulse`
- Panel structure visible immediately (no layout shift)
- Skeleton for header title, metadata, buttons
- Skeleton blocks in panel bodies

### Error State

Shown when session fails to load.

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│                         ⚠️                                         │
│                                                                    │
│                  Session not found                                 │
│                                                                    │
│        This session may have been deleted or the link              │
│        may be incorrect.                                           │
│                                                                    │
│                    [Go to Sessions]                                │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Error types:**
| Error | Message |
|-------|---------|
| 404 | "Session not found" |
| 403 | "You don't have access to this session" |
| 500 | "Something went wrong. Please try again." |
| Network | "Unable to connect. Check your internet connection." |

**Styling:**
- Icon: `text-4xl` centered
- Title: `text-lg font-semibold text-primary`
- Description: `text-sm text-secondary max-w-md text-center`
- Button: Primary style, links to `/`

### Empty Conversation

Session exists but has no messages (edge case, likely bad import).

```
┌─────────────────────────────────────────┐
│ Conversation                 0 messages │
├─────────────────────────────────────────┤
│                                         │
│              No messages                │
│                                         │
│   This session has no conversation      │
│   data. It may have been imported       │
│   incorrectly.                          │
│                                         │
└─────────────────────────────────────────┘
```

**Styling:**
- Centered in panel
- Icon or illustration (optional)
- `text-sm text-muted`

### Empty Diffs

Session has conversation but no diffs (valid state - not all sessions produce code changes).

When there are no diffs, the conversation panel takes full width (already spec'd). No empty state message needed for diffs panel since it simply doesn't render.

### Diff Render Error

Individual diff fails to parse/render.

```
┌─────────────────────────────────────────────────────────────────┐
│ src/broken-file.ts                                   -? +?      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ⚠️ Unable to render diff                                      │
│                                                                 │
│   The diff content could not be parsed.                         │
│   [Show raw diff]                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Show warning inline in diff block
- "Show raw diff" reveals plain text content
- Doesn't block other diffs from rendering

## Shared Sessions

The `/s/:shareToken` route displays a shared session. UI is nearly identical to the regular session view with minor differences.

### Differences from Regular View

| Element | Regular View | Shared View |
|---------|--------------|-------------|
| URL | `/sessions/:id` | `/s/:shareToken` |
| Delete action | Available | Hidden |
| Share button | "Share" / "Shared ✓" | Hidden (already shared) |
| Footer resume | Shows command | Same |
| Footer share URL | Shows if shared | Always shows current URL |

### Shared View Header

```
┌────────────────────────────────────────────────────────────────────┐
│  Session Title · project · date                   [View PR] [Export] │
└────────────────────────────────────────────────────────────────────┘
```

- No "Share" button (redundant)
- No "Delete" button (viewers can't delete)
- Export still available

### Shared Badge (Optional)

Could show a subtle indicator that this is a shared view:

```
┌────────────────────────────────────────────────────────────────────┐
│  🔗 Shared · Session Title · project · date         [PR] [Export]  │
└────────────────────────────────────────────────────────────────────┘
```

Or in footer:
```
┌────────────────────────────────────────────────────────────────────┐
│  RESUME  claude --resume abc123  [📋]     🔗 Shared link           │
└────────────────────────────────────────────────────────────────────┘
```

### Access Control (Future)

When Phase 2 access control is implemented:
- Shared sessions may require authentication
- Show "Sign in to view" if auth required but not signed in
- Show owner/sharer info: "Shared by @username"

## Future Improvements

Items not yet spec'd in detail. See `north_star.md` for roadmap context.

### Conversation Enhancements

- **Full markdown**: Headers, lists, tables (currently: code, bold, links only)
- **Syntax highlighting**: Language detection for code blocks
- **Search**: Find text within conversation, highlight matches
- **Keyboard navigation**: Arrow keys to move between messages, Enter to expand

### Diff Enhancements

- **File TOC**: Sticky sidebar or dropdown listing all changed files for quick jump
- **Sticky headers**: File headers stick while scrolling within that file's diff
- **Expand context**: Click to show more surrounding unchanged lines
- **Side-by-side view**: Toggle between unified and split diff view

### Phase 3: Interactive Feedback

- **Inline comments**: Click diff line to add comment, threaded replies
- **Session-level feedback**: Approve/request changes actions
- **Action triggers**: "Fix this" button spawns new Claude session with context

## Data Requirements

### Schema Changes

The current schema stores `content` as a flat string, losing tool call structure. The new schema preserves full fidelity.

**Current (to be migrated):**
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,        -- Flat string, loses structure
  timestamp TEXT,
  message_index INTEGER
);
```

**New schema:**
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'tool'
  content_blocks TEXT NOT NULL, -- JSON array of content blocks
  timestamp TEXT,
  message_index INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

The `content_blocks` column stores a JSON array preserving the full Claude API structure.

### Content Block Schema

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; thinking: string; duration_ms?: number }
  | { type: "image"; source: ImageSource; filename?: string }
  | { type: "file"; filename: string; media_type?: string; size?: number };

type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";  // tool_results merged into assistant messages
  content_blocks: ContentBlock[];
  timestamp: string | null;
  message_index: number;
}
```

**Note:** Tool results are stored separately in the JSONL but merged into the preceding assistant message at render time. The `role: "tool"` messages from Claude's API are transformed during parsing.

### Special Tool Input Schemas

Some tools have structured input that enables custom rendering.

```typescript
// AskUserQuestion - renders as Q&A
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  // Result contains the selected answers
}

// TodoWrite - renders as checklist
interface TodoWriteInput {
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

// Task - renders nested agent output
interface TaskInput {
  prompt: string;
  description: string;  // Short description for collapsed view
  // Result contains the sub-agent's full conversation
}
```

The renderer checks `tool_use.name` and parses `input` accordingly for custom display.

### API Response

```typescript
interface SessionDetailData {
  session: {
    id: string;
    title: string;
    description: string | null;
    claude_session_id: string | null;
    project_path: string | null;
    pr_url: string | null;
    created_at: string;
  };
  messages: Message[];
  diffs: Array<{
    filename: string | null;
    diff_content: string;
    diff_index: number;
    additions: number;    // Pre-computed for display
    deletions: number;
  }>;
  shareUrl: string | null;
}
```

### Migration Strategy

1. Add `content_blocks` column (nullable initially)
2. Migrate existing data: wrap flat `content` in `[{ type: "text", text: content }]`
3. Update ingest to parse and store structured content
4. Update API to return `content_blocks`
5. Drop old `content` column (or keep for backward compat)

### Parsing Claude Code JSONL

Claude Code's native format stores messages with content arrays:

```jsonl
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read that file."},{"type":"tool_use","id":"xyz","name":"Read","input":{"file_path":"src/index.ts"}}]}}
{"type":"tool_result","tool_use_id":"xyz","content":"file contents here..."}
```

The parser should:
1. Preserve the full `content` array for assistant messages
2. Convert `tool_result` entries into messages with role `"tool"`
3. Handle legacy flat-string formats by wrapping in text blocks

### Diff Relevance Filtering

When uploading a session, the provided diff may include files not touched in the conversation (e.g., full branch diff vs session-specific changes). Additionally, files touched in the conversation may not appear in the diff (e.g., untracked files, or files edited then reverted).

**Extract touched files from conversation:**
```typescript
function extractTouchedFiles(messages: Message[]): Set<string> {
  const files = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content_blocks) {
      if (block.type === "tool_use") {
        // File-modifying tools
        if (["Write", "Edit", "NotebookEdit"].includes(block.name)) {
          const path = block.input.file_path || block.input.notebook_path;
          if (path) files.add(normalizePath(path));
        }
      }
    }
  }

  return files;
}
```

**Display strategies:**

1. **Filter diffs to relevant files**: Only show diffs for files touched in conversation
   - Pro: Cleaner, focused view
   - Con: May miss related changes (e.g., auto-generated files)

2. **Highlight relevant files**: Show all diffs but visually distinguish files touched in conversation
   - Pro: Complete picture
   - Con: More visual noise

3. **Group by relevance**: "Files changed in this session" section + "Other changes" section (collapsed)
   - Pro: Best of both worlds
   - Con: More complex UI

**Recommended approach:** Option 3 - Group by relevance

```
┌─────────────────────────────────────────────────────────────────┐
│ Code Changes                                          8 files   │
├─────────────────────────────────────────────────────────────────┤
│ Changed in this session (3)                                     │
│   ▼ specs/session_detail_view.md                    -50 +420    │
│   ▼ specs/ui_overview.md                            -0 +205     │
│   ▼ CLAUDE.md                                       -0 +33      │
├─────────────────────────────────────────────────────────────────┤
│ ▶ Other branch changes (5)                                      │
│   bun.lock, package.json, src/client/index.ts...                │
└─────────────────────────────────────────────────────────────────┘
```

**Data model addition:**
```typescript
interface Diff {
  // ... existing fields
  is_session_relevant: boolean;  // true if file was touched in conversation
}
```

## Accessibility

- Role labels use semantic color + text (not color alone)
- Copy buttons have `title` and `aria-label` attributes
- Scrollable regions are keyboard navigable
- Focus management when panels load
- Sufficient color contrast (WCAG AA minimum)
