---
title: "User Testing Session 1 — Issues Found"
type: brainstorm
status: active
date: 2026-03-10
prompt: "Hello whats up, please write an email form my outlook account. This email should be to Tim.buhrow@gmx.de and I would like to wish him a nice day"
result: partial-success
---

# User Testing Session 1 — Issues Found

## Test Context

- **Prompt:** "Hello whats up, please write an email form my outlook account. This email should be to Tim.buhrow@gmx.de and I would like to wish him a nice day"
- **What worked:** Classification correctly identified action intent. Preview card appeared. User confirmed. Agent loop started. Agent opened Outlook, created new email, typed the recipient email correctly.
- **What failed:** Agent stopped after reaching max iterations (10). Activity log erased itself on completion, destroying debugging evidence. macOS permission prompts appeared mid-execution despite prior grants.

---

## Issue 1: AgentActivityLog Erases on Completion (CRITICAL)

### Symptom
When the agent loop finishes (either by completing, hitting max iterations, or erroring), the entire "Agent activity" log disappears from the chat view. The execution history is permanently lost.

### Root Cause
Two problems in `chatStore.ts`:

1. **Data erasure:** `receiveMessage()` (line ~192) sets `agentLog: []` when any message is received, including the final completion summary. This wipes the entire log.

2. **Component hidden:** `ChatView.tsx` (line ~52) only renders `<AgentActivityLog />` when `isAgentTyping === true`. When `receiveMessage()` sets `isAgentTyping: false`, the component disappears.

### Impact
- Cannot debug agent execution failures after the fact
- Users lose all visibility into what the agent did
- Makes the AgentActivityLog feature essentially useless -- it only shows while running, then vanishes

### Decided Fix: Snapshot into Conversation Messages (Approach A)

When the agent loop ends, convert the accumulated `agentLog` entries into a special `activity-log` message type stored permanently in the conversation's message array. The log becomes a collapsible card in the chat history -- visible forever, even after page refresh.

**What changes:**
- `chatStore.ts` `receiveMessage()`: Before clearing `agentLog`, snapshot entries into a new `ChatMessage` of type `activity-log` and append it to the conversation.
- `ChatMessage.tsx`: Add rendering for `type: 'activity-log'` messages -- collapsible card showing the execution history.
- `ChatView.tsx`: Remove the `isAgentTyping` guard on `<AgentActivityLog />` (it becomes part of the message stream).
- The live `<AgentActivityLog />` component continues to show during execution, but after completion the data lives in the chat message history.

### Priority: P0 -- Must fix before next testing session

---

## Issue 2: macOS Permission Prompts Appearing Repeatedly

### Symptom
Despite granting the WF-Agent Electron app full access (Accessibility, Screen Recording) during initial setup yesterday, the user was prompted again for:
1. "WFA Agent is requesting to bypass the system private window picker and directly access your screen and audio" (Screen Recording)
2. "WFA Agent wants access to control System Events" (Apple Events / Automation)

### Root Cause (from research)
- The setup window (`setup-window.ts`) checks Accessibility, Screen Recording, and Microphone permissions on first launch. But "Automation" permissions (controlling Outlook, System Events, etc.) are **per-target-app** and are **never checked** -- macOS prompts on first use.
- If the app was rebuilt/resigned since initial setup, macOS invalidates prior permission grants (tied to code signature).
- There is an existing P2 todo for this: `docs/agent/executor/todos/007-pending-p2-platform-guard-for-macos-permissions.md`

### Decided Fix: Pre-flight Permission Check

Add a permission verification step at the start of each agent execution:
1. Check Accessibility + Screen Recording before starting the agent loop
2. If missing, send a clear error message to the dashboard BEFORE attempting actions
3. For Automation permissions (per-app): these cannot be pre-checked programmatically on macOS, so document which apps need to be pre-authorized in the tester setup guide

### Priority: P1 -- Important for tester experience

---

## Issue 3: Agent Stops After Mid-Execution Permission Grant

### Symptom
When the agent was typing in Outlook and macOS prompted for permission to control Outlook, the user granted permission. However, the agent did not resume -- it stopped working.

### Root Cause
The command that triggered the permission prompt timed out (60s timeout in `sendCommandAndWait`). After granting the permission, the command had already been rejected. The agent loop treated the timeout as an error.

### Relationship to Issue 2
Direct consequence of Issue 2. If permissions were verified upfront, macOS would never interrupt mid-execution.

### Decided Fix: Addressed by Issue 2 pre-flight check
- Fix Issue 2 to prevent the interruption entirely
- No separate fix needed -- this is a symptom, not a root cause

### Priority: P1 -- Resolved by fixing Issue 2

---

## Issue 4: Agent Execution Speed -- Need KPI Tracking

### Symptom
The agent was "very slow" while performing the correct tasks. No metrics exist to track execution speed.

### Context
The pipeline involves multiple network hops:
```
Dashboard (Vercel) -> Bridge (Fly.io) -> Local Agent (user's Mac)
     | Claude API           |                    |
   Haiku (classify)    Sonnet (plan)       macOS actions
```

Each agent loop iteration involves:
1. Observation (screenshot + accessibility tree) -> sent to bridge
2. Bridge sends to Claude API -> waits for response
3. Claude response parsed -> command sent back to agent
4. Agent executes command on macOS -> result sent to bridge
5. 800ms fixed settle delay before next iteration
6. Repeat

### Research Finding
Timestamps already exist in every `ServerAgentProgress` message. No new server-side instrumentation needed. The 800ms fixed `settleDelayMs` in `agent-loop.ts` also adds latency to every iteration.

### Decided Fix: Calculate Durations from Existing Timestamps

- Dashboard: calculate and display per-phase durations in the AgentActivityLog UI by comparing consecutive timestamps
- Add total execution timer (start timestamp from first `server_agent_progress`, end from completion message)
- Show iteration count and average time per iteration
- Future: reduce `settleDelayMs` from 800ms to 400-500ms after testing stability

### Priority: P2 -- Important for optimization but not blocking

---

## Prioritized Fix Order

| Priority | Issue | Effort | Fix |
|----------|-------|--------|-----|
| P0 | Issue 1: Log erasure | Medium | Snapshot agentLog into conversation messages on completion |
| P1 | Issue 2+3: Permission prompts | Medium | Pre-flight permission check + tester docs |
| P2 | Issue 4: Speed KPI | Small | Calculate durations from existing timestamps in UI |

## Resolved Questions

- **Log persistence approach:** Approach A (snapshot into chat messages) -- permanent, survives page refresh, shows as collapsible card in conversation history.

## Open Questions

None -- all approaches decided.

## Next Steps

1. `/workflows:plan` for Issue 1 (P0) -- ship immediately
2. `/workflows:plan` for Issue 2 (P1) -- ship next
3. Issue 4 (P2) -- future sprint
