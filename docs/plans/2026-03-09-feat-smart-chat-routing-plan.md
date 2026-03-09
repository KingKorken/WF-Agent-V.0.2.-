---
title: "feat: Smart Chat Routing — Free-Form Task Execution via Chat"
type: feat
status: completed
date: 2026-03-09
origin: docs/brainstorms/2026-03-09-smart-chat-routing-brainstorm.md
---

# Smart Chat Routing — Free-Form Task Execution via Chat

## Overview

Add a classification layer to the bridge server that auto-detects whether a user's chat message is conversational or actionable. Actionable messages get a confirmation/preview step, then execute through the existing agent loop on the user's machine via the local agent. This unlocks the product's core promise: knowledge workers type "Send an email to Tim via Outlook" and the agent does it — no CLI commands, no mode toggles.

## Problem Statement / Motivation

The bridge server currently has two completely separate paths for chat messages:

1. **Direct commands** (`/shell`, `/browser`, `/ax`, `/vision`) — routed to the local agent. Requires technical knowledge.
2. **Everything else** — routed to a text-only Claude API call with a system prompt that says "You do not have access to the user's screen or computer."

This means a non-technical user who types "send an email to Tim via Outlook" gets told the agent can't do it — even though the local agent running on their Mac has full capability to open Outlook, compose, and send. The agent loop (`runAgentLoop`) that powers workflow execution is never invoked for free-form chat requests.

**Root cause:** `CHAT_SYSTEM_PROMPT` at `server/src/bridge.ts:429-442` explicitly declares the assistant text-only. `handleChatMessage()` at `server/src/bridge.ts:565-653` routes non-direct messages straight to `simpleChatWithClaude()` with no classification step.

(see brainstorm: `docs/brainstorms/2026-03-09-smart-chat-routing-brainstorm.md` — "The Problem Today")

## Proposed Solution

Auto-classify each incoming chat message using a fast Haiku call, then route based on intent:

```
dashboard_chat (existing) → bridge classifies
  ├── conversation → simpleChatWithClaude (existing, no change)
  └── action → bridge sends ServerActionPreview
        ├── DashboardActionConfirm → bridge runs agent loop
        └── DashboardActionCancel → bridge sends "Cancelled" response
```

Key properties:
- **Zero friction** — users type naturally, no modes or prefixes
- **Safe** — nothing executes until the user sees a preview and confirms
- **Builds trust** — users see exactly what the agent plans before it touches their machine
- **Handles edge cases** — if classification is wrong, the preview step catches it before any action

(see brainstorm: "Why This Approach")

## Technical Considerations

### Architecture

- **Agent loop runs on the bridge server (Fly.io)**, not on the local agent (see brainstorm: "Agent Loop Execution Architecture")
- Bridge orchestrates planning (calls Claude API, decides next action); individual commands are sent to the local agent via WebSocket
- Same architecture as existing `handleWorkflowRun` → `runAgentLoop`
- The Dockerfile must be updated to include agent loop modules (currently `AGENT_MODULES_PATH=/nonexistent` at `Dockerfile:67` excludes them)

### Classification

- Haiku classifies each message: `{ intent: "action" | "conversation", plan: string, confidence: number }`
- Confidence threshold: 0.7 (below = defaults to conversation)
- Classification prompt receives last 10 messages of conversation history for context resolution ("send that to Tim")
- Imperative commands = action; questions/capability inquiries = conversation
- Classification adds ~200-500ms latency per message (acceptable; alternative of always-agent-loop is far slower)

### Confirmation Flow

- Bridge sends `server_action_preview` with the plan text and a `previewId`
- Dashboard renders a special message type with [Proceed] and [Cancel] buttons
- On confirm: bridge rechecks agent connection, then runs agent loop
- On cancel: bridge responds with "Cancelled" in chat
- V1: Proceed/Cancel only, no plan editing (see brainstorm: "Key Decisions > Confirmation + Preview Flow")

### Progress & Completion

- Reuse existing `server_agent_progress` message type routed to chatStore (not workflowStore)
- Progress displays inline in the chat thread: "Opening Outlook...", "Composing email...", "Sending..."
- On completion, agent reports what it did as a summary in the chat thread via `server_chat_response`
- The existing `ProgressCard.tsx` component can be reused for in-chat progress rendering

### Safety

- All actions require confirmation + preview before execution (see brainstorm: "Safety Guardrails")
- User must explicitly click [Proceed] — no auto-execution
- One action at a time per room — reuses existing `room.agentLoopActive` guard (`bridge.ts:198-199`)
- Stale confirmation: recheck agent connection status when processing confirm (not just at classification time)

### Performance

- Haiku classification: ~200-500ms per message
- Agent loop: same latency profile as workflow execution (~50-100ms extra per command step)
- No new API keys or external services required

### Security

- Classification response validated as strict discriminated union (not `Record<string, unknown>`)
- `previewId` uses `crypto.randomUUID()` for correlation — prevents replay/mismatch
- Rate limiting already in place (`bridge.ts:395-398`) applies to classification calls too
- All existing origin validation and message whitelist validation apply

## System-Wide Impact

- **Bridge server:** New classification function, modified chat handler, new action handler. ~200 lines of new code.
- **Shared types:** 3 new message type interfaces + updated `WebSocketMessage` union.
- **Dashboard:** New preview message component, updated message router, updated chat store.
- **Dockerfile:** Must include `local-agent/` in the build and remove `AGENT_MODULES_PATH=/nonexistent`.
- **No changes** to the local agent, workflow store, or recording pipeline.

## Acceptance Criteria

### Functional Requirements

- [x] User types "Send an email to Tim via Outlook" → sees a preview card with the plan → clicks [Proceed] → agent executes → completion summary appears in chat
- [x] User types "Can you send emails?" → receives a conversational response (no preview card)
- [x] User types "What time is it?" → receives a conversational response (no classification delay perceptible to user)
- [x] If agent is offline when action is detected, user sees: "Your WF-Agent app needs to be running to perform this task. Please open it and try again."
- [x] If agent loop is already running, new action requests are rejected with: "A task is already running. Please wait for it to finish."
- [x] User clicks [Cancel] on preview → sees "Cancelled" in chat, can continue chatting normally
- [x] Real-time progress streams to chat during execution (step-by-step updates)
- [x] Classification uses conversation history (last 10 messages) so "send that to Tim" works in context
- [x] Stale confirmation (agent disconnects between preview and confirm) shows appropriate error

### Non-Functional Requirements

- [x] Classification latency < 500ms (Haiku)
- [x] No regressions in existing chat, workflow, or recording functionality
- [x] All new message types added to `KNOWN_MESSAGE_TYPES` set
- [x] Preview card follows design rules (no new colors, Inter font, 4px radius, orange text for [Proceed])
- [x] TypeScript strict — no `as unknown as` double casts

### Quality Gates

- [ ] Bridge classification logic covered by unit tests (action vs conversation examples from brainstorm)
- [ ] Integration test: preview → confirm → agent loop execution flow
- [ ] Integration test: agent offline → error message
- [ ] Manual end-to-end test: email composition request with real Outlook

## Implementation Phases

### Phase 1: Shared Types & Bridge Classification (Foundation)

**Files:**
- `shared/types.ts` — add 3 new message type interfaces
- `server/src/bridge.ts` — add `classifyMessage()`, update `KNOWN_MESSAGE_TYPES`

**Tasks:**

1. **Add new message types to `shared/types.ts`:**

```typescript
// After ServerWorkflowProgress (line ~498)

/** Action preview sent from bridge to dashboard for user confirmation */
export interface ServerActionPreview {
  type: 'server_action_preview';
  /** Unique ID for this preview — echoed back in confirm/cancel */
  previewId: string;
  /** The conversation this preview belongs to */
  conversationId: string;
  /** Human-readable plan shown to the user */
  plan: string;
  /** The original user message that triggered this preview */
  originalMessage: string;
}

/** User confirms the previewed action */
export interface DashboardActionConfirm {
  type: 'dashboard_action_confirm';
  /** Echoes the previewId from ServerActionPreview */
  previewId: string;
  /** The conversation this belongs to */
  conversationId: string;
}

/** User cancels the previewed action */
export interface DashboardActionCancel {
  type: 'dashboard_action_cancel';
  /** Echoes the previewId from ServerActionPreview */
  previewId: string;
  /** The conversation this belongs to */
  conversationId: string;
}
```

2. **Update `WebSocketMessage` union** (`shared/types.ts:690-704`) to include the 3 new types.

3. **Add `classifyMessage()` function** to `server/src/bridge.ts`:

```typescript
interface ClassificationResult {
  intent: 'action' | 'conversation';
  plan: string;
  confidence: number;
}

async function classifyMessage(
  userMessage: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  agentConnected: boolean,
  supportedLayers: string[],
): Promise<ClassificationResult> {
  // Call Haiku with classification prompt
  // Include last 10 messages of conversation history
  // Return { intent, plan, confidence }
  // Default to conversation if confidence < 0.7
}
```

4. **Add new types to `KNOWN_MESSAGE_TYPES`** (`bridge.ts:126-136`):
   - `'server_action_preview'`
   - `'dashboard_action_confirm'`
   - `'dashboard_action_cancel'`

**Acceptance:** `classifyMessage()` correctly classifies the brainstorm examples: "Send an email to Tim via Outlook" → action, "Can you send emails?" → conversation, "What's on my calendar today?" → conversation.

---

### Phase 2: Bridge Chat Handler + Action Flow

**Files:**
- `server/src/bridge.ts` — modify `handleChatMessage()`, add `handleActionConfirm()`, add `handleActionCancel()`

**Tasks:**

1. **Add pending preview tracking** to the `Room` class:

```typescript
// In Room class — track pending action previews
interface PendingActionPreview {
  previewId: string;
  conversationId: string;
  originalMessage: string;
  plan: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number; // Date.now()
}

// Room gets a new field:
private _pendingPreview: PendingActionPreview | null = null;
```

2. **Modify `handleChatMessage()`** (`bridge.ts:565-653`):
   - Classification runs only for non-direct messages (direct commands like `/shell` bypass classification entirely)
   - In the existing `else` branch (after the `isDirect` block, line 627), before calling `simpleChatWithClaude()`: call `classifyMessage()` with conversation history, agent status, supported layers
   - If intent = "action" and confidence >= 0.7:
     - Check agent connection → if offline, send error message
     - Check `room.agentLoopActive` → if active, send "task already running" error
     - Generate `previewId` via `crypto.randomUUID()`
     - Store as `room._pendingPreview`
     - Send `ServerActionPreview` to dashboard
     - Return (do NOT run `simpleChatWithClaude`)
   - If intent = "conversation" or confidence < 0.7:
     - Fall through to existing `simpleChatWithClaude()` path (no change)
   - If `classifyMessage()` throws (Haiku API error, timeout, rate limit):
     - Log the error
     - Fall through to `simpleChatWithClaude()` (safe default — treat as conversation)

3. **Update `CHAT_SYSTEM_PROMPT`** (`bridge.ts:429-442`):
   - Remove: "You do not have access to the user's screen or computer. You are text-only."
   - Remove: "If the user asks you to perform a desktop action, explain they need to start a recorded workflow or use a direct command (/shell, /browser, /ax, /vision)."
   - Add: "If the user asks you to perform a desktop action and you are in conversation mode, let them know they can rephrase their request as a direct instruction (e.g., 'Send an email to Tim') and you will handle it."

4. **Add `handleActionConfirm()`:**
   - Validate `previewId` matches `room._pendingPreview`
   - Recheck `room.isAgentConnected` (stale confirmation guard)
   - Recheck `room.agentLoopActive` (guard against race)
   - Construct goal: classification plan + original message + recent conversation history
   - Set `room.agentLoopActive = true`
   - Clear `room._pendingPreview`
   - Run `runAgentLoop()` with `onStep`/`onAction` callbacks that send **`server_agent_progress`** to the dashboard (note: this differs from `handleWorkflowRun` which sends `server_workflow_progress` — free-form task progress should route to `chatStore`, not `workflowStore`)
   - On completion: send summary via `server_chat_response`, set `room.agentLoopActive = false`

5. **Add `handleActionCancel()`:**
   - Validate `previewId` matches `room._pendingPreview`
   - Clear `room._pendingPreview`
   - Send "Cancelled." via `server_chat_response`

6. **Add switch cases** in the connection handler (`bridge.ts:874-1074`) for:
   - `'dashboard_action_confirm'` → find room, call `handleActionConfirm()`
   - `'dashboard_action_cancel'` → find room, call `handleActionCancel()`

**Acceptance:** Full server-side flow works: classify → preview → confirm → agent loop → summary. Cancel flow works. Agent offline and stale confirmation errors handled.

---

### Phase 3: Dashboard — Message Routing & Store

**Files:**
- `dashboard/src/services/message-router.ts` — add `server_action_preview` handler
- `dashboard/src/stores/chatStore.ts` — add preview message type, confirm/cancel actions

**Tasks:**

1. **Extend `MessageType`** in `chatStore.ts:5`:
   - Add `'action-preview'` to the union: `export type MessageType = 'text' | 'progress-card' | 'data-card' | 'error' | 'action-preview';`

2. **Extend `ChatMessage`** in `chatStore.ts:7-14`:
   - Add optional `previewId?: string` field (used for action-preview messages)

3. **Add `confirmAction` and `cancelAction` methods** to the chat store:

```typescript
confirmAction: (previewId: string, conversationId: string) => {
  wsService.send({
    type: 'dashboard_action_confirm',
    previewId,
    conversationId,
  });
  // Update the preview message in state to disable buttons immediately
  set((state) => ({
    conversations: state.conversations.map((c) =>
      c.id === conversationId
        ? {
            ...c,
            messages: c.messages.map((m) =>
              m.previewId === previewId ? { ...m, type: 'text' as const, content: m.content + '\n\nConfirmed — executing...' } : m
            ),
          }
        : c
    ),
  }));
},

cancelAction: (previewId: string, conversationId: string) => {
  wsService.send({
    type: 'dashboard_action_cancel',
    previewId,
    conversationId,
  });
  // Update the preview message to reflect cancellation
  set((state) => ({
    conversations: state.conversations.map((c) =>
      c.id === conversationId
        ? {
            ...c,
            messages: c.messages.map((m) =>
              m.previewId === previewId ? { ...m, type: 'text' as const, content: m.content + '\n\nCancelled.' } : m
            ),
          }
        : c
    ),
  }));
},
```

4. **Add import** for `ServerActionPreview` type in `message-router.ts:9-21`.

5. **Add switch case** in `message-router.ts:32-140` for `'server_action_preview'`:

```typescript
case 'server_action_preview': {
  const msg = message as ServerActionPreview;
  useChatStore.getState().receiveMessage(msg.conversationId, {
    id: `preview_${msg.previewId}`,
    role: 'agent',
    type: 'action-preview',
    content: msg.plan,
    previewId: msg.previewId,
    timestamp: new Date(),
  });
  break;
}
```

6. **Handle `server_agent_progress` for chat actions**: The existing `server_agent_progress` handler (`message-router.ts:46-56`) already routes to `chatStore.setAgentProgress()`. This works as-is for free-form task progress because `handleActionConfirm()` sends `server_agent_progress` (not `server_workflow_progress` which would route to `workflowStore`). No change needed in the message router — the existing handler covers this.

**Acceptance:** Dashboard receives `server_action_preview`, stores it as an `action-preview` message in the chat, and can send confirm/cancel via WebSocket.

---

### Phase 4: Dashboard — Preview Card UI

**Files:**
- `dashboard/src/components/Chat/ChatMessage.tsx` — add action-preview rendering branch
- `dashboard/src/components/Chat/ChatMessage.module.css` — add preview card styles

**Tasks:**

1. **Add action-preview rendering** to `ChatMessage.tsx` (follows the error card pattern at lines 12-37). Note: `conversationId` is passed as a new prop from `ChatView.tsx`:

```tsx
interface ChatMessageProps {
  message: ChatMessageType;
  conversationId: string;  // NEW — needed for confirm/cancel
  onRetry?: (messageId: string) => void;
}

// ... inside the component:

if (message.type === 'action-preview') {
  return (
    <div className={styles.message} data-type="action-preview">
      <div className={styles.previewCard}>
        <div className={styles.previewHeader}>
          Action plan
        </div>
        <p className={styles.previewBody}>{message.content}</p>
        <div className={styles.previewActions}>
          <button
            className={styles.previewProceed}
            onClick={() => {
              if (message.previewId) {
                useChatStore.getState().confirmAction(message.previewId, conversationId);
              }
            }}
          >
            Proceed
          </button>
          <button
            className={styles.previewCancel}
            onClick={() => {
              if (message.previewId) {
                useChatStore.getState().cancelAction(message.previewId, conversationId);
              }
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
```

2. **Add CSS** to `ChatMessage.module.css` following design rules:
   - `.previewCard`: same pattern as `.errorCard` (border-left, padding, radius 4px, flex column, gap)
   - Border-left color: use accent `var(--color-accent)` (burnt orange #C55A2B) — this is the one orange element for this message
   - `.previewProceed`: orange text, no fill, no outline (design rule: "Primary: Orange TEXT only")
   - `.previewCancel`: black text, regular weight (design rule: "Secondary: Black text")
   - Inter font, font-size-sm, relaxed line height

3. **Disable buttons after click**: After user clicks [Proceed] or [Cancel], disable both buttons and update text to show "Confirmed..." or "Cancelled" to prevent double-clicks.

4. **Handle `conversationId` threading**: The `ChatMessage` component needs access to the conversation ID. Pass it as a prop from `ChatView.tsx` (the parent that renders messages).

**Acceptance:** Preview card renders in chat with plan text, [Proceed] and [Cancel] buttons. Follows all design rules (Inter font, 4px radius, orange text for Proceed, no other colors). Buttons disable after click.

---

### Phase 5: Dockerfile & Deployment

**Files:**
- `Dockerfile` — update to include `local-agent/` in the build

**Tasks:**

1. **Add `local-agent/` source to builder stage** (after line 24):
   ```dockerfile
   COPY local-agent/ local-agent/
   ```

2. **Add `local-agent` to the build step** (line 28-29):
   ```dockerfile
   RUN npm run build --workspace=@workflow-agent/shared && \
       npm run build --workspace=@workflow-agent/local-agent && \
       npm run build --workspace=@workflow-agent/server
   ```

3. **Copy compiled local-agent output to runtime** (after line 54):
   ```dockerfile
   COPY --from=builder /app/local-agent/dist local-agent/dist
   ```

4. **Remove `AGENT_MODULES_PATH=/nonexistent`** (line 67) — or set it to the correct path.

5. **Verify `loadAgentModules()`** (`bridge.ts:90-104`) resolves correctly with the new path structure in the Docker image.

6. **Verify no native dependencies:** The `local-agent/` package may import modules for accessibility, vision, or CDP that have native bindings (e.g., `node-mac-permissions`). Since `runAgentLoop` only needs the orchestration logic (not the execution layers themselves — those run on the user's Mac), confirm that the agent loop module and its direct imports are pure JS. If native deps exist, they should be optional/lazy-loaded and handled gracefully when unavailable.

**Acceptance:** Docker image builds successfully with agent loop modules. `loadAgentModules()` returns `true` on startup. `runAgentLoop` is available for both workflow execution and free-form task execution.

---

## Alternative Approaches Considered

1. **UI mode toggle (chat vs execute):** Rejected — too much friction for non-technical users who won't understand the distinction. (see brainstorm: "Rejected alternatives")

2. **Always route through agent loop:** Rejected — wasteful for simple questions, adds unnecessary latency and cost. (see brainstorm: "Rejected alternatives")

3. **Agent loop runs on local agent:** Rejected — Anthropic API key would need to be on user's machine, intelligence would be distributed (harder to update/debug), and it breaks the existing architecture pattern. (see brainstorm: "Agent Loop Execution Architecture > Why server-side")

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Classification misfire rate too high | Medium | Users lose trust in the product | Default to conversation when uncertain. Missed action < false action. User can rephrase. |
| Haiku classification latency noticeable | Low | 200-500ms delay on every message | Fast and happens once; acceptable. Alternative (always-agent-loop) is far slower. |
| Docker image size increase | Low | Slower deploys | Straightforward build change; image size increase is minimal. |
| Stale confirmation after agent disconnect | Low | Confusing error | Recheck agent connection at confirmation time, not just classification time. |
| Agent loop error during free-form task | Medium | Task fails mid-execution | Same error handling as workflow execution — send error summary in chat. |

## Known V1 Limitations (Intentional)

- **No plan editing before confirm:** V1 is Proceed/Cancel only. Editing the plan is a future enhancement. (see brainstorm: "Note: V1 is Proceed/Cancel only")
- **No mid-execution cancellation:** The agent loop does not currently support graceful cancellation. The `dashboard_workflow_cancel` message type exists but the loop doesn't check for it. This is a known gap to address in a future iteration. (see brainstorm: "Safety Guardrails")
- **No detailed preview artifacts:** V1 uses the classification plan string as the preview. No email drafts, no detailed step breakdowns at preview time. (see brainstorm: "Edge Cases > Preview scope")

## SpecFlow Gaps Addressed

The SpecFlow analysis identified 25 gaps. Key ones addressed in this plan:

1. **Correlation ID for preview/confirm flow** → `previewId` field on `ServerActionPreview`, echoed in confirm/cancel.
2. **Classification API failure** → Falls through to conversation path (safe default).
3. **Progress routing** → Uses existing `server_agent_progress` → `chatStore.setAgentProgress()` path. No workflowStore involvement.
4. **`agentLoopActive` timing** → Checked at both classification time AND confirmation time.
5. **Button state after click** → Buttons disabled after click, text updates to "Confirmed..."/"Cancelled".
6. **Chat input during execution** → Chat input remains active. Conversational messages still work (routed to `simpleChatWithClaude`). New action requests rejected with clear message.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-09-smart-chat-routing-brainstorm.md](docs/brainstorms/2026-03-09-smart-chat-routing-brainstorm.md) — Key decisions carried forward: auto-classify with confirmation (not UI modes), agent loop on bridge server (not local agent), Haiku for classification, confidence threshold 0.7, reuse existing agent loop and progress UI.

### Internal References

- Bridge server chat handling: `server/src/bridge.ts:565-653`
- Chat system prompt (to be updated): `server/src/bridge.ts:429-442`
- Workflow run handler (pattern to follow): `server/src/bridge.ts:659-749`
- Agent loop loader: `server/src/bridge.ts:90-104`
- Message type whitelist: `server/src/bridge.ts:126-136`
- Room class with `agentLoopActive` guard: `server/src/bridge.ts:178-372`
- Shared types union: `shared/types.ts:690-704`
- Dashboard chat store: `dashboard/src/stores/chatStore.ts`
- Dashboard message router: `dashboard/src/services/message-router.ts`
- Chat message component: `dashboard/src/components/Chat/ChatMessage.tsx`
- Error card pattern (to follow for preview card): `ChatMessage.tsx:12-37`, `ChatMessage.module.css:32-98`
- Dockerfile agent exclusion: `Dockerfile:67`
- Design rules (LOCKED): `docs/dashboard/ui/design-rules.md`

### Institutional Learnings

- Bridge server deployment patterns: `docs/connection/solutions/bridge-server-websocket-production-deployment.md`
- Cloud preview connection failures: `docs/connection/solutions/vercel-dashboard-cloud-preview-connection-failure.md`
- Code review type safety patterns: `docs/workflows/solutions/parallel-agent-code-review-methodology.md`
- Shared skill base integration: `docs/agent/intelligence-layer/solutions/shared-skill-base-network-learning.md`
