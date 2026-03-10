---
title: "fix: Testing Session 1 Issues — Log Persistence, Permissions, Speed KPI"
type: fix
status: active
date: 2026-03-10
origin: docs/brainstorms/2026-03-10-user-testing-session-1-issues.md
---

# fix: Testing Session 1 Issues

## Overview

Four issues discovered during the first user testing session. The agent correctly classified intent, showed a preview card, executed actions in Outlook (opened app, created email, typed recipient) -- but the execution log erased itself on completion, macOS permission prompts interrupted mid-execution, and no speed metrics exist. Fixes are ordered by priority: P0 log persistence first (blocks all debugging), P1 permissions next (blocks testers), P2 speed KPI last (optimization).

(see brainstorm: `docs/brainstorms/2026-03-10-user-testing-session-1-issues.md`)

## Acceptance Criteria

### P0 -- AgentActivityLog Persistence
- [ ] When agent execution completes (success, max_iterations, or error), the activity log is saved as a permanent message in the conversation history
- [ ] The saved log is visible as a collapsible card in the chat, below the last agent message
- [ ] The log card shows: header with step count, expandable/collapsible body with all entries (timestamp, phase, message, detail)
- [ ] The card defaults to collapsed state after completion
- [ ] The live `AgentActivityLog` component still shows during execution (real-time)
- [ ] Clearing the transient `agentLog` array on completion no longer destroys data
- [ ] The log card persists even if the user switches conversations and comes back
- [ ] `resetTypingState()` (reconnect handler) also snapshots the log before clearing, so WS drops don't destroy mid-execution evidence
- [ ] Collapse toggle is a clickable header row (entire header toggles expand/collapse)

### P1 -- macOS Permission Pre-flight Check
- [ ] Before the agent starts executing commands, verify Accessibility and Screen Recording permissions
- [ ] If permissions are missing, send a clear error message to the dashboard instead of letting macOS interrupt mid-execution
- [ ] Document Automation (Apple Events) permissions in the tester setup guide since they cannot be pre-checked programmatically
- [ ] The permission check runs on every agent execution start, not just first launch

### P2 -- Execution Speed KPI
- [ ] The activity log card (from P0 fix) shows total execution duration in the header
- [ ] Each log entry shows time elapsed since execution start (e.g. "+2.3s" instead of absolute "12:26:25")
- [ ] A summary line at the bottom shows: total time, iteration count, avg time per iteration

---

## Phase 1: AgentActivityLog Persistence (P0)

### Problem

`chatStore.receiveMessage()` sets `agentLog: []` when ANY message arrives, including the final completion summary. `ChatView.tsx` only renders `<AgentActivityLog />` when `isAgentTyping === true`. Double wipe: data erased + component hidden.

### Approach: Snapshot into Conversation Messages

When the agent loop ends, convert the accumulated `agentLog` entries into a new `ChatMessage` of type `activity-log` and append it to the conversation BEFORE clearing the transient array.

### Changes

#### 1.1 Add `activity-log` message type

**File: `dashboard/src/stores/chatStore.ts`**

Extend `MessageType` to include `'activity-log'`:

```typescript
type MessageType = 'text' | 'progress-card' | 'data-card' | 'error' | 'action-preview' | 'activity-log';
```

Add an optional `logEntries` field to `ChatMessage`:

```typescript
export interface ChatMessage {
  id: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  suggestion?: string;
  previewId?: string;
  logEntries?: AgentLogEntry[];  // NEW: persisted activity log
  timestamp: Date;
}
```

#### 1.2 Snapshot log before clearing in `receiveMessage()`

**File: `dashboard/src/stores/chatStore.ts`**

In `receiveMessage()`, before setting `agentLog: []`, snapshot the current log into a new message if there are entries:

```typescript
receiveMessage: (conversationId, message) =>
  set((state) => {
    // Snapshot the activity log into a persistent message before clearing
    const logSnapshot: ChatMessage[] = state.agentLog.length > 0
      ? [{
          id: `activity-log-${Date.now()}`,
          role: 'system' as MessageRole,
          type: 'activity-log' as MessageType,
          content: `Agent executed ${state.agentLog[state.agentLog.length - 1]?.step || 0} steps`,
          logEntries: [...state.agentLog],
          timestamp: new Date(),
        }]
      : [];

    return {
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, ...logSnapshot, message] }
          : c
      ),
      isAgentTyping: false,
      agentProgress: null,
      agentLog: [],
    };
  }),
```

#### 1.3 Render `activity-log` messages in ChatMessage component

**File: `dashboard/src/components/Chat/ChatMessage.tsx`**

Add a new rendering branch for `type === 'activity-log'`. Show a collapsible card that reuses the existing `AgentActivityLog` visual pattern but with static data from `logEntries`:

- Header: "Agent activity -- X steps" + collapse toggle
- Body (collapsed by default): timestamp, phase label, message, detail for each entry
- Style: reuse existing `AgentActivityLog.module.css` patterns (border-left accent, muted background)

**File: `dashboard/src/components/Chat/ChatMessage.module.css`**

Add styles for the activity-log card: `.activityLogCard`, `.activityLogHeader`, `.activityLogToggle`, `.activityLogBody`, `.activityLogEntry`, etc. Match the existing `AgentActivityLog.module.css` visual style.

#### 1.4 Snapshot log in `resetTypingState()` before clearing

**File: `dashboard/src/stores/chatStore.ts`**

`resetTypingState()` (called on WebSocket reconnect) currently clears `agentLog: []` without saving. If the WS drops mid-execution, this destroys all evidence. Fix: snapshot the log into the active conversation before clearing, using the same pattern as `receiveMessage()`:

```typescript
resetTypingState: () =>
  set((state) => {
    // Snapshot any in-progress log before clearing
    if (state.agentLog.length === 0) {
      return { isAgentTyping: false, agentProgress: null, agentLog: [] };
    }
    const activeConvId = state.conversations.find((c) =>
      c.messages.some((m) => m.type === 'action-preview')
    )?.id ?? state.conversations[0]?.id;
    const logMessage: ChatMessage = {
      id: `activity-log-${Date.now()}`,
      role: 'system' as MessageRole,
      type: 'activity-log' as MessageType,
      content: `Agent interrupted (reconnect) after ${state.agentLog[state.agentLog.length - 1]?.step || 0} steps`,
      logEntries: [...state.agentLog],
      timestamp: new Date(),
    };
    return {
      conversations: state.conversations.map((c) =>
        c.id === activeConvId
          ? { ...c, messages: [...c.messages, logMessage] }
          : c
      ),
      isAgentTyping: false,
      agentProgress: null,
      agentLog: [],
    };
  }),
```

#### 1.5 Keep live AgentActivityLog during execution (no change needed)

`ChatView.tsx` line 52 (`{isAgentTyping && hasAgentLog && <AgentActivityLog />}`) continues to work for live display. The snapshot happens in `receiveMessage()` when execution ends, so the transition is: live component disappears -> persistent card message appears in its place.

**Note on error handling:** All terminal events (success, max_iterations, error) flow through `receiveMessage()` via the `server_chat_response` handler in `message-router.ts`. This means the snapshot in step 1.2 covers ALL completion paths — no additional error-specific handling is needed.

---

## Phase 2: macOS Permission Pre-flight Check (P1)

> **Also resolves Issue 3** (agent stops after mid-execution permission grant). Issue 3 is a direct consequence of missing pre-flight checks — the permission prompt causes the command to timeout (60s), and the agent loop treats the timeout as an error. Fixing Issue 2 prevents the interruption entirely, making Issue 3 impossible.

### Problem

Permissions are only checked in `setup-window.ts` on first launch. If the room ID is already saved, the setup window never shows, and permissions are never rechecked. macOS Automation (Apple Events) permissions are per-target-app and not checked at all -- macOS prompts on first use of each target app.

### Approach

Add a permission check to the local agent's command handler BEFORE executing any command. If permissions are missing, return an error result instead of attempting the action.

### Changes

#### 2.1 Extract permission check into reusable module

**File: `local-agent/src/platform/permissions.ts`** (NEW)

Extract the permission check logic from `setup-window.ts` into a standalone module that can be called from the executor:

```typescript
export interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
}

export function checkRequiredPermissions(): PermissionStatus {
  if (process.platform !== 'darwin') {
    return { accessibility: true, screenRecording: true };
  }
  const { systemPreferences } = require('electron');
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
  };
}

export function getMissingPermissions(): string[] {
  const status = checkRequiredPermissions();
  const missing: string[] = [];
  if (!status.accessibility) missing.push('Accessibility');
  if (!status.screenRecording) missing.push('Screen Recording');
  return missing;
}
```

#### 2.2 Add pre-flight check before command execution

**File: `local-agent/src/connection/command-handler.ts`**

Before executing any command from the bridge, check permissions:

```typescript
const missing = getMissingPermissions();
if (missing.length > 0) {
  return {
    type: 'result',
    id: command.id,
    status: 'error',
    data: { error: `Missing macOS permissions: ${missing.join(', ')}. Open System Settings > Privacy & Security to grant access.` },
  };
}
```

#### 2.3 Update tester setup guide

**File: `docs/distribution/guides/tester-setup.md`** (or create if missing)

Add a section documenting:
- Required permissions: Accessibility, Screen Recording
- Per-app Automation permissions: the first time the agent controls a new app (Outlook, Safari, etc.), macOS will prompt. Grant access when prompted.
- How to re-grant permissions if they were revoked (System Settings > Privacy & Security > Automation)

#### 2.4 Refactor setup-window.ts to use shared module

**File: `local-agent/src/ui/setup-window.ts`**

Replace the inline `checkPermissions()` function with a call to the shared `permissions.ts` module. Add microphone check back as a setup-only concern (not needed for command execution).

---

## Phase 3: Execution Speed KPI (P2)

### Problem

The agent was "very slow" but no metrics exist to quantify or track improvements. Timestamps already exist in `ServerAgentProgress` messages.

### Approach

Calculate durations from existing timestamp data in the dashboard UI. No server changes needed.

### Changes

#### 3.1 Add duration calculation to activity-log card

**File: `dashboard/src/components/Chat/ChatMessage.tsx`** (in the activity-log renderer from Phase 1)

When rendering the activity-log card:
- Calculate total duration: `lastEntry.timestamp - firstEntry.timestamp`
- Calculate per-entry elapsed time: `entry.timestamp - firstEntry.timestamp`
- Display elapsed as "+Xs" prefix instead of absolute time (e.g. "+2.3s" instead of "12:26:25")
- Add a summary footer: "Total: Xs | Y iterations | Z s/iteration avg"

#### 3.2 Add duration to activity-log card header

Show total execution time in the collapsed header:

```
Agent activity -- 8 steps in 34.2s                    [Expand]
```

This gives immediate speed visibility even when the card is collapsed.

---

## Out of Scope

- Fixing the root cause of WHY the email task hit max iterations (separate investigation)
- Persisting activity logs to server/database (local state only for now)
- Reducing `settleDelayMs` (800ms) -- requires stability testing first
- Automation (Apple Events) pre-flight checks -- macOS does not expose an API for this

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| Adding `logEntries` to ChatMessage increases memory | Low -- max 10 iterations x ~100 bytes each | Already bounded by max_iterations |
| Permission check adds latency to every command | Negligible -- `isTrustedAccessibilityClient(false)` is synchronous and fast | Only runs once per command, not per loop |
| Elapsed time calculation wrong if timestamps cross midnight | Very low -- unlikely for 30-60s executions | Use Date.getTime() delta, not string comparison |
| Activity-log message appears AFTER the completion message in chat | Low -- cosmetic ordering | `receiveMessage()` appends `[...logSnapshot, message]`, so the log card always precedes the agent's final message |
| `resetTypingState()` snapshots log to wrong conversation | Low -- edge case during reconnect | Uses heuristic to find active conversation (one with action-preview messages), falls back to first conversation |

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-03-10-user-testing-session-1-issues.md](../brainstorms/2026-03-10-user-testing-session-1-issues.md) -- key decisions: Approach A for log persistence, pre-flight permission check, calculate durations from existing timestamps
- **Related:** [docs/plans/2026-03-10-feat-debug-panel-and-pipeline-logging-plan.md](2026-03-10-feat-debug-panel-and-pipeline-logging-plan.md) -- debug panel shipped in same session
- **Existing todo:** [docs/agent/executor/todos/007-pending-p2-platform-guard-for-macos-permissions.md](../agent/executor/todos/007-pending-p2-platform-guard-for-macos-permissions.md) -- platform guard for permissions (different scope but related)
- **Files to modify:** `chatStore.ts:183-193`, `ChatMessage.tsx`, `ChatMessage.module.css`, `local-agent/src/connection/command-handler.ts`
