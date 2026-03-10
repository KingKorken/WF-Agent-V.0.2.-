---
title: "feat: Debug Panel and Pipeline Logging"
type: feat
status: completed
date: 2026-03-10
origin: docs/brainstorms/2026-03-10-debug-panel-and-agent-execution-fix-brainstorm.md
---

# feat: Debug Panel and Pipeline Logging

## Overview

Build a debug panel in the dashboard that shows every stage of the message pipeline in real-time — WebSocket events, classification, preview cards, agent loop progress, errors. Also add server-side debug logging to the bridge so `fly logs` provides the same visibility. Include a defensive fix to reset `isAgentTyping` on WebSocket reconnect so WS drops don't permanently freeze the UI.

This is a debugging tool for alpha testing. It does not need to be polished — it needs to work.

## Problem Statement

Action prompts ("Send an email to Tim via Outlook") hang forever with loading dots. No preview card appears. The agent WebSocket disconnects mid-wait. Conversational chat works fine.

Without visibility into the pipeline stages (WS delivery → classification → preview → confirm → agent loop), we cannot diagnose where the failure occurs. The existing `AgentActivityLog` component only shows agent loop progress — useless when the loop never starts.

(see brainstorm: `docs/brainstorms/2026-03-10-debug-panel-and-agent-execution-fix-brainstorm.md` — "Refined Diagnosis" section)

## Proposed Solution

Three changes shipped together:

1. **Debug panel** — Collapsible drawer in the dashboard with a toggle button. Shows timestamped log entries from two sources: client-side WS events and server-pushed `server_debug_log` messages.

2. **Bridge debug logging** — Add `server_debug_log` messages at every stage of `handleChatMessage`, `classifyMessage`, and `handleActionConfirm`. Also log to `logRoom()` for `fly logs`.

3. **`isAgentTyping` reset on reconnect** — When WS reconnects, clear `isAgentTyping` so the UI isn't permanently stuck on loading dots.

## Acceptance Criteria

- [x] Debug panel toggle button visible in dashboard UI
- [x] Debug panel shows client-side events: WS open, close, error, reconnect, messages sent, messages received (with type)
- [x] Debug panel shows server-side events: classification started/completed/failed, preview card sent, action confirmed, agent loop stages, errors
- [x] Events have timestamps, level (info/warn/error), source label, and message
- [x] `isAgentTyping` resets to `false` on WebSocket reconnect
- [x] Bridge server logs every pipeline stage via `logRoom()` (visible in `fly logs`)
- [x] Debug panel has a "Clear" button to reset the log
- [x] Max 500 entries in debug store (FIFO eviction) to prevent memory growth
- [x] Existing chat, AgentActivityLog, and preview card functionality unchanged

## Technical Approach

### Design Constraints (from `docs/dashboard/ui/design-rules.md`)

- Font: Inter, weights 400/500/700
- Colors: `#EEEEEE` bg, `#0A0A0A` text, `#EC8D00` accent (max ONE orange element per view)
- Spacing: 8px base, multiples of 8
- Border radius: 4px
- No icons in navigation — text labels only
- Only animate `transform` and `opacity`

### Phase 1: Shared Types + Debug Store

**`shared/types.ts`** — Add `ServerDebugLog` type:

```typescript
export interface ServerDebugLog {
  type: 'server_debug_log';
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  detail?: string;
  timestamp: string;
}
```

Add to the `WebSocketMessage` union type.

**`dashboard/src/stores/debugStore.ts`** — NEW file:

```typescript
interface DebugEntry {
  id: string;
  source: 'client' | 'server';
  level: 'info' | 'warn' | 'error';
  category: string;      // e.g. "websocket", "classification", "agent-loop"
  message: string;
  detail?: string;
  timestamp: string;      // ISO string, always from Date.now() on client
}

interface DebugState {
  entries: DebugEntry[];
  isOpen: boolean;
  addEntry: (entry: Omit<DebugEntry, 'id'>) => void;
  clear: () => void;
  toggle: () => void;
}
```

Follow existing store pattern from `connectionStore.ts`. Cap at 500 entries — when adding entry 501, drop the oldest. Use `create` from zustand, no middleware.

### Phase 2: Client-Side Event Capture

**`dashboard/src/services/websocket.ts`** — Add debug hooks:

Hook into WebSocket lifecycle events to log to debugStore. The WebSocket service is a class with `connect()`, `send()`, `onMessage()`. Add logging at:

- `onopen` → `addEntry({ source: 'client', level: 'info', category: 'websocket', message: 'Connected' })`
- `onclose` → `addEntry({ source: 'client', level: 'warn', category: 'websocket', message: 'Disconnected', detail: closeCode + reason })`
- `onerror` → `addEntry({ source: 'client', level: 'error', category: 'websocket', message: 'WebSocket error' })`
- `send()` → `addEntry({ source: 'client', level: 'info', category: 'ws-send', message: message.type, detail: conversationId if present })`
- `onmessage` (in message dispatch) → `addEntry({ source: 'client', level: 'info', category: 'ws-recv', message: parsedMessage.type })`

Import `useDebugStore` lazily to avoid circular deps — import at call site, not top of file.

**`dashboard/src/services/message-router.ts`** — Handle `server_debug_log`:

Add a new case in the `handleMessage` switch:

```typescript
case 'server_debug_log': {
  const msg = message as ServerDebugLog;
  useDebugStore.getState().addEntry({
    source: 'server',
    level: msg.level,
    category: msg.source,
    message: msg.message,
    detail: msg.detail,
    timestamp: msg.timestamp,
  });
  break;
}
```

### Phase 3: `isAgentTyping` Reset on Reconnect

**`dashboard/src/services/message-router.ts`** — In the existing `useConnectionStore.subscribe` block (line 190-204), after sending `dashboard_hello` on reconnect, add:

```typescript
// Reset typing state on reconnect — WS drop may have lost pending responses
useChatStore.getState().receiveMessage('', {
  // Use empty conversationId — receiveMessage sets isAgentTyping: false regardless
  // This is a defensive reset, not a real message
});
```

Wait — `receiveMessage` maps over conversations to add the message, so empty conversationId won't match any conversation. But it WILL set `isAgentTyping: false` and `agentLog: []`. This is the desired behavior.

Actually, better approach: add a dedicated reset action to chatStore:

**`dashboard/src/stores/chatStore.ts`** — Add `resetTypingState`:

```typescript
resetTypingState: () =>
  set({ isAgentTyping: false, agentProgress: null, agentLog: [] }),
```

Then in message-router's reconnect handler:

```typescript
useChatStore.getState().resetTypingState();
```

Log this to debug store:

```typescript
useDebugStore.getState().addEntry({
  source: 'client', level: 'info', category: 'reconnect',
  message: 'Reset typing state after reconnect',
  timestamp: new Date().toISOString(),
});
```

### Phase 4: Bridge Server Debug Logging

**`server/src/bridge.ts`** — Add a `sendDebugLog` helper and use it throughout the pipeline:

```typescript
function sendDebugLog(
  room: Room,
  level: ServerDebugLog['level'],
  source: string,
  message: string,
  detail?: string,
): void {
  const log: ServerDebugLog = {
    type: 'server_debug_log',
    level,
    source,
    message,
    detail,
    timestamp: new Date().toISOString(),
  };
  room.sendToDashboard(log);
  logRoom(room.id, `[debug:${level}] ${source}: ${message}${detail ? ` | ${detail}` : ''}`);
}
```

Add calls at these points in `handleChatMessage()`:

| Location | Level | Source | Message |
|----------|-------|--------|---------|
| Entry (after rate limit check) | info | handleChatMessage | `Received: "${content.substring(0, 60)}"` |
| Before `classifyMessage()` | info | classifyMessage | `Classifying intent...` |
| After classification success | info | classifyMessage | `Result: intent=${intent}, confidence=${confidence}` with plan as detail |
| Classification error catch | error | classifyMessage | `Failed: ${error}` |
| Agent not connected (action path) | warn | handleChatMessage | `Agent not connected, cannot execute action` |
| Agent loop active guard | warn | handleChatMessage | `Agent loop already active` |
| Preview card sent | info | handleChatMessage | `Preview card sent: ${previewId}` with plan as detail |
| Conversation response sent | info | handleChatMessage | `Conversation response sent` |
| Conversation error | error | handleChatMessage | `Chat error: ${error}` |

Add calls at these points in `handleActionConfirm()`:

| Location | Level | Source | Message |
|----------|-------|--------|---------|
| Entry | info | handleActionConfirm | `Confirmed: ${previewId}` |
| Invalid/expired preview | warn | handleActionConfirm | `Preview expired or invalid` |
| Agent not connected | warn | handleActionConfirm | `Agent disconnected before execution` |
| Agent loop start | info | handleActionConfirm | `Starting agent loop` with goal as detail |
| Agent loop complete | info | handleActionConfirm | `Agent loop complete: ${outcome}` with summary as detail |
| Agent loop error | error | handleActionConfirm | `Agent loop failed: ${error}` |

### Phase 5: Debug Panel UI Component

**`dashboard/src/components/Debug/DebugPanel.tsx`** — NEW file:

Collapsible drawer that anchors to the bottom of the viewport. Contains:

1. **Header bar** — "Debug log" label + entry count + "Clear" button
2. **Log area** — Scrollable list of `DebugEntry` items, auto-scroll when user is at bottom
3. Each entry shows: `[timestamp] [LEVEL] [source] message | detail`

Use monospace font for log entries (override Inter for the log content only — `font-family: 'SF Mono', 'Fira Code', monospace`). This is a developer tool, readability matters more than brand consistency.

Entry colors:
- `info` — default text color (`#0A0A0A`)
- `warn` — text with slightly muted style (font-weight 500)
- `error` — text with bold weight (font-weight 700)

No accent color usage in the debug panel (the toggle button in the main UI can be the one orange element).

Auto-scroll behavior: auto-scroll to bottom when new entries arrive, BUT only if user is within 50px of the bottom. If user has scrolled up, show a small "New events" indicator at the bottom.

Panel height: fixed at 250px with resize handle (or just fixed, simpler). Use `position: fixed; bottom: 0; left: 0; right: 0;` to overlay the page.

**`dashboard/src/components/Debug/DebugPanel.module.css`** — NEW file.

### Phase 6: Toggle Button Integration

**`dashboard/src/components/Chat/ChatView.tsx`** — Add toggle button and render DebugPanel:

Add a small "Debug" text button (not icon — design rules say no icons) in a fixed position, bottom-right corner. Clicking toggles `debugStore.toggle()`.

Render `<DebugPanel />` conditionally based on `debugStore.isOpen`.

Alternatively, the toggle could go in the sidebar/nav if there is one. Check `App.tsx` for layout structure and choose the least intrusive spot.

## Files to Create/Modify

| File | Action | What Changes |
|------|--------|-------------|
| `shared/types.ts` | Modify | Add `ServerDebugLog` interface, add to `WebSocketMessage` union |
| `dashboard/src/stores/debugStore.ts` | **Create** | Zustand store for debug entries (500 max, toggle state) |
| `dashboard/src/stores/chatStore.ts` | Modify | Add `resetTypingState` action |
| `dashboard/src/services/websocket.ts` | Modify | Add debug logging at WS lifecycle events and send/receive |
| `dashboard/src/services/message-router.ts` | Modify | Handle `server_debug_log`, reset typing on reconnect |
| `server/src/bridge.ts` | Modify | Add `sendDebugLog` helper, add calls in handleChatMessage + handleActionConfirm |
| `dashboard/src/components/Debug/DebugPanel.tsx` | **Create** | Debug panel component |
| `dashboard/src/components/Debug/DebugPanel.module.css` | **Create** | Debug panel styles |
| `dashboard/src/components/Chat/ChatView.tsx` | Modify | Add debug toggle button + render DebugPanel |

## Out of Scope

- Fixing the root cause of the WS disconnect (diagnose after debug panel is deployed)
- Debug log persistence across page refresh (in-memory only for now)
- Filtering/search in the debug panel
- Sensitive data redaction (alpha tool, not user-facing)
- Multi-tab debug log coordination
- Message sequence numbers or gap detection
- Agent loop timeout/cancel button (separate feature)

## Dependencies & Risks

**No external dependencies** — uses existing Zustand, React, WebSocket infrastructure.

**Risk: Circular import** — `websocket.ts` importing `debugStore` could create a circular dependency since stores import from `websocket.ts`. Mitigation: use lazy import (`const { useDebugStore } = await import(...)`) or inline `require()` at call site, or pass the store reference during initialization.

**Risk: Debug logging adds latency to the bridge** — each `sendDebugLog` call does a `JSON.stringify` + WebSocket send. Mitigation: these are small JSON objects (~200 bytes), and we're only adding ~10 per message flow. Negligible impact.

**Risk: Vercel build cache serves stale code** — (from learnings: `docs/connection/solutions/vercel-dashboard-cloud-preview-connection-failure.md`). Mitigation: deploy with `npx vercel --prod --force` and verify the live bundle contains the debug panel code.

## Implementation Order

1. `shared/types.ts` — Add `ServerDebugLog` type
2. `dashboard/src/stores/debugStore.ts` — Create store
3. `dashboard/src/stores/chatStore.ts` — Add `resetTypingState`
4. `dashboard/src/services/message-router.ts` — Handle new message type + reconnect reset
5. `dashboard/src/services/websocket.ts` — Add client-side debug logging
6. `server/src/bridge.ts` — Add `sendDebugLog` helper + calls throughout pipeline
7. `dashboard/src/components/Debug/DebugPanel.tsx` + CSS — Build the UI
8. `dashboard/src/components/Chat/ChatView.tsx` — Add toggle + render panel
9. Build, deploy, test with "Send an email to Tim via Outlook" prompt

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-10-debug-panel-and-agent-execution-fix-brainstorm.md](docs/brainstorms/2026-03-10-debug-panel-and-agent-execution-fix-brainstorm.md) — Key decisions: separate debug panel (not inline), two event sources, build debug first then diagnose, reset isAgentTyping on reconnect
- **Agent loop brief:** [docs/agent/intelligence-layer/briefs/agent-loop-bridge-execution-and-dashboard-logging.md](docs/agent/intelligence-layer/briefs/agent-loop-bridge-execution-and-dashboard-logging.md) — Documents the three gaps in the progress pipeline
- **WS connection fix learnings:** [docs/connection/solutions/vercel-dashboard-cloud-preview-connection-failure.md](docs/connection/solutions/vercel-dashboard-cloud-preview-connection-failure.md) — Deploy with `--force`, verify live bundle
- **Smart chat routing:** [docs/connection/solutions/smart-chat-routing-free-form-task-execution.md](docs/connection/solutions/smart-chat-routing-free-form-task-execution.md) — Classification → preview → agent loop pipeline
- **Design rules:** [docs/dashboard/ui/design-rules.md](docs/dashboard/ui/design-rules.md) — UI constraints (LOCKED)
- **Existing patterns:** `dashboard/src/stores/connectionStore.ts` (store pattern), `dashboard/src/services/message-router.ts:33-165` (message handling pattern), `server/src/bridge.ts:114-124` (logging pattern)
