# Figma V1 Design Refinements

**Date:** 2026-03-04
**Status:** Ready for implementation

## What We're Building

Refining the dashboard UI to exactly match the Figma V1 design. The initial migration captured the overall structure but deviated in several key areas: typography spacing, icon sizing/design, sidebar widget concept, chat input positioning, and progress bar visibility logic.

## Why This Matters

The design philosophy is **widget-based navigation** (like smartphone/tablet home screens), NOT a standard chat sidebar like Claude/ChatGPT. Every visual deviation undermines this concept. Pixel-level fidelity to the Figma design is critical.

## Key Decisions

### 1. Typography & Spacing
- **Decision:** Reduce font sizes and increase spacing to match Figma's lighter, more spacious feel
- **Specifics:** Profile section needs more gap between "User Name" and "Role Information". Current version has them too close together. The Figma uses Helvetica Light with generous vertical spacing.
- **Overall:** Font weight should lean heavily on `light` (300), text should feel airy, not dense

### 2. App Dock Icons — Use Exact Figma Code
- **Decision:** Replace current icon implementations with exact SVG paths from Figma export
- **Source:** Figma AI export provides `Apps.tsx` + `svg-qg7iprjsto.ts` with precise SVG path data
- **Icons:** Calendar (Wed + day number), Logbook (orange gradient book), Email (blue gradient 3D envelope), Workflow Library (colorful grid + search bar)
- **Size:** Icons are 65px in Figma but current version renders them too large relative to the sidebar. Must match Figma proportions exactly.

### 3. Remove "All Workflows" Text
- **Decision:** Delete the "All Workflows" expandable section from the sidebar entirely
- **Reason:** The workflow library is accessed via the rightmost dock icon (Workflow Library), not via a text link in the sidebar. The sidebar contains only widget cards.

### 4. Workflow Schedule Progress — Conditional Visibility
- **Decision:** Connect to workflowStore.queue; only show when workflows are actively running/scheduled
- **Hidden:** On app startup, during chat-only sessions, when no workflows are queued
- **Visible:** When user has started workflows or has scheduled workflows in queue
- **The entire widget card disappears when not applicable**

### 5. Chat Input Positioning — Centered Welcome, Bottom Active
- **Decision:** Two-state layout for the chat area:
  - **Empty state (welcome):** Greeting text + chat input are vertically AND horizontally centered in the canvas as a single "welcome unit"
  - **Active chat state:** After first message sent, input drops to bottom of canvas (standard chat layout)
- **Current bug:** Input is pinned to bottom even in empty state. Must be centered.
- **The chat input card in the Figma is positioned roughly in the center of the chat canvas.**

### 6. Sidebar Widget Concept
- **Philosophy:** Widgets, not menus. Like iOS/Android home screen widgets.
- **Widget cards in sidebar:**
  1. "Record a new Workflow" — with Start Recording button + orange indicator
  2. "Starred Workflows" — pinned/favorite workflows
  3. "Recents" — recent workflow conversations
  4. "Workflow Schedule Progress" — conditional, only when workflows running
- **No text-based navigation links, no expandable tree menus**

## Resolved Questions

- **Q: Use exact Figma SVG code for icons?** A: Yes — exact code provided from Figma AI export
- **Q: Chat input position in empty state?** A: Centered together with greeting, drops to bottom on first message
- **Q: Progress bar visibility?** A: Connected to workflow queue store, hidden by default
- **Q: "All Workflows" text?** A: Remove it entirely, workflow library accessed via dock icon

## Specific Code Changes Required

### File: `ChatView.tsx` + `ChatView.module.css`
- **Current:** Input is always pinned to bottom via separate `.inputArea` div below `.messagesArea`
- **Change:** In empty state, move `<ChatInput />` inside the `.emptyState` container so it's centered vertically with the greeting. In active chat state, keep input at bottom.

### File: `WorkflowProgress.tsx` + `Sidebar.tsx`
- **Current:** `<WorkflowProgress />` renders unconditionally with hardcoded 77% mock data
- **Change:** Import `useWorkflowStore`, check `queue.length > 0`, only render the entire widget div when workflows are queued. Remove the wrapping `<div>` entirely when hidden.

### File: `SidebarWorkflows.tsx`
- **Current:** Contains both "Starred Workflows" card AND "All Workflows" expandable tree with department toggles
- **Change:** Delete the entire expandable section (the `<div>` with `toggle`, department buttons, tree expansion). Keep only the "Starred Workflows" widget card.

### File: `SidebarProfile.module.css`
- **Current:** `.info` flex container has no explicit gap; name (line-height: 1.1) and role (line-height: 1.2) are too close
- **Change:** Add `gap: 6px` to `.info` class to match Figma's generous vertical spacing

### Files: All icon components (`CalendarIcon.tsx`, `LogbookIcon.tsx`, `EmailIcon.tsx`, `WorkflowLibraryIcon.tsx`)
- **Current:** Approximate recreations of the Figma icons
- **Change:** Replace with exact SVG paths from Figma export (`svg-qg7iprjsto.ts`). Convert Tailwind absolute positioning to React component format. Use provided path data verbatim.

## Implementation Notes

- SVG paths for icons provided in `svg-qg7iprjsto.ts` format — need to convert from Tailwind absolute positioning to React component format
- Profile spacing: increase gap between name and role, match Figma's generous vertical spacing
- Font rendering: use `font-weight: 300` (light) more aggressively throughout sidebar widgets
- Icon sizing: Keep 65px containers but ensure internal SVG elements are proportionally correct to Figma (not stretched to fill)
