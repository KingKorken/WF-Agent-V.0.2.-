---
title: Debug Panel, Pipeline Logging, and Stuck Typing State Fix
date: 2026-03-10
status: solved
component: Dashboard + Bridge Server (connection layer)
problem_type:
  - integration-issues
  - ui-bugs
symptoms:
  - Action prompts hang forever with loading dots in dashboard
  - No preview card appears when agent is processing action intent
  - Agent WebSocket disconnects mid-wait
  - isAgentTyping stays true forever after WebSocket drop
  - UI permanently frozen on loading dots after reconnect
  - Failure point in pipeline cannot be diagnosed
root_cause: |
  Two separate issues:
  1. No visibility into pipeline stages (WS delivery -> classification -> preview -> confirm -> agent loop). Server-side failures were invisible to the dashboard.
  2. WebSocket reconnection did not reset isAgentTyping. Pending responses for the original conversationId never arrive after reconnect, leaving the UI permanently stuck.
severity: high
tags:
  - websocket
  - state-management
  - ui-state
  - logging
  - pipeline-visibility
  - agent-execution
  - debug-panel
  - zustand
---

# Debug Panel, Pipeline Logging, and Stuck Typing State Fix

## Problem

Action prompts ("Send an email to Tim via Outlook") hang forever with loading dots in the dashboard. No preview card appears. The agent WebSocket disconnects mid-wait. Conversational chat works fine.

The message pipeline has ~6 stages that can each fail silently:

```
WS connect -> message send -> classification -> preview/response -> confirm -> agent loop
```

Without visibility into ALL of them, diagnosing failures is impossible. The existing `AgentActivityLog` component only shows agent loop progress -- useless when the loop never starts.

Additionally, when the WebSocket drops mid-operation:
- The bridge loses both the agent and dashboard connections
- The dashboard reconnects and sends a new `dashboard_hello`
- But `isAgentTyping` is still `true` from the original message
- No response ever arrives for that conversationId
- The UI is permanently stuck on loading dots

## Root Cause

### 1. No pipeline observability

The bridge server processed messages through `handleChatMessage` and `handleActionConfirm` with only minimal `logRoom()` calls. Classification results, errors, and state transitions were not reported back to the dashboard. Client-side WebSocket lifecycle events (connect, disconnect, error, reconnect) were not captured anywhere.

### 2. Stuck typing state on reconnect

When the dashboard calls `sendMessage()`, it sets `isAgentTyping: true`. This flag is only cleared when `receiveMessage()` is called with a response. If the WebSocket drops between sending and receiving, the response never arrives, but `isAgentTyping` is never reset. The reconnect handler in `message-router.ts` sent a new `dashboard_hello` and reset recording state, but did not reset typing state.

## Solution

Three changes shipped together in commit `1653053` on branch `feat/debug-panel-and-pipeline-logging`.

### 1. Debug Panel UI (dashboard)

**New file: `dashboard/src/stores/debugStore.ts`**

Zustand store holding structured debug entries with a 500-entry FIFO cap:

```typescript
interface DebugEntry {
  id: string;
  source: 'client' | 'server';
  level: 'info' | 'warn' | 'error';
  category: string;      // e.g. "websocket", "classifyMessage", "handleActionConfirm"
  message: string;
  detail?: string;
  timestamp: string;
}
```

The store provides `addEntry()`, `clear()`, and `toggle()` actions. When entries exceed 500, the oldest are dropped (FIFO eviction).

**New file: `dashboard/src/components/Debug/DebugPanel.tsx`**

Collapsible bottom drawer (fixed position, 250px height) with:
- Header bar: "Debug log" label + entry count + Clear/Close buttons
- Scrollable log area with monospace font
- Each entry: `[timestamp] [LEVEL] [source:category] message | detail`
- Auto-scrolls to bottom unless user has scrolled up
- Dark terminal-style UI (intentionally different from app design system)

**Modified: `dashboard/src/components/Chat/ChatView.tsx`**

Added "Debug" text button (fixed bottom-right) that toggles the panel, plus renders `<DebugPanel />`.

### 2. Bridge Server Pipeline Logging

**Modified: `server/src/bridge.ts`**

Added `sendDebugLog()` helper that sends `ServerDebugLog` WebSocket messages to the dashboard AND logs via `logRoom()` for `fly logs`:

```typescript
function sendDebugLog(
  room: Room,
  level: ServerDebugLog['level'],
  source: string,
  message: string,
  detail?: string,
): void {
  const debugLog: ServerDebugLog = {
    type: 'server_debug_log',
    level, source, message, detail,
    timestamp: new Date().toISOString(),
  };
  room.sendToDashboard(debugLog);
  logRoom(room.id, `[debug:${level}] ${source}: ${message}${detail ? ` | ${detail}` : ''}`);
}
```

Instrumented at these points:

**`handleChatMessage()`:**

| Location | Level | Message |
|----------|-------|---------|
| Entry (after rate limit) | info | `Received: "content..."` |
| Before classification | info | `Classifying intent...` |
| After classification | info | `Result: intent=X, confidence=Y` |
| Classification error | error | `Failed: error` |
| Agent not connected | warn | `Agent not connected, cannot execute action` |
| Agent loop active | warn | `Agent loop already active` |
| Preview card sent | info | `Preview card sent: previewId` |
| Conversation response | info | `Conversation response sent` |
| Chat error | error | `Chat error: error` |

**`handleActionConfirm()`:**

| Location | Level | Message |
|----------|-------|---------|
| Entry | info | `Confirmed: previewId` |
| Invalid/expired preview | warn | `Preview expired or invalid` |
| Agent disconnected | warn | `Agent disconnected before execution` |
| Agent loop start | info | `Starting agent loop` |
| Agent loop complete | info | `Agent loop complete: outcome` |
| Agent loop error | error | `Agent loop failed: error` |

### 3. Client-Side WebSocket Event Logging

**Modified: `dashboard/src/services/websocket.ts`**

Added a lazy `debugLog()` helper (uses `require()` to avoid circular dependency with stores) that logs:
- `onopen`: Connected (with URL)
- `onclose`: Disconnected (with close code and reason)
- `onerror`: WebSocket error
- `scheduleReconnect`: Reconnecting (with delay and attempt count)
- `send()`: Every message sent (with type and conversationId)
- `onmessage`: Every message received (with type)

### 4. isAgentTyping Reset on Reconnect

**Modified: `dashboard/src/stores/chatStore.ts`**

Added `resetTypingState()` action:

```typescript
resetTypingState: () =>
  set({ isAgentTyping: false, agentProgress: null, agentLog: [] }),
```

**Modified: `dashboard/src/services/message-router.ts`**

In the connection state subscriber (after sending `dashboard_hello` on reconnect):

```typescript
useChatStore.getState().resetTypingState();
useDebugStore.getState().addEntry({
  source: 'client', level: 'info', category: 'reconnect',
  message: 'Reset typing state after reconnect',
  timestamp: new Date().toISOString(),
});
```

### Shared Types

**Modified: `shared/types.ts`**

Added `ServerDebugLog` interface and added to `WebSocketMessage` union type. Also added `'server_debug_log'` to `KNOWN_MESSAGE_TYPES` validation set in bridge.

## Key Architectural Decisions

1. **Lazy import in websocket.ts** -- `debugStore` is imported via `require()` at call site (not top-level `import`) to avoid circular dependency, since stores import from `websocket.ts`.

2. **Dark terminal-style UI** -- The debug panel intentionally uses a dark background with monospace font, diverging from the app's design system. This is a developer tool where readability matters more than brand consistency.

3. **Dual logging** -- `sendDebugLog()` writes to both the dashboard (via WebSocket) AND `logRoom()` (for `fly logs`). This ensures visibility regardless of whether the dashboard is connected.

4. **FIFO eviction at 500 entries** -- Prevents memory growth during long sessions. Recent entries (most useful for debugging) are always available.

## Files Changed

| File | Action | What |
|------|--------|------|
| `shared/types.ts` | Modified | Added `ServerDebugLog` interface, added to `WebSocketMessage` union |
| `dashboard/src/stores/debugStore.ts` | Created | Zustand store (500 max, toggle, FIFO) |
| `dashboard/src/stores/chatStore.ts` | Modified | Added `resetTypingState` action |
| `dashboard/src/services/message-router.ts` | Modified | Handle `server_debug_log`, reset typing on reconnect |
| `dashboard/src/services/websocket.ts` | Modified | Client-side debug logging at WS lifecycle events |
| `server/src/bridge.ts` | Modified | `sendDebugLog` helper, instrumented pipeline |
| `dashboard/src/components/Debug/DebugPanel.tsx` | Created | Debug panel component |
| `dashboard/src/components/Debug/DebugPanel.module.css` | Created | Dark terminal-style styles |
| `dashboard/src/components/Chat/ChatView.tsx` | Modified | Debug toggle button + render panel |
| `dashboard/src/components/Chat/ChatView.module.css` | Modified | Toggle button styles |

## Prevention

### 1. State Cleanup on Reconnect

Any boolean state set by outgoing messages (e.g. `isAgentTyping`) must be reset when the connection that would deliver the response is lost. Subscribe to connection state changes and reset any "waiting for response" flags.

**Audit checklist:** For every `setState(true)` that depends on a response arriving, verify there is a corresponding reset on disconnect/reconnect.

### 2. Pipeline Observability

Every stage of a multi-stage pipeline should emit observable events. If any stage can fail silently, add explicit logging/events so failures are visible. Treat every handoff as a potential failure point with entry/exit/error logging.

### 3. Debug Tooling as Infrastructure

Build debug panels early in alpha/beta. They pay for themselves immediately. The debug panel is a permanent tool, not throwaway code.

### 4. Lazy Imports for Cross-Cutting Concerns

When adding observability to core services that stores depend on, use lazy imports (`require()` at call site) to avoid circular dependencies. Document the reason with a comment.

### 5. FIFO Eviction for In-Memory Stores

Any debug/log store that grows without bound will eventually cause memory issues. Cap entries and use FIFO eviction. Choose capacity based on typical session duration and entry rate.

## Related Documentation

- [Bridge Server WebSocket Production Deployment](../../connection/solutions/bridge-server-websocket-production-deployment.md) -- WebSocket foundation
- [Vercel Dashboard Cloud Preview Connection Failure](../../connection/solutions/vercel-dashboard-cloud-preview-connection-failure.md) -- Prior WS connection issues
- [Smart Chat Routing: Free-Form Task Execution](../../connection/solutions/smart-chat-routing-free-form-task-execution.md) -- Classification + preview pipeline
- [Agent Loop Bridge Execution and Dashboard Logging Brief](../../agent/intelligence-layer/briefs/agent-loop-bridge-execution-and-dashboard-logging.md) -- Identified the logging gaps
- [Debug Panel Brainstorm](../../brainstorms/2026-03-10-debug-panel-and-agent-execution-fix-brainstorm.md) -- Design decisions
- [Debug Panel Plan](../../plans/2026-03-10-feat-debug-panel-and-pipeline-logging-plan.md) -- Implementation plan (completed)
