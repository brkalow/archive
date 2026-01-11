# UI Overview

This document describes the overall UI architecture and design system for the Session Archive application.

## Design Philosophy

- **Dark-first**: All interfaces designed for dark mode, optimized for developer workflows
- **Information density**: Balance readability with showing relevant context
- **Read-only clarity**: UI reinforces that this is a viewing/sharing tool, not an editor
- **Artifact-oriented**: Sessions are treated like PRs—reviewable snapshots of work

## Visual Inspiration

- Near-black backgrounds with high contrast text
- Large, confident typography for headlines
- Code/diff display as the central visual element
- Generous whitespace and clean visual hierarchy
- Pill-shaped buttons and subtle rounded corners
- Minimal headers with sparse navigation

## Application Structure

### Routes

| Route | View | Purpose |
|-------|------|---------|
| `/` | Session List | Browse and search all sessions |
| `/sessions/:id` | Session Detail | View conversation and diffs for a session |
| `/s/:shareToken` | Shared Session | Public view of a shared session |

### Layout

```
┌─────────────────────────────────────────────────────┐
│ Header (sticky)                                     │
│   Logo / Title             (future: user menu)     │
├─────────────────────────────────────────────────────┤
│                                                     │
│                  Main Content                       │
│               (max-width: 6xl)                      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Color System

### Background Colors (darkest to lightest)
| Token | Hex | Usage |
|-------|-----|-------|
| `bg-primary` | `#0a0a0a` | Page background (near-black) |
| `bg-secondary` | `#141414` | Cards, panels |
| `bg-tertiary` | `#1a1a1a` | Panel headers, alternate rows |
| `bg-elevated` | `#222222` | Borders, subtle depth |
| `bg-hover` | `#2a2a2a` | Hover states |

### Text Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `text-primary` | `#e8e8e8` | Primary content |
| `text-secondary` | `#a0a0a0` | Secondary content, descriptions |
| `text-muted` | `#666666` | Hints, timestamps, labels |

### Accent Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `accent-primary` | `#6eb5ff` | Links, interactive elements, user role |
| `accent-secondary` | `#a78bfa` | Reserved for future use |

### Semantic Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `diff-add` | `#2dd4bf` | Additions, success states, assistant role |
| `diff-del` | `#f87171` | Deletions, error states |
| `diff-hunk` | `#6eb5ff` | Diff hunk headers |
| `role-user` | `#6eb5ff` | User message indicator |
| `role-assistant` | `#2dd4bf` | Assistant message indicator |

## Component Patterns

### Header
- Minimal: logo/title on left, sparse navigation on right
- Background: `bg-primary` or transparent
- Border: None or subtle 1px `bg-elevated` bottom border
- Height: ~60px with centered content
- Nav items: `text-secondary` → `text-primary` on hover

### Cards
- Background: `bg-secondary`
- Border: `border-bg-elevated` (subtle, 1px)
- Border radius: `rounded-lg` (8px)
- Hover: `bg-tertiary`, `border-bg-hover`
- Transition: `transition-colors`

### Buttons
**Primary:**
- Shape: Pill (`rounded-full`) or rounded (`rounded-lg`)
- Background: `bg-primary` with `text-primary` (inverted on light) or `accent-primary`
- Padding: `px-4 py-2` minimum
- Font: `font-medium`

**Secondary:**
- Background: `bg-tertiary` → `bg-elevated` on hover
- Border: `border-bg-elevated`
- Text: `text-primary`
- Shape: Match primary (pill or rounded)

**Icon buttons:**
- Square aspect ratio with `rounded-lg`
- Background: transparent → `bg-tertiary` on hover
- Size: 32-40px

### Input Fields
- Background: `bg-secondary`
- Border: `border-bg-elevated` → `border-accent-primary` on focus
- Border radius: `rounded-lg`
- Placeholder: `text-muted`

### Panels
- Wrapper: `bg-secondary`, `border-bg-elevated`, `rounded-lg`
- Header: `bg-tertiary`, bottom border
- Content: scrollable with `max-h-[70vh]`

### Diff Display
- **File header**: Filename left, change stats (`+N -M`) right in green/red
- **Line numbers**: Muted gray (`text-muted`), right-aligned, monospace
- **Additions**: Green background tint with green text accent
- **Deletions**: Red background tint with red text accent
- **Collapsed sections**: "N unmodified lines" clickable expander
- **Syntax highlighting**: Use `@pierre/diffs` component styling

## Typography

### Headlines
- Size: `text-2xl` to `text-4xl` depending on context
- Weight: `font-semibold` to `font-bold`
- Letter-spacing: Tight (`tracking-tight` or `-0.02em`)
- Color: `text-primary`

### Body Text
- Size: `text-sm` (14px) default, `text-base` (16px) for emphasis
- Weight: `font-normal`
- Line height: `leading-relaxed` for readable blocks
- Color: `text-primary` for main content, `text-secondary` for supporting text

### Small/Meta
- Size: `text-xs` (12px)
- Color: `text-muted`
- Use for timestamps, labels, hints

### Monospace
- Font: `font-mono` for code, paths, commands, filenames
- Slightly smaller than surrounding text when inline

## Spacing

- **Page padding**: `px-4` on mobile, `px-6` to `px-8` on larger screens
- **Section spacing**: `py-8` to `py-12` between major sections
- **Card padding**: `p-4` to `p-6`
- **Component gaps**: `gap-4` default, `gap-6` for larger layouts
- **Generous whitespace**: Prefer more space over cramped layouts

## Responsive Breakpoints

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| Default | < 640px | Single column, stacked layout |
| `sm` | ≥ 640px | 2-column session grid |
| `lg` | ≥ 1024px | 3-column session grid; side-by-side panels in detail |

## Interactive Patterns

### Toast Notifications
- Position: bottom-right
- Auto-dismiss: 3 seconds
- Types: success (teal), error (red)
- Animation: slide in from bottom

### Copy to Clipboard
- Icon button with hover state
- Shows toast on success

### Search/Filter
- Client-side filtering (instant)
- Filters on title, description, project path

## Future UI Considerations

### Phase 2: Access Control
- User avatar/menu in header
- Login/logout flow
- Permission indicators on sessions

### Phase 3: Interactive Feedback
- Comment threads on diffs
- Inline annotations
- Action buttons (approve, request changes)
- Live session indicators

## Implementation Notes

- **Rendering**: Template strings in `views.ts`, no framework
- **Routing**: Custom client-side router via History API
- **Styling**: Tailwind CSS v4 with custom theme variables
- **Diff rendering**: `@pierre/diffs` web component
