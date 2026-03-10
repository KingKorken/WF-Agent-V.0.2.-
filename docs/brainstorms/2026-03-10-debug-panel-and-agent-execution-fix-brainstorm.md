# Debug Panel & Agent Execution Fix — Brainstorm

**Date:** 2026-03-10
**Status:** Brainstorm complete
**Related:** `docs/agent/intelligence-layer/briefs/agent-loop-bridge-execution-and-dashboard-logging.md`

---

## What We're Building

A **debug panel** in the dashboard that provides full visibility into every stage of the message pipeline — from WebSocket connection through classification, preview cards, and agent loop execution. This is the missing diagnostic tool that makes it impossible to debug why the agent appears to hang after sending a prompt.

Additionally, improved server-side logging on the Fly.io bridge so `fly logs` shows the same level of detail.

---

## Why This Approach

### The Actual Problem (Revised Understanding)

The brief assumed the problem was in the agent loop execution (Problem 2) and the activity log rendering (Problem 1). Previous work focused on wiring all 8 agent loop callbacks and building an `AgentActivityLog` component.

**But the real failure happens earlier.** The user never sees a preview card — only infinite loading dots. This means:

1. The dashboard sends the message to the bridge (loading dots appear = `isAgentTyping: true` is set)
2. The bridge either:
   - Never receives the message (WebSocket issue)
   - Receives it but classification hangs (API key missing, Claude API timeout)
   - Classification succeeds but the response (preview card or chat reply) never reaches the dashboard
3. Since no `server_chat_response` or `server_action_preview` arrives, `isAgentTyping` stays `true` forever

The existing `AgentActivityLog` only captures agent loop progress — it can't show what's happening before the agent loop even starts.

### Why a Debug Panel

- **The pipeline has ~6 stages** that can each fail silently: WS connect → message send → classification → preview/response → confirm → agent loop. We need visibility into ALL of them.
- **Server-side logs alone aren't enough** — the user doesn't have easy access to `fly logs`, and client-side failures (WS drops, message delivery) don't appear in server logs at all.
- **This is a permanent tool** — not just for this bug. Every future issue will benefit from this visibility.

---

## Key Decisions

### 1. Separate debug panel (collapsible drawer)
- A toggleable panel, not inline in chat
- Keeps the chat view clean for normal usage
- Shows a scrollable log of timestamped events
- Toggle button in the UI (small icon, not prominent)

### 2. Two event sources
- **Client-side events** (captured in the dashboard directly):
  - WebSocket open/close/error/reconnect
  - Messages sent to bridge (with type and conversationId)
  - Messages received from bridge (with type)
  - WebSocket reconnect events (important for diagnosing mid-operation drops)
- **Server-side events** (pushed from bridge via new message type):
  - `server_debug_log` — a new WebSocket message type carrying server-side log entries
  - Classification results (intent, confidence, plan)
  - handleChatMessage entry/exit
  - handleActionConfirm entry/exit
  - Agent loop callbacks (already wired, these are the existing `server_agent_progress` events)
  - Errors at any stage

### 3. Toggle via UI button
- Small icon button (e.g., terminal/bug icon) visible in the dashboard
- Default: hidden. Click to show a collapsible bottom/side drawer.
- During alpha testing, easy for testers to access without URL hacking

### 4. Build debug panel FIRST, then diagnose
- Deploy the debug panel, reproduce the issue, and use it to see exactly where the pipeline fails
- This is more methodical than guessing — and the tool has long-term value

### 5. Enhance bridge server logging
- Every stage of `handleChatMessage` should log to both `logRoom()` (for `fly logs`) AND send a `server_debug_log` to the dashboard
- Particularly: classification attempt, classification result, API errors, preview card sent, conversation response sent

---

## Architecture

```
Dashboard                          Bridge Server (Fly.io)
┌─────────────────┐               ┌─────────────────────┐
│ ChatInput       │──send msg──►  │ handleChatMessage()  │
│                 │               │   ├─ log: received   │──► server_debug_log
│ DebugPanel      │◄──ws msg───  │   ├─ classifyMessage()│──► server_debug_log
│ (toggle)        │               │   │   └─ Claude Haiku│
│   ├─ client log │               │   ├─ log: classified │──► server_debug_log
│   └─ server log │◄──ws msg───  │   ├─ send preview    │──► server_action_preview
│                 │               │   └─ OR send reply   │──► server_chat_response
│ AgentActivity   │◄──ws msg───  │ handleActionConfirm() │──► server_agent_progress
│ Log (existing)  │               │   └─ runAgentLoop()  │
└─────────────────┘               └─────────────────────┘
```

### New shared type

```typescript
interface ServerDebugLog {
  type: 'server_debug_log';
  level: 'info' | 'warn' | 'error';
  source: string;       // e.g. "handleChatMessage", "classifyMessage", "handleActionConfirm"
  message: string;
  detail?: string;
  timestamp: string;
}
```

### Debug store (new Zustand store)

```typescript
interface DebugEntry {
  id: string;
  source: 'client' | 'server';
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  detail?: string;
  timestamp: string;
}
```

---

## Scope Boundaries

### In scope
- Debug panel UI component (collapsible drawer with toggle)
- Debug store to hold log entries
- Client-side event capture (WS events, message send/receive)
- Server-side debug log message type + sending from bridge
- Enhanced logging in `handleChatMessage` and `classifyMessage`
- Message router handling for `server_debug_log`
- **Reset `isAgentTyping` on WebSocket reconnect** — defensive fix so WS drops don't permanently freeze the UI on loading dots

### Out of scope (for now)
- Fixing the root cause of the agent execution/WS disconnect (that comes after we can see what's failing)
- Fancy UI (this is a debugging tool, monospace text is fine)
- Persistence of debug logs (in-memory only, cleared on page reload)
- Filtering/search in the debug panel

---

## Refined Diagnosis (from follow-up questions)

### What works
- Conversational chat works fine (type "Hello" → get a response)
- This proves: API key is set, WebSocket works bidirectionally, message routing works

### What fails
- Action prompts (e.g. "Send an email to Tim via Outlook") show loading dots indefinitely
- No preview card ever appears
- Agent disconnects mid-wait (dashboard shows disconnect, but local agent app stays open)

### Most likely failure sequence
1. User sends action prompt → loading dots appear instantly (client-side `isAgentTyping: true`)
2. Bridge receives message, calls `classifyMessage()` with Claude Haiku
3. Classification likely returns `intent: 'action'`
4. Bridge checks `room.isAgentConnected` — this is where it may fail:
   - If the agent WebSocket has dropped by this point, bridge sends an error message
   - But that error message SHOULD clear `isAgentTyping` via `receiveMessage()`
5. OR: classification takes too long and the WebSocket connection drops during the wait
6. OR: preview card IS sent but the dashboard WS connection has dropped by then

### The WebSocket disconnect is the smoking gun
The agent disconnects mid-wait = WebSocket keepalive/timeout issue on Fly.io. Fly.io's proxy may be closing idle connections. If the WS drops:
- Server-side: the bridge loses the agent connection AND the dashboard connection
- Client-side: the dashboard reconnects, but `isAgentTyping` is still `true` from the original message, and no response ever arrives for that conversationId
- The reconnection sends a new `dashboard_hello` but doesn't replay pending operations
- **This means `isAgentTyping` must be reset on reconnect** — otherwise the UI is permanently stuck

### What the debug panel needs to reveal
1. Whether the WS message from dashboard actually reaches the bridge
2. Whether classification succeeds or fails
3. Whether the bridge attempts to send a preview card
4. Whether the WS connection drops during any of these stages
5. Timestamps for each stage to identify where the delay is

---

## Open Questions

None — all resolved during brainstorm.

---

## Files Likely Involved

| File | Change |
|------|--------|
| `shared/types.ts` | Add `ServerDebugLog` type |
| `server/src/bridge.ts` | Add debug logging to `handleChatMessage`, `classifyMessage`, `handleActionConfirm` |
| `dashboard/src/stores/debugStore.ts` | **NEW** — Zustand store for debug entries |
| `dashboard/src/services/message-router.ts` | Handle `server_debug_log` messages |
| `dashboard/src/services/websocket.ts` | Add hooks for client-side WS event logging |
| `dashboard/src/components/Debug/DebugPanel.tsx` | **NEW** — the debug panel component |
| `dashboard/src/components/Debug/DebugPanel.module.css` | **NEW** — styles |
| `dashboard/src/components/Chat/ChatView.tsx` | Add debug panel toggle + render |
