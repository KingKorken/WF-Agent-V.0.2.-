---
title: "feat: Figma V1 Design Refinements"
type: feat
status: active
date: 2026-03-04
origin: docs/brainstorms/2026-03-04-figma-v1-design-refinements-brainstorm.md
---

# feat: Figma V1 Design Refinements

## Overview

Refine the dashboard UI to achieve pixel-level fidelity with the Figma V1 design. The initial migration captured the overall structure (dark sidebar, white cards, colorful dock icons, pill tabs) but deviated in 6 key areas: chat input positioning, conditional progress visibility, sidebar navigation philosophy, typography spacing, icon accuracy, and dead code. This plan addresses 13 targeted code changes across 10 files, organized into 5 implementation phases. Incorporates findings from technical review (TypeScript, simplicity, and architecture reviewers).

## Problem Statement / Motivation

The design philosophy is **widget-based navigation** (like smartphone/tablet home screens), NOT a standard chat sidebar like Claude/ChatGPT. Every visual deviation undermines this concept. The current implementation has:

- Chat input pinned to bottom even in empty state (should be centered with greeting)
- WorkflowProgress widget renders unconditionally with hardcoded 77% mock data
- "All Workflows" expandable tree menu exists (contradicts widget-only sidebar philosophy)
- Profile name/role text too close together (missing 6px gap)
- Dock icons deviate from Figma SVG paths (approximate recreations instead of exact code)
- Dead state management code for removed features
- Zustand selector anti-pattern in ChatView causing unnecessary re-renders
- Accessibility issues (`<p onClick>` instead of `<button>`)

(see brainstorm: `docs/brainstorms/2026-03-04-figma-v1-design-refinements-brainstorm.md`)

## Proposed Solution

13 targeted code changes across 10 files, organized into 5 implementation phases. No new dependencies, no architectural changes — purely visual/behavioral refinements to existing components.

## Technical Considerations

- **State management:** WorkflowProgress conditional rendering uses existing `useWorkflowStore` — no new store logic needed. WorkflowProgress is the single owner of its visibility decision (returns `null` when queue empty).
- **CSS layout:** Chat input repositioning requires moving `<ChatInput>` into the `.emptyState` container (flexbox centering already in place). `autoFocus` on textarea ensures focus is preserved across the empty→active layout transition.
- **Zustand selector fix:** Replace `getActiveConversation()` call-in-selector anti-pattern with direct `.find()` in selector to prevent re-renders on unrelated store mutations.
- **SVG accuracy:** Exact Figma SVG paths provided in brainstorm — verbatim replacement, no approximation
- **Dead code:** Delete `sidebarStore.ts` entirely — after removing "All Workflows" section, the store has zero consumers. The `expandedSections`/`toggleSection` fields are also unused by any component.
- **Accessibility:** Replace `<p onClick>` with `<button>` in starred workflows for keyboard navigation and screen reader support.
- **No breaking changes:** All changes are visual/behavioral refinements within existing component boundaries.

## System-Wide Impact

- **Interaction graph:** Changes are leaf-level — no callbacks, middleware, or observers affected. WorkflowProgress reads from store reactively (Zustand subscription). ChatInput position change uses conditional rendering with `autoFocus` to maintain UX continuity.
- **Error propagation:** No new error paths introduced. Conditional rendering uses simple `queue.length > 0` guard inside WorkflowProgress only.
- **State lifecycle risks:** None — deleting `sidebarStore.ts` removes a module with zero consumers. Grep confirms `isWorkflowsExpanded`/`toggleWorkflows`/`expandedDepartments`/`toggleDepartment`/`expandedSections`/`toggleSection` are only referenced within `sidebarStore.ts` itself and `SidebarWorkflows.tsx` (which drops the import).
- **API surface parity:** No API changes. All changes are internal to React components.
- **Integration test scenarios:** Chat empty→active transition on first message send (verify focus preserved); WorkflowProgress appearing/disappearing when queue changes; sidebar rendering without "All Workflows" section.

## Acceptance Criteria

### Phase 1: Chat Input Positioning
- [ ] **ChatView.tsx** — Fix Zustand selector: replace `s.getActiveConversation()` with `s.conversations.find(c => c.id === s.activeConversationId)`
- [ ] **ChatView.tsx** — In empty state, `<ChatInput>` renders inside `.emptyState` container (centered with greeting)
- [ ] **ChatView.tsx** — In active chat state (messages exist), `<ChatInput>` renders in `.inputArea` at bottom
- [ ] **ChatInput.tsx** — Add `autoFocus` to `<textarea>` to preserve focus after empty→active transition
- [ ] **ChatView.module.css** — `.emptyState` has `max-width: 720px; width: 100%;` for proper centering
- [ ] Transition: first message sent → input drops to bottom seamlessly with focus preserved
- [ ] Conversation switching: returning to empty conversation shows centered input

### Phase 2: WorkflowProgress Conditional Visibility
- [ ] **WorkflowProgress.tsx** — Import `useWorkflowStore`, read `queue`, return `null` when `queue.length === 0` (single owner of visibility decision)
- [ ] **WorkflowProgress.tsx** — Read `executingWorkflow` directly from store (not re-derived with `.find()`)
- [ ] **WorkflowProgress.tsx** — Keep hardcoded progress mock for now (no real data flows yet); defer string parsing until backend integration
- [ ] **Sidebar.tsx** — No changes needed; WorkflowProgress handles its own visibility. Keep rendering `<WorkflowProgress />` unconditionally — it returns `null` when appropriate.
- [ ] On app startup: no progress card visible
- [ ] When workflow queued: progress card appears
- [ ] When queue empties: progress card disappears completely

### Phase 3: Remove "All Workflows" Section + Delete sidebarStore
- [ ] **SidebarWorkflows.tsx** — Delete entire expandable section (toggle button, department buttons, tree expansion). Keep only "Starred Workflows" card. Use `<button>` instead of `<p>` for starred items (accessibility). Drive highlight from `expandedWorkflowId` state instead of magic index `i === 1`.
- [ ] **SidebarWorkflows.module.css** — Delete all CSS for expandable section (`.toggle`, `.arrow`, `.content`, `.department`, `.departmentToggle`, `.cards`, `.workflowCard`, `.workflowCardHeader`, `.statusDot`, `.workflowName`, `.cardDetail`, `.description`, `.lastRun`, `.runAction`, `.empty`). Add `.starredItem` button reset styles.
- [ ] **sidebarStore.ts** — DELETE THE ENTIRE FILE. After removing the `SidebarWorkflows.tsx` import, the store has zero consumers. `expandedSections`/`toggleSection` are also dead code with no consumers anywhere.
- [ ] No console errors or TypeScript errors after removal

### Phase 4: Typography & Spacing
- [ ] **SidebarProfile.module.css** — `.info` class has `gap: 6px`
- [ ] Visible spacing between "User Name" and "Role Information" matches Figma

### Phase 5: Dock Icons — Exact Figma SVGs
- [ ] **CalendarIcon.tsx** — Day number fontSize changed from 32 to 40
- [ ] **LogbookIcon.tsx** — Page elements use exact Figma SVG paths (`p1168af00`, `p31ab3b00`)
- [ ] **EmailIcon.tsx** — All path `d` attributes use exact Figma SVG paths (`p13f25e00`, `p1c259680`, `p39465e80`, `p821de00`)
- [ ] **WorkflowLibraryIcon.tsx** — Grid squares use `radial-gradient` instead of `linear-gradient`
- [ ] **DockIcon.module.css** — `.icon svg` no longer has `width: 100%; height: 100%` (prevents stretching). Verify each icon component's `<svg>` has explicit `width`/`height` or properly constrained `viewBox` before removing.
- [ ] Hover effects (scale, glow) still work after icon replacement

## Success Metrics

- Visual diff between deployed app and Figma V1 design shows < 5% deviation
- Zero TypeScript or build errors
- All existing functionality preserved (chat, sidebar, dock, profile, settings)
- Chat input properly centered in welcome state on first load
- Focus preserved in textarea after first message send (no re-click required)

## Dependencies & Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| ChatInput focus loss on empty→active transition | High | Add `autoFocus` to textarea in ChatInput; React will focus the new instance on mount |
| Chat input centering CSS not applied correctly | High | `.emptyState` already has `justify-content: center` — just need to move `<ChatInput>` inside it |
| Icon SVGs render at wrong size after removing CSS sizing | Medium | Audit each icon's `<svg>` element for explicit `width`/`height` before removing `.icon svg { width: 100%; height: 100% }` |
| Removing store state breaks other components | Low | Grep confirms `sidebarStore` has zero consumers after `SidebarWorkflows.tsx` drops its import |
| Icon SVG paths break hover animations | Low | Hover effects are on `.icon` container in CSS, not on SVG elements directly |
| WorkflowProgress flicker on rapid queue changes | Low | Zustand subscription is synchronous — no intermediate renders |

## MVP Implementation

### Phase 1: Chat Input Positioning

#### ChatView.tsx

**Key changes from current:**
1. Fix Zustand selector anti-pattern (line 116 → direct `.find()` instead of `getActiveConversation()`)
2. Move `<ChatInput>` inside `.emptyState` when empty
3. Only render `.inputArea` when not empty

```tsx
import { useRef, useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { ProgressCard } from './ProgressCard';
import { ChatGreeting } from './ChatGreeting';
import { ChatSuggestions } from './ChatSuggestions';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { LoadingDots } from '../shared/LoadingDots';
import styles from './ChatView.module.css';

export function ChatView() {
  // Fix: derive conversation directly in selector instead of calling getActiveConversation()
  // which creates a new object reference on every store update, defeating Zustand memoization
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  );
  const isAgentTyping = useChatStore((s) => s.isAgentTyping);
  const suggestionsVisible = useChatStore((s) => s.suggestionsVisible);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = conversation?.messages ?? [];
  const isEmpty = messages.length === 0;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isAgentTyping]);

  return (
    <div className={styles.root}>
      <div className={styles.messagesArea}>
        <ProgressCard />
        {isEmpty && (
          <div className={styles.emptyState}>
            <ChatGreeting />
            {suggestionsVisible && <ChatSuggestions onSelect={sendMessage} />}
            <ChatInput onSend={sendMessage} disabled={isAgentTyping} />
          </div>
        )}
        {!isEmpty && (
          <div className={styles.messages}>
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            {isAgentTyping && (
              <div className={styles.typingIndicator}>
                <LoadingDots />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      {!isEmpty && (
        <div className={styles.inputArea}>
          <ChatInput onSend={sendMessage} disabled={isAgentTyping} />
        </div>
      )}
    </div>
  );
}
```

#### ChatInput.tsx — add `autoFocus`

Add `autoFocus` to the `<textarea>` element to preserve focus when ChatInput remounts during the empty→active layout transition:

```tsx
<textarea
  className={styles.input}
  value={inputValue}
  onChange={handleChange}
  onKeyDown={handleKeyDown}
  placeholder="How can I help you today?"
  rows={1}
  disabled={disabled}
  autoFocus
  aria-label="Message input"
/>
```

#### ChatView.module.css — add to `.emptyState`

```css
.emptyState {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: var(--space-xl);
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
}
```

### Phase 2: WorkflowProgress Conditional Visibility

#### WorkflowProgress.tsx

**Key changes from current:**
1. Add store subscription with `queue.length` guard (single owner of visibility)
2. Read `executingWorkflow` directly from store (not re-derived)
3. Keep hardcoded progress value — no string parsing until real data flows

```tsx
import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './WorkflowProgress.module.css';

export function WorkflowProgress() {
  const queue = useWorkflowStore((s) => s.queue);
  const executingWorkflow = useWorkflowStore((s) => s.executingWorkflow);

  if (queue.length === 0) return null;

  // TODO: derive from executingWorkflow.progress when backend integration lands
  const progress = executingWorkflow ? 77 : 0;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Workflow Schedule Progress</span>
        <span className={styles.percentage}>{progress}%</span>
      </div>
      <div className={styles.trackOuter}>
        <div className={styles.trackFill} style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
```

#### Sidebar.tsx — NO CHANGES NEEDED

WorkflowProgress is the single owner of its visibility. It returns `null` when the queue is empty. No conditional wrapper needed in Sidebar.tsx — the existing unconditional `<WorkflowProgress />` render is correct. This eliminates a redundant store subscription and keeps component responsibilities clear.

The current Sidebar.tsx stays as-is except removing the `<div className={styles.top}>` wrapper around `<WorkflowProgress />` so no empty div is left when it returns null:

```tsx
import { useResizable } from '../../hooks/useResizable';
import { SidebarNewWorkflow } from './SidebarNewWorkflow';
import { SidebarWorkflows } from './SidebarWorkflows';
import { SidebarConversations } from './SidebarConversations';
import { WorkflowProgress } from './WorkflowProgress';
import { SidebarDock } from './SidebarDock';
import { SidebarProfile } from './SidebarProfile';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const { handleMouseDown } = useResizable(420, 320, 560);

  return (
    <nav className={styles.sidebar} aria-label="Main navigation">
      <div className={styles.top}>
        <SidebarNewWorkflow />
        <SidebarWorkflows />
      </div>
      <div className={styles.conversations}>
        <SidebarConversations />
      </div>
      <div className={styles.spacer} />
      <WorkflowProgress />
      <div className={styles.divider} />
      <SidebarDock />
      <SidebarProfile />
      <div className={styles.resizeHandle} onMouseDown={handleMouseDown} />
    </nav>
  );
}
```

### Phase 3: Remove "All Workflows" Section + Delete sidebarStore

#### SidebarWorkflows.tsx (simplified)

**Key changes from current:**
1. Delete entire expandable "All Workflows" section
2. Remove `useSidebarStore` import (store will be deleted)
3. Replace `<p onClick>` with `<button>` for accessibility (keyboard focusable, screen reader compatible)
4. Replace magic `i === 1` highlight with state-driven `expandedWorkflowId === w.id`

```tsx
import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './SidebarWorkflows.module.css';

export function SidebarWorkflows() {
  const { workflows, expandedWorkflowId, setExpandedWorkflow } = useWorkflowStore();

  // Get starred workflows (active ones)
  const starredWorkflows = workflows.filter((w) => w.status === 'active').slice(0, 3);

  return (
    <div className={styles.starredCard}>
      <p className={styles.starredTitle}>Starred Workflows</p>
      {starredWorkflows.map((w) => (
        <button
          key={w.id}
          type="button"
          className={`${styles.starredItem} ${expandedWorkflowId === w.id ? styles.starredItemHighlight : ''}`}
          onClick={() => setExpandedWorkflow(expandedWorkflowId === w.id ? null : w.id)}
        >
          {w.department} - {w.name}
        </button>
      ))}
    </div>
  );
}
```

#### sidebarStore.ts — DELETE ENTIRE FILE

After removing the `SidebarWorkflows.tsx` import, the store has **zero consumers** anywhere in the codebase. The `expandedSections`/`toggleSection` fields were also dead code with no consumers. Delete the entire file rather than "cleaning it up."

#### SidebarWorkflows.module.css (cleaned up — keep only starred card styles)

Note: `.starredItem` updated with button reset styles (no background, no border) for the `<p>` → `<button>` change.

```css
/* Starred Workflows widget card */
.starredCard {
  background: var(--color-card-bg);
  border-radius: var(--radius-card);
  padding: 16px 20px;
}

.starredTitle {
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-light);
  color: var(--color-text);
  letter-spacing: -0.3px;
  margin-bottom: 12px;
}

.starredItem {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  font-family: var(--font-family);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-light);
  color: var(--color-text);
  letter-spacing: -0.3px;
  padding: 6px 0;
  cursor: pointer;
  transition: opacity var(--duration-instant) var(--ease-out-quad);
}

.starredItem:hover {
  opacity: 0.7;
}

.starredItemHighlight {
  background: rgba(240, 237, 237, 0.7);
  border-radius: var(--radius-button);
  padding: 6px 8px;
  margin: 0 -8px;
}
```

### Phase 4: Typography & Spacing

#### SidebarProfile.module.css — add gap to `.info`

```css
.info {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
```

### Phase 5: Dock Icons — Exact Figma SVGs

#### CalendarIcon.tsx — change fontSize 32 → 40

Change the day number `<span>` fontSize from `32` to `40`.

#### LogbookIcon.tsx — replace page elements with exact Figma paths

Replace the two `<rect>` page elements with `<path>` elements using exact Figma SVG paths:
- Front page: `d="M32.7373 0.955525C35.2746..."` (path `p1168af00`)
- Back page: `d="M12.2627 0.925781C9.72543..."` (path `p31ab3b00`)

Both paths use `fill="url(#lbPage1)"` and `fill="url(#lbPage2)"` respectively, with appropriate stroke gradients. Verify `viewBox` accommodates the new path coordinates.

#### EmailIcon.tsx — replace all path d attributes with exact Figma paths

Replace the 4 path `d` attributes:
- Top flap: `p13f25e00` — `"M27.9311 21.2629..."`
- Left side: `p1c259680` — `"M20.9971 16.4404..."`
- Bottom body: `p39465e80` — `"M26.4512 8.95605..."`
- Right side: `p821de00` — `"M33.0029 17.5596..."`

Update viewBox to `"0 0 54 34"` to match Figma geometry.

#### WorkflowLibraryIcon.tsx — change gradient type

Change all 6 grid square backgrounds from `linear-gradient(to bottom, ...)` to `radial-gradient(circle, ...)`.

#### DockIcon.module.css — fix SVG sizing

Remove `width: 100%; height: 100%` from `.icon svg` to prevent stretching.

**Pre-requisite check:** Before removing, verify each icon component has explicit dimensions:
- `CalendarIcon.tsx` — uses `div` with `width: '100%', height: '100%'` → needs no change (div fills container)
- `LogbookIcon.tsx` — has `style={{ width: 45, height: 35 }}` on `<svg>` → OK
- `EmailIcon.tsx` — has `style={{ width: 44, height: 32 }}` on `<svg>` → OK
- `WorkflowLibraryIcon.tsx` — uses `div` with `width: '100%', height: '100%'` → needs no change
- `RecordIcon.tsx` — has `viewBox="0 0 24 24"` but no explicit width/height → **add `width={24} height={24}`**

```css
.icon svg {
  /* Removed: width: 100%; height: 100%; — icons define their own dimensions */
}
```

## Review Findings Addressed

Summary of issues identified by technical review and how they are resolved:

| # | Severity | Issue | Resolution |
|---|----------|-------|-----------|
| 1 | CRITICAL | `getActiveConversation()` in Zustand selector defeats memoization | Fixed: use `.find()` directly in selector |
| 2 | HIGH | Unsafe `split('/').map(Number)` on progress string | Fixed: keep hardcoded mock; defer parsing until backend integration |
| 3 | HIGH | Duplicate queue-length guard in Sidebar + WorkflowProgress | Fixed: single owner in WorkflowProgress; Sidebar renders unconditionally |
| 4 | HIGH | ChatInput focus loss on empty→active DOM transition | Fixed: add `autoFocus` to textarea |
| 5 | MEDIUM | "Cleaned up" sidebarStore still has zero consumers | Fixed: delete entire file |
| 6 | MEDIUM | `<p onClick>` accessibility violation | Fixed: use `<button>` with reset styles |
| 7 | MEDIUM | `i === 1` magic index for highlight | Fixed: drive from `expandedWorkflowId === w.id` |
| 8 | LOW | Icon SVGs may render wrong size after CSS removal | Fixed: audit dimensions; add explicit width/height to RecordIcon |

## Edge Cases & Considerations

1. **Chat input focus on transition:** When user sends first message, `isEmpty` flips to `false`. The empty-state `<ChatInput>` unmounts and a new instance mounts in `.inputArea`. The `autoFocus` attribute on `<textarea>` ensures the new instance receives focus automatically, so the user can continue typing without re-clicking. Draft text is preserved via `chatStore.drafts`.

2. **Conversation switching:** When user clicks a conversation with messages, `isEmpty` becomes false → input at bottom. When user starts a new blank conversation, `isEmpty` is true → input centered. No special handling needed — the existing store-driven rendering handles this.

3. **WorkflowProgress with multiple queued workflows:** The component reads `executingWorkflow` directly from the store (which the store keeps in sync with `queue.find(q => q.position === 0)`). When no workflow is at position 0 but queue has items (all pending), it shows 0%.

4. **Starred Workflows empty state:** If no workflows have `status === 'active'`, the card renders with just the "Starred Workflows" title and no items. This is acceptable for v1 — a future enhancement could add an empty state message.

5. **Dock icon hover effects:** The hover CSS (`.icon:hover { transform: scale(...) }`) is on the container element, not on SVG internals. Swapping SVG path data does not affect hover animations.

6. **RecordIcon dimensions:** After removing `.icon svg { width: 100%; height: 100% }`, RecordIcon needs explicit `width={24} height={24}` on its `<svg>` element to render at correct size.

## Sources & References

### Origin
- **Brainstorm document:** [docs/brainstorms/2026-03-04-figma-v1-design-refinements-brainstorm.md](docs/brainstorms/2026-03-04-figma-v1-design-refinements-brainstorm.md) — Key decisions: use exact Figma SVG code for icons, center chat input in welcome state, conditional progress bar visibility, remove "All Workflows" expandable section, widget-based sidebar philosophy.

### Internal References
- `src/components/Chat/ChatView.tsx` — Chat layout, input positioning, Zustand selector fix
- `src/components/Chat/ChatInput.tsx` — Add `autoFocus` for focus preservation
- `src/components/Sidebar/WorkflowProgress.tsx` — Progress widget, conditional visibility
- `src/components/Sidebar/SidebarWorkflows.tsx` — Starred card only, accessibility fix
- `src/stores/sidebarStore.ts` — DELETE (zero consumers)
- `src/stores/workflowStore.ts` — Queue state for conditional progress
- `src/components/Sidebar/SidebarProfile.module.css` — Profile spacing
- `src/components/Sidebar/icons/*` — All 4 dock icon components + RecordIcon dimension fix
- `src/components/Sidebar/DockIcon.module.css` — Icon container sizing

### Technical Review
- TypeScript reviewer: Zustand selector anti-pattern, unsafe string parsing, duplicate guards, dead store state, accessibility violations
- Simplicity reviewer: YAGNI on progress parsing, redundant store subscription, delete vs clean dead file
- Architecture reviewer: Focus loss on ChatInput remount, single responsibility for visibility, icon dimension audit

### Figma Export
- SVG path data from `svg-qg7iprjsto.ts` (provided in brainstorm) — exact paths for Logbook and Email icons
