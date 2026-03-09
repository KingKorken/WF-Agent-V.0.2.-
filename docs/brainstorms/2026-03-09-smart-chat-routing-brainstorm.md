# Smart Chat Routing — Free-Form Task Execution via Chat

**Date:** 2026-03-09
**Status:** Brainstorm
**Component:** Bridge Server + Dashboard

---

## What We're Building

A smart routing layer that lets users type natural-language requests in the dashboard chat (e.g., "Send an email to Tim via Outlook") and have the system automatically detect whether the message is a conversational question or an actionable task. Actionable tasks are routed through the agent loop to the local agent for execution on the user's machine, with real-time progress and a confirmation/preview step before anything executes.

### The Problem Today

The bridge server has two completely separate paths for chat messages:

1. **Direct commands** (`/shell`, `/browser`, `/ax`, `/vision`) — routed to the local agent. Requires technical knowledge.
2. **Everything else** — routed to a text-only Claude API call with a system prompt that says "You do not have access to the user's screen or computer."

This means a non-technical user who types "send an email to Tim via Outlook" gets told they can't do it — even though the local agent running on their Mac has full capability to open Outlook, compose, and send. The agent loop (which powers workflow execution) is never invoked for free-form chat requests.

### Why This Matters

- **Target users** are knowledge workers (age 30-60) who don't know CLI commands
- The product's value proposition is automating repetitive work tasks
- Knowledge workers don't just run workflows — they also send emails, schedule meetings, look up information
- The local agent already has the technical capability (shell, CDP, accessibility, vision layers + skill learning)
- The gap is purely in the bridge's routing logic and system prompt

---

## Why This Approach (Auto-Classify + Confirm + Preview)

We chose auto-classification with confirmation because:

1. **Zero friction** — users type naturally, no modes or prefixes to learn
2. **Safe** — nothing executes until the user sees a preview and confirms
3. **Builds trust** — users see exactly what the agent plans to do before it touches their machine
4. **Handles edge cases** — if classification is wrong, the preview step catches it before any action

Rejected alternatives:
- **UI signal (explicit mode toggle):** Too much friction for non-technical users. They won't understand the distinction between "chat" and "execute" modes.
- **Always agent loop:** Wasteful for simple questions. Adds unnecessary latency and cost.

---

## Key Decisions

### 1. Message Classification

- The bridge uses a fast, cheap Claude call (Haiku) to classify each incoming chat message
- Classification output: `{ intent: "action" | "conversation", plan: string, confidence: number }`
- For "action" intents, `plan` is a short natural-language description of what the agent will do (shown in the confirmation step)
- Low-confidence classifications default to conversation — the user can always rephrase more explicitly
- The classification prompt receives the last few messages of conversation history so it can resolve references like "send that to Tim" from context
- Ambiguous messages like "Can you send emails?" should classify as conversation (question about capability). "Send an email to Tim" should classify as action (imperative request). The classification prompt should be tuned for this distinction.

### 2. Confirmation + Preview Flow

For action intents:
1. Bridge classifies message as actionable, generates a `plan` string
2. Bridge sends a **preview message** to dashboard: "I'll open Outlook and compose an email to Tim.buhrow@gmx.de wishing him a nice day."
3. Dashboard renders this as a special message type with **[Proceed]** and **[Cancel]** buttons
4. User reviews the plan and confirms or cancels
5. Bridge kicks off the agent loop with the confirmed task (goal = plan + original message + conversation context)
6. Real-time progress streams to dashboard (reuses existing workflow progress UI)
7. On completion, the agent reports what it did as a summary in the chat thread

Note: V1 is Proceed/Cancel only. Editing the plan before confirming is a future enhancement — keep it simple.

For conversation intents:
- Route to Claude API as today (no change, no confirmation needed)

### 3. Agent Loop for Free-Form Tasks

- Reuse the existing `runAgentLoop` function (same engine that powers workflow execution)
- The "goal" is constructed from: the classification plan + the user's original message + recent conversation history (for context)
- The agent loop uses the local agent's full capability stack: skills (if available) > shell > CDP > accessibility > vision
- If a skill exists for the target app (e.g., Outlook skill), use it first
- If no skill exists, the agent discovers how to do it via the execution layer cascade and optionally generates a new skill for next time (leveraging the shared skill base)
- **One action at a time per room:** If an agent loop is already running (workflow or free-form task), new action requests are rejected with "A task is already running. Please wait for it to finish." (same as existing `agentLoopActive` guard)

### 4. Progress Display

- Reuse existing `server_workflow_progress` message type and dashboard progress UI
- Stream step-by-step updates inline in the chat: "Opening Outlook...", "Composing email...", "Sending..."
- On completion, show a success summary in the chat thread

### 5. Agent Offline Handling

- If the local agent (Electron app) is not connected when an actionable request comes in, show a clear error: "Your WF-Agent app needs to be running to perform this task. Please open it and try again."
- Do not queue tasks — the user should see immediate feedback

### 6. Safety Guardrails

- **All actions require confirmation + preview** before execution
- The preview shows the agent's plan in natural language (what it will do, which app it will use)
- User must explicitly click [Proceed] — no auto-execution
- Destructive actions (delete, overwrite) get an additional warning in the preview
- Mid-execution cancellation: reuse existing `dashboard_workflow_cancel` message type, but the agent loop must respect it (currently not implemented — this is a known gap to address in planning)

---

## Architecture Changes Required

### Bridge Server (`server/src/bridge.ts`)

1. **New: `classifyMessage()` function** — calls Haiku to determine intent
2. **Modified: `handleChatMessage()`** — adds classification step before routing
3. **New: `handleActionMessage()`** — generates preview, waits for confirmation, then invokes agent loop
4. **Modified: `CHAT_SYSTEM_PROMPT`** — remove "you are text-only" restriction; update to reflect new capabilities
5. **Modified: Dockerfile** — include `local-agent/` in the build, remove `AGENT_MODULES_PATH=/nonexistent`

### Shared Types (`shared/types.ts`)

1. **New: `ServerActionPreview`** — message type for confirmation/preview
2. **New: `DashboardActionConfirm`** — user confirms the previewed action
3. **New: `DashboardActionCancel`** — user cancels the previewed action

### Dashboard (`dashboard/src/`)

1. **New: preview message component** — renders the confirmation UI with [Proceed] / [Cancel] buttons
2. **Modified: `chatStore.ts`** — handle new message types, send confirm/cancel
3. **Modified: `message-router.ts`** — route new message types

### Message Types (New)

```
dashboard_chat (existing) → bridge classifies
  ├── conversation → simpleChatWithClaude (existing)
  └── action → bridge sends ServerActionPreview
        ├── DashboardActionConfirm → bridge runs agent loop
        └── DashboardActionCancel → bridge sends "Cancelled" response
```

---

## Classification Design

**Principle:** Imperative commands that require the agent to DO something on the user's machine = action. Questions, capability inquiries, and data retrieval = conversation.

**Examples:**
- "Send an email to Tim via Outlook" → action (imperative, requires app interaction)
- "Draft me an email to Tim" → action (requires opening Outlook to draft)
- "Schedule a meeting with Tim tomorrow at 3pm" → action (requires Calendar app)
- "Can you send emails?" → conversation (capability question)
- "What's on my calendar today?" → conversation (informational query)
- "I need to send Tim an email" → low-confidence → defaults to conversation (user can rephrase)

**Prompt design:** The classification prompt receives:
1. The user's current message
2. The last 5-10 messages of conversation history (for resolving references like "send that to Tim")
3. Whether the local agent is currently connected and what layers it supports

**Confidence threshold:** Messages below the threshold default to conversation. The threshold should be tuned through testing. Starting point: 0.7.

---

## Agent Loop Execution Architecture

**Decision: Agent loop runs on the bridge server (Fly.io), not on the local agent.**

The bridge server orchestrates the planning loop (calls Claude API, decides what to do next). Individual commands are sent to the local agent via WebSocket. The local agent is a command executor — it receives a command, executes it on the user's Mac, and returns the result.

This is the same architecture used for workflow execution (`handleWorkflowRun` → `runAgentLoop`). The only change needed is including the agent loop modules in the Docker build:
- The Dockerfile currently sets `AGENT_MODULES_PATH=/nonexistent` to skip loading
- To enable: copy and build `local-agent/` source in the Docker build, remove the override

**Why server-side:**
- All intelligence centralized (one place to update, debug, monitor)
- Anthropic API key stays on the server (never on user's machine)
- Same pattern as existing workflow execution
- Latency tradeoff is acceptable (~50-100ms extra per command step, but each step takes seconds anyway)

---

## Edge Cases & Risks

1. **Classification latency:** Haiku adds ~200-500ms to every message. For conversation-only messages this is noticeable. Mitigation: classification is fast and happens once; the alternative (always running the agent loop) is far slower.

2. **Multi-turn action context:** "Send that to Tim" only makes sense if the classifier sees previous messages. The classification call must include recent conversation history (last 5-10 messages).

3. **Agent loop Docker build:** The Dockerfile must be updated to include agent loop modules. This makes the Docker image larger but is a straightforward build change.

4. **Preview scope:** For some tasks, a detailed preview is easy (email: show the draft text). For others it's vague ("I'll sort column B in Excel"). V1: the plan string from the classifier is the preview. Don't try to generate detailed artifacts (email drafts, etc.) at classification time — that's over-engineering.

5. **Stale confirmation:** User gets a preview, walks away for 30 minutes, comes back and clicks [Proceed]. The local agent may have disconnected. Mitigation: check agent connection status when processing the confirmation, not just at classification time.

6. **Classification misfire rate:** If the classifier is wrong too often, users lose trust. Mitigation: default to conversation when uncertain. A missed action classification is better than a false one (user just rephrases; vs getting an unwanted confirmation prompt).

---

## Open Questions

*None — all questions resolved during brainstorm.*

---

## Resolved Questions

1. **Routing approach:** Auto-classify with confirmation (not UI modes, not always-agent-loop)
2. **Skill usage:** Use existing skills first, then discover/learn via execution layer cascade
3. **Local agent required:** Yes — the Electron/DMG app must be running. Users install it as a native Mac app (no terminal). Clear error if offline.
4. **Progress display:** Real-time, inline in chat thread, reusing existing workflow progress infrastructure
5. **Safety:** All actions require confirmation + preview. User sees exactly what will happen before anything executes.
6. **Agent offline behavior:** Clear error message, no task queuing
