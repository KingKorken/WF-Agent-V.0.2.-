# Agent Execution Debugging Handoff

> **Date:** 2026-03-12
> **Purpose:** Complete context for debugging three critical issues discovered during testing sessions on 2026-03-12.
> **Repo:** `/Users/timbuhrow/Desktop/WF-Agent-V.0.2.-/`

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Testing Session Results](#testing-session-results)
3. [Bug 1: vision/type_text JXA Failures](#bug-1-visiontype_text-jxa-failures)
4. [Bug 2: Intelligence Layer Not Learning Between Runs](#bug-2-intelligence-layer-not-learning-between-runs)
5. [Bug 3: Slow Execution Time (~10 minutes per task)](#bug-3-slow-execution-time-10-minutes-per-task)
6. [Bug 4: Agent Claims Success Despite All Actions Failing](#bug-4-agent-claims-success-despite-all-actions-failing)
7. [Bug 5: Outlook Skill Not Being Used](#bug-5-outlook-skill-not-being-used)
8. [Key File Reference](#key-file-reference)
9. [Code Deep Dive](#code-deep-dive)
10. [Previously Fixed Issues](#previously-fixed-issues)
11. [Deploy Pipeline](#deploy-pipeline)

---

## Architecture Overview

```
Dashboard (React on Vercel)
    ↕ WebSocket
Bridge Server (Node.js on Fly.io)
    - Classifies user intent (action vs conversation) using Claude Haiku
    - Runs agent loop (runAgentLoop) — the AI brain
    - Calls Claude Sonnet for decisions
    ↕ WebSocket
Local Agent (Electron app on user's Mac)
    - Executes commands received from bridge
    - Takes screenshots, reads accessibility tree
    - Controls mouse/keyboard via JXA
    - Returns results to bridge
```

### Key Data Flow for a Task

1. User types in dashboard chat: "Send an email to Tim.buhrow@gmx.de"
2. Dashboard → Bridge: `dashboard_chat` message
3. Bridge classifies as "action" intent → sends `server_action_preview` to dashboard
4. User clicks "Confirm" in dashboard
5. Bridge calls `runAgentLoop()` with the goal
6. Agent loop: `decomposeTask()` → breaks into sub-goals (Open Outlook, Compose, Fill, Send...)
7. For each sub-goal, the loop iterates:
   - **OBSERVE**: Bridge sends `vision/screenshot` + `vision/collect_context` commands → Local Agent captures screen → returns base64 PNG + metadata
   - **DECIDE**: Bridge sends observation to Claude Sonnet API → Claude returns JSON with action
   - **ACT**: Bridge sends action command (e.g., `vision/click_coordinates`) → Local Agent executes → returns result
   - Repeat until Claude says `status: "complete"` or max iterations reached
8. Bridge sends progress updates to dashboard throughout

### Where the Agent Loop Runs

**The agent loop runs on the Fly.io bridge server**, NOT on the local Electron app. The bridge dynamically loads `runAgentLoop` from `local-agent/dist/src/agent/agent-loop` (see `loadAgentModules()` in `server/src/bridge.ts` lines 114-143). The local agent is purely an executor — it receives commands via WebSocket and returns results.

### Connection Identity

The local agent connects with name `workflow-agent-local` (from `shared/constants.ts`). This appears in the dashboard as the connection status. This is normal and expected — it means the Electron app is connected to the bridge.

---

## Testing Session Results

### Test 1 (2026-03-12, ~575s / 9.6 min)

**Prompt:** "Hello whats up, please write an email from my outlook account. This email should be to 'Tim.buhrow@gmx.de' and I would like to wish him a nice day."

**Result:** Partial success. Agent opened Outlook, clicked New Email (twice — state awareness issue), filled recipient, typed subject. Failed to write email body (vision/type_text JXA failures). Ran out of 25-step budget. **Email NOT sent.**

| Sub-goal | Steps Used | Outcome | Key Issue |
|----------|-----------|---------|-----------|
| Open Outlook | 2 | Complete | Worked fine |
| Compose new email | 3 | Complete | Clicked "New Email" twice (thought first click didn't work) |
| Fill in recipient | 12 | Complete | JXA type_text failed repeatedly; fell back to shell/exec pbcopy+paste |
| Add subject line | 5 | Complete | JXA type_text failed once; retry worked |
| Write email body | 3 | Failed | JXA type_text failed; ran out of steps |
| Send the email | 0 | Failed | Never started (budget exhausted) |

**Action success/failure breakdown:**

| Action Type | Attempts | Successes | Failures |
|-------------|----------|-----------|----------|
| shell/launch_app | 1 | 1 | 0 |
| vision/click_coordinates | 9 | 9 | 0 |
| vision/type_text | 4 | 1 | 3 |
| vision/key_combo | 1 | 0 | 1 |
| shell/exec | 5 | 2 | 3 |
| accessibility/snapshot | 1 | 0 | 1 |

### Test 2 (2026-03-12, ~555s / 9.3 min)

**Prompt:** Same as Test 1.

**Result:** Worse than Test 1. Agent opened Outlook, composed email, but got stuck trying to type recipient email for 16 steps. Never reached subject/body/send. **Email NOT sent.**

**Key observation:** No improvement from Test 1. The intelligence layer did NOT learn anything. The agent started completely from scratch, made the same mistakes, used the same failing approaches.

| Sub-goal | Steps Used | Outcome | Key Issue |
|----------|-----------|---------|-----------|
| Open Outlook | 2 | Complete | Worked fine |
| Create new email | 2 | Complete | Worked fine |
| Enter recipient | 17 | Complete | Massive struggle with type_text failures |
| Compose message | 4 | Failed | Budget exhausted after recipient struggle |
| Send email | 0 | Failed | Never started |

**Action success/failure breakdown:**

| Action Type | Attempts | Successes | Failures |
|-------------|----------|-----------|----------|
| shell/launch_app | 1 | 1 | 0 |
| vision/click_coordinates | 9 | 9 | 0 |
| vision/type_text | 4 | 0 | 4 |
| vision/key_combo | 2 | 1 | 1 |
| shell/exec | 6 | 3 | 3 |
| accessibility/snapshot | 1 | 0 | 1 |

### Key Pattern

- **vision/click_coordinates ALWAYS works** (18/18 = 100%)
- **vision/type_text MOSTLY fails** (1/8 = 12.5%)
- **vision/key_combo unreliable** (1/3 = 33%)
- **shell/exec mixed** (5/11 = 45%) — fails when using osascript/AppleScript
- **accessibility/snapshot ALWAYS fails** (0/2 = 0%)

---

## Bug 1: vision/type_text JXA Failures

### Symptom

`vision/type_text` fails with JXA script errors on ~88% of attempts. The agent wastes most of its 25-step budget retrying typing with the same failing approach.

### Root Cause

The `typeText()` function in `local-agent/src/executor/vision/vision-actions.ts` (lines 339-365) uses JXA `System Events.keystroke()`:

```typescript
const script = `Application('System Events').keystroke("${escaped}");`;
await runJxa(script);
```

This differs from `clickAt()` which uses **CoreGraphics** (a lower-level, more reliable API):

```typescript
// clickAt uses CoreGraphics — WORKS
ObjC.import('CoreGraphics');
var pt = $.CGPointMake(scaledX, scaledY);
var down = $.CGEventCreateMouseEvent(...);
$.CGEventPost($.kCGHIDEventTap, down);
```

**Why clicking works but typing fails:**

| | vision/click_coordinates | vision/type_text |
|---|---|---|
| API | CoreGraphics (C-level) | System Events (AppleScript bridge) |
| macOS Permission | Screen Recording | **Accessibility** |
| Reliability | Very high | Low (JXA process issues) |
| Known Issues | None | JXA crashes when spawned from Electron |

The Outlook skill source code confirms this: `local-agent/src/skills/outlook-skill.ts` lines 7-8 has a comment:
> "JXA crashes when spawned from Electron; AppleScript works because it uses Automation permissions, not Accessibility permissions."

**Specific failure modes for System Events keystroke:**
1. JXA script timeout (4s limit in `macos-ax.ts` line 30)
2. System Events connection error ("Application System Events got an error: Connection is invalid")
3. Accessibility permission intermittently dropping
4. Electron process spawning JXA subprocess unreliably

### No Fallback Mechanism

When `typeText()` fails, it simply returns `{ success: false, error: message }`. There is:
- No retry within the function
- No fallback to `pbcopy` + `Cmd+V` (paste)
- No fallback to CoreGraphics key events
- No fallback to AppleScript (`osascript -e 'tell application "System Events" to keystroke...'`)

The agent (Claude) eventually discovers the clipboard workaround (`pbcopy | osascript` to paste), but it wastes 5-10 steps figuring this out each time because the intelligence layer doesn't remember it.

### Files to Fix

- `local-agent/src/executor/vision/vision-actions.ts` — `typeText()` (line 339) and `typeKeyCombo()` (line 377)
- `local-agent/src/executor/accessibility/macos-ax.ts` — `runJxa()` (line 113) — the JXA bridge

### Suggested Fix Direction

Add a fallback chain in `typeText()`:
1. Try `System Events.keystroke()` (current method)
2. If fails → try `pbcopy` + CoreGraphics `Cmd+V` paste
3. If fails → try AppleScript via `osascript -e` instead of JXA

For `typeKeyCombo()`:
1. Try System Events key combo (current method)
2. If fails → try CoreGraphics key events directly

---

## Bug 2: Intelligence Layer Not Learning Between Runs

### Symptom

Running the exact same prompt twice produces identical results. The second run takes the same ~10 minutes, makes the same mistakes, and doesn't reuse any learned approaches from the first run.

### Root Cause: `learnedCommands` Array Is Always Empty

The learning infrastructure EXISTS in code but doesn't actually persist anything:

**`local-agent/src/skills/registry.json`** (line 235-236):
```json
{
  "skills": [...],
  "discovered": [],
  "learnedCommands": []  // ALWAYS EMPTY
}
```

### Why Actions Aren't Being Learned

The `captureLearnedAction()` function in `agent-loop.ts` (lines 95-191) only captures THREE types of actions:

1. **shell/exec** — only if `isAppSpecificCommand()` returns true AND `result.data?.exitCode === 0`
2. **CDP actions** (click, type, select, navigate) — only for browser interactions
3. **Accessibility actions** (press_button, set_value, menu_click) — only for AX-based actions

**What's NOT captured:**
- `vision/click_coordinates` — NOT captured (the most common successful action!)
- `vision/type_text` — NOT captured
- `vision/key_combo` — NOT captured
- `shell/launch_app` — NOT captured (not shell/exec)
- `shell/switch_app` — NOT captured (not shell/exec)

Since the email task primarily uses vision actions (click_coordinates, type_text) and shell/launch_app, **NOTHING gets learned**. The `captureLearnedAction()` function on line 95 simply returns without saving for all these action types.

### The Deeper Problem: No Workflow Replay

Even if individual actions were captured, there's no mechanism to:
1. Detect "I've done this exact task before"
2. Replay a sequence of actions that previously worked
3. Skip task decomposition and go straight to learned steps

The `decomposeTask()` in `task-decomposer.ts` always starts fresh — it calls Claude Sonnet to break the goal into sub-goals every time. It doesn't check for previously successful decompositions.

### What IS Implemented vs What's Missing

| Component | Status | Location |
|-----------|--------|----------|
| `captureLearnedAction()` | Partial — only shell/CDP/AX | `agent-loop.ts:95-191` |
| `saveLearnedAction()` | Working — persists to disk | `registry.ts:361-378` |
| `getLearnedActionsForApp()` | Working — queries by app | `registry.ts:384-388` |
| `buildLearnedActionsPromptSection()` | Working — formats for prompt | `registry.ts:472-521` |
| Injected on stuck detection | Working — triggers at threshold | `agent-loop.ts:686-697` |
| Injected on failure recovery | Working — triggers at threshold | `agent-loop.ts:591-601` |
| **Capture vision/* actions** | **MISSING** | N/A |
| **Capture shell/launch_app** | **MISSING** | N/A |
| **Workflow replay/reuse** | **MISSING** | N/A |
| **Cross-agent sync (network learning)** | **MISSING** | N/A |
| **"Same task" detection** | **MISSING** | N/A |
| **Task decomposition caching** | **MISSING** | N/A |

### Files to Fix

- `local-agent/src/agent/agent-loop.ts` — `captureLearnedAction()` (line 95) — add vision and shell/launch_app capture
- `local-agent/src/agent/task-decomposer.ts` — add caching/reuse of previous decompositions
- `local-agent/src/skills/registry.ts` — possibly extend `LearnedAction` type for vision actions
- `shared/types.ts` — add network learning message types (if pursuing cross-agent sync)

### Suggested Fix Direction (Incremental)

**Phase 1 — Capture vision actions:**
Add capture for `vision/click_coordinates`, `vision/type_text`, `vision/key_combo` in `captureLearnedAction()`. Store coordinates, text, key combo, and the frontmost app + window title.

**Phase 2 — Capture shell/launch_app:**
Add capture for `shell/launch_app` and `shell/switch_app`.

**Phase 3 — Proactive injection:**
Instead of only injecting learned actions when stuck (threshold 3+), inject them proactively at sub-goal start when the same app is detected. Currently learned actions are only shown during stuck detection (`agent-loop.ts:686-697`) and failure recovery (`agent-loop.ts:591-601`).

**Phase 4 — Task decomposition caching:**
Store successful task decompositions. On new task, compare goal similarity. If highly similar, reuse the cached sub-goals instead of calling Claude again.

---

## Bug 3: Slow Execution Time (~10 minutes per task)

### Symptom

A 6-step email task takes ~575s (9.6 min). Each iteration averages 14.7s.

### Time Breakdown Per Iteration

| Phase | Time | Details |
|-------|------|---------|
| Screenshot capture | ~5-6s | `vision/screenshot` command sent to local agent, captures screen, resizes to 1280px, base64 encodes, sends back |
| Metadata collection | ~1-2s | `vision/collect_context` with `metadataOnly: true` — gets frontmost app, window title, menu bar |
| AX snapshot (optional) | ~3-5s | `accessibility/snapshot` — gets interactive elements (often fails, wasting time) |
| Claude API call | ~4-8s | Send screenshot (image) + text observation → Claude Sonnet returns JSON action |
| Action execution | ~1-3s | Send command to local agent, execute, return result |
| Settle delay | 0.4s | `settleDelayMs` default in `agent-loop.ts` line 774 |
| **Total per iteration** | **~15-20s** | |

### Why 25 Steps Aren't Enough

With 25 steps at ~15s each = 375s minimum. But many steps are wasted on:
- Failed `vision/type_text` attempts (3-5 wasted steps per text field)
- Retrying the same approach instead of switching strategies
- Agent not trusting its observations (clicking "New Email" twice)

### Time Multipliers

1. **No observation caching**: Screenshot is re-captured on every iteration, even if the screen hasn't changed
2. **Accessibility snapshot fails but still costs time**: 3-5s wasted on AX snapshot that returns error
3. **Full observation on every step**: Both screenshot AND collect_context are collected, even for simple follow-up actions
4. **LLM receives full conversation history**: Pruning helps (`RECENT_TURNS_TO_KEEP = 10` in `llm-client.ts:55`) but each API call still sends 10 turns of images
5. **JXA process overhead**: Each JXA action spawns a new `osascript` subprocess (write temp file → execute → read output → delete temp file)

### Files to Investigate

- `local-agent/src/agent/observer.ts` — observation pipeline (lines 88-267)
- `local-agent/src/agent/llm-client.ts` — API call + pruning (lines 199-273)
- `local-agent/src/executor/vision/vision-actions.ts` — screenshot capture chain
- `server/src/bridge.ts` — `AGENT_COMMAND_TIMEOUT` (default 60s, line 963)

### Suggested Fix Direction

1. **Skip AX snapshot when it's known to fail** — if AX failed for this app in previous steps, don't retry
2. **Skip screenshot when screen didn't change** — after a failed action, the screen is unchanged; reuse the last observation
3. **Increase step budget** — 25 is too low for multi-step tasks with unreliable typing; consider 40-50
4. **Parallel observation** — screenshot and collect_context could be issued in parallel (currently sequential)
5. **Faster model for simple decisions** — use Haiku for "just press Tab" type decisions, Sonnet for complex reasoning

---

## Bug 4: Agent Claims Success Despite All Actions Failing

### Symptom (from earlier testing session without permissions)

The agent marked 6 of 7 sub-goals as "Completed" even though every single action returned "Failed". It claimed to have opened Outlook, typed the email, and sent it — but nothing actually happened on the machine.

### Root Cause

In `agent-loop.ts` lines 522-526, goal completion is based solely on Claude's self-assessment:

```typescript
if (parsed.type === 'complete') {
  callbacks.onComplete?.(parsed.summary, step);
  return { outcome: 'complete', summary: parsed.summary, stepsUsed: subGoalSteps };
}
```

There is **no validation** that:
- At least one action succeeded in this sub-goal
- The screen state actually changed
- The goal was actually achieved

When screenshots fail (no Screen Recording permission) and AX fails (no Accessibility permission), Claude can't see the screen. It hallucinates success based on intent: "I pressed Cmd+N to create a new email" → "The email compose window should be open" → reports "complete".

### Why This Is Dangerous

Users see "Completed" in the dashboard and believe the task was done. In the email test case, the agent claimed to have sent an email that was never sent. This could cause real business harm.

### Files to Fix

- `local-agent/src/agent/agent-loop.ts` — `runSubGoalLoop()` (line 522-526) — add success validation before accepting "complete"

### Suggested Fix Direction

Before accepting a "complete" status from Claude, check:
1. Was at least one action in this sub-goal successful?
2. Did the observation change between the start and end of this sub-goal?
3. If all actions failed, override Claude's assessment with "stuck" or "error"

---

## Bug 5: Outlook Skill Not Being Used

### Symptom

The Outlook skill exists in `registry.json` with a `send-email` command that could handle the entire email task in ONE shell command. But the agent uses vision/UI automation instead, clicking through Outlook's interface manually.

### Root Cause

The skill IS registered and the system prompt DOES include it (via `buildSkillPromptSection()` in `prompt-builder.ts` line 34). The prompt says:

> "Apps with a registered skill → ALWAYS use the skill (Layer 1)"

But the agent loop doesn't enforce this. Claude sees the skill in the prompt but still chooses vision/UI automation because:

1. The task decomposer (`task-decomposer.ts`) doesn't know about skills — it decomposes "send email" into UI-level sub-goals (Open Outlook, Compose, Fill, Send)
2. Once decomposed into UI-level sub-goals, Claude follows the sub-goal instructions literally
3. There's no pre-check: "Does a skill exist that can handle this entire goal in one command?"

### The Outlook Skill

`local-agent/src/skills/outlook-skill.ts` (307 lines) provides:

```
send-email --to <email> --subject <subject> --body <body>
read-inbox
search-emails --query <term>
list-folders
```

The `send-email` command uses AppleScript (not JXA) to create and send emails through Outlook. It's faster, more reliable, and avoids all the JXA/vision issues.

**If the agent used the skill, the entire task would be:**
```
shell/exec → node outlook-skill.js send-email --to "Tim.buhrow@gmx.de" --subject "Wishing You a Nice Day!" --body "Hi Tim, I hope this message finds you well..."
```
One command. ~3 seconds. Done.

### Files to Fix

- `local-agent/src/agent/task-decomposer.ts` — should check registry for applicable skills before decomposing
- `local-agent/src/agent/agent-loop.ts` — could pre-check skills before starting the loop
- `local-agent/src/agent/prompt-builder.ts` — skill injection is already there but not enforced

### Suggested Fix Direction

**Option A — Skill-aware decomposition:**
Before calling `decomposeTask()`, check `registry.json` for skills matching the target app. If a skill exists that can handle the goal directly (e.g., `send-email`), skip decomposition entirely and execute the skill command.

**Option B — Skill enforcement in agent loop:**
After the first observation identifies the frontmost app, check for a matching skill. If found, inject a strong system message: "USE THE SKILL. Do NOT use vision/UI automation."

**Option C — Both:**
Pre-check in decomposer + enforcement in loop.

---

## Key File Reference

### Core Agent Loop (runs on Bridge, loaded from local-agent/dist)

| File | Lines | Purpose |
|------|-------|---------|
| `local-agent/src/agent/agent-loop.ts` | 987 | Core observe-decide-act loop, sub-goal iteration, stuck detection, learned action capture |
| `local-agent/src/agent/observer.ts` | 267 | Gathers screenshot + metadata + element data each step |
| `local-agent/src/agent/prompt-builder.ts` | 221 | System prompt (available actions, rules, skill sections) + observation formatter |
| `local-agent/src/agent/task-decomposer.ts` | 135 | Breaks goals into sub-goals via Claude Sonnet |
| `local-agent/src/agent/response-parser.ts` | 154 | Parses Claude's JSON response into action/complete/needs_help |
| `local-agent/src/agent/llm-client.ts` | 301 | Anthropic API wrapper, conversation pruning, retry logic |

### Executor Layer (runs on Local Agent / Electron)

| File | Lines | Purpose |
|------|-------|---------|
| `local-agent/src/executor/vision/vision-actions.ts` | 435 | Click, type, key combo, scroll, drag via JXA/CoreGraphics |
| `local-agent/src/executor/accessibility/macos-ax.ts` | 718 | JXA bridge, accessibility tree, element interaction |
| `local-agent/src/executor/shell/shell-executor.ts` | ~100 | Shell command execution via child_process |
| `local-agent/src/executor/shell/app-launcher.ts` | ~120 | App launch/switch/close via `open` and AppleScript |

### Skills & Learning

| File | Lines | Purpose |
|------|-------|---------|
| `local-agent/src/skills/registry.ts` | 525 | Skill/discovery/learned action storage and prompt generation |
| `local-agent/src/skills/registry.json` | 236 | Persisted skills (Excel, Word, Outlook, Spotify), discoveries, learned actions |
| `local-agent/src/skills/outlook-skill.ts` | 307 | Outlook email skill (send, read, search, list) via AppleScript |

### Bridge Server

| File | Lines | Purpose |
|------|-------|---------|
| `server/src/bridge.ts` | ~1100 | WebSocket server, intent classification, agent loop orchestration, progress reporting |

### Configuration

| File | Purpose |
|------|---------|
| `fly.toml` | Fly.io deployment config — env vars (DATA_DIR, NODE_ENV, PORT) |
| `local-agent/package.json` | Electron-builder config, app ID (`com.wfa.agent`), product name |
| `local-agent/src/build-config.ts` | Build-time constants (BRIDGE_URL, ANTHROPIC_KEY) |

---

## Code Deep Dive

### How captureLearnedAction() Works (and Doesn't)

```typescript
// agent-loop.ts lines 95-191
function captureLearnedAction(parsed, observation, result) {
  const cmd = parsed.command;

  // ONLY captures shell/exec with app-specific commands (osascript)
  if (cmd.layer === 'shell' && cmd.action === 'exec') { ... }

  // ONLY captures CDP actions (click, type, select, navigate)
  if (cmd.layer === 'cdp' && ['click', 'type', 'select', 'navigate'].includes(cmd.action)) { ... }

  // ONLY captures accessibility actions (press_button, set_value, menu_click)
  if (cmd.layer === 'accessibility' && ['press_button', 'set_value', 'menu_click'].includes(cmd.action)) { ... }

  // MISSING: vision/click_coordinates, vision/type_text, vision/key_combo
  // MISSING: shell/launch_app, shell/switch_app, shell/close_app
  // These return without saving anything
}
```

### How the Observer Collects Data

```typescript
// observer.ts — 3-step process, all sequential
// Step 1: Screenshot (~5-6s)
await sendAndWait({ layer: 'vision', action: 'screenshot', params: {} });

// Step 2: Window metadata (~1-2s)
await sendAndWait({ layer: 'vision', action: 'collect_context', params: { metadataOnly: true } });

// Step 3: Element data (~3-5s, often fails)
if (isBrowserActive) {
  await sendAndWait({ layer: 'cdp', action: 'snapshot' });
} else {
  await sendAndWait({ layer: 'accessibility', action: 'snapshot' });  // Often fails for Outlook
}
```

### How typeText Works vs clickAt

```typescript
// typeText — UNRELIABLE
// Uses Application('System Events').keystroke() — high-level AppleScript bridge
const script = `Application('System Events').keystroke("${escaped}");`;
await runJxa(script);  // Writes to /tmp, spawns osascript subprocess, waits for result

// clickAt — RELIABLE
// Uses CoreGraphics — low-level C API
const script = `
  ObjC.import('CoreGraphics');
  var pt = $.CGPointMake(${scaledX}, ${scaledY});
  var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  // ...
`;
await runJxa(script);
```

### How the LLM Client Prunes Conversation

```typescript
// llm-client.ts lines 77-112
// Keeps last 10 messages (5 user+assistant pairs) with full images
// Older messages: images replaced with "[Screenshot removed]",
// text compressed to "[Step 5: Microsoft Outlook — 'Inbox', no elements]"
// This prevents token usage from growing unbounded
const RECENT_TURNS_TO_KEEP = 10;
```

### How Stuck Detection Works

```typescript
// agent-loop.ts lines 228-258
// Two checks:
// (C) Same action repeated — identical layer+action+keyParam 3+ times
// (B) Same screen state — app + windowTitle unchanged for 3+ interactive actions

// When stuck detected (threshold 3):
//   → Inject learned actions hint into conversation
// When stuck detected (threshold 5):
//   → Trigger app discovery + skill generation
//   → OR bail out of sub-goal
```

### How Task Decomposition Works

```typescript
// task-decomposer.ts
// Uses Claude Sonnet with a fixed prompt to break goals into 3-8 sub-goals
// Each sub-goal: { label, description, app }
// NO caching — always calls Claude API
// NO skill awareness — decomposes into UI-level steps even when skill exists
// Budget: each sub-goal shares the global 25-step limit
```

### Default Configuration Values

```typescript
// agent-loop.ts
maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS || '25', 10);
settleDelayMs = 400;  // delay between action and next observation
GLOBAL_ITERATION_CEILING = 100;  // absolute max
SUB_GOAL_NUDGE_THRESHOLD = 10;  // remind agent after 10 steps on one sub-goal

// llm-client.ts
DEFAULT_MODEL = 'claude-sonnet-4-6';
DEFAULT_MAX_TOKENS = 4096;
MAX_RETRIES = 3;
RETRY_DELAYS_SEC = [5, 10, 20];
RECENT_TURNS_TO_KEEP = 10;

// macos-ax.ts
JXA_TIMEOUT_MS = 4_000;

// observer.ts
MIN_SCREENSHOT_BYTES = 1000;

// registry.ts
MAX_ACTIONS_PER_APP = 50;

// agent-loop.ts stuck detection
MAX_ACTION_HISTORY = 10;
STUCK_THRESHOLD = 3;
UNRELIABLE_THRESHOLD = 5;
MAX_CONSECUTIVE_ERRORS = 3;
DISCOVERY_THRESHOLD = 3;
```

---

## Previously Fixed Issues

### Setup Window Not Appearing (FIXED — commit ef0b35a)

**Root cause:** Circular CommonJS dependency between `main.ts` and `setup-window.ts`. Static import in setup-window.ts (`import { startConnection } from '../main'`) created a circular require cycle that silently failed.

**Fix:** Removed the import, pass `startConnection` as a callback parameter to `showSetupWindow()`. Added try/catch with `dialog.showErrorBox()`.

### Bridge Agent Modules Unavailable (FIXED — commit 4c1f4e3)

**Root cause:** `fly.toml` had `AGENT_MODULES_PATH = '/nonexistent'` overriding the Dockerfile's correct default path.

**Fix:** Removed the env var from `fly.toml`. Added diagnostic logging to `loadAgentModules()`.

### Config File Mystery (RESOLVED)

The config file at `~/Library/Application Support/@workflow-agent/local-agent/config.json` was created during early development when the agent was run from terminal. The setup window never appeared in DMG builds because:
1. First: circular dependency bug prevented it
2. After fix: config already existed, so the window was skipped

**Fix:** Deleted the config file, confirmed setup window now appears in DMG builds.

---

## Deploy Pipeline

**CRITICAL:** Never test locally. Always deploy fully:

```bash
# 1. Deploy bridge server
cd /Users/timbuhrow/Desktop/WF-Agent-V.0.2.-
fly deploy

# 2. Push dashboard (auto-deploys on Vercel)
git push origin main

# 3. Rebuild DMG
cd local-agent
WFA_BRIDGE_URL=wss://wfa-bridge.fly.dev npm run dist

# 4. Install: open local-agent/release/WFA Agent-0.1.0.dmg → drag to /Applications
# 5. If needed, delete config to force setup window:
#    rm ~/Library/Application\ Support/@workflow-agent/local-agent/config.json
```

### Environment Variables on Fly.io

```toml
# fly.toml [env]
DATA_DIR = '/data'
NODE_ENV = 'production'
PORT = '8765'
# ANTHROPIC_API_KEY is set via fly secrets
# AGENT_MAX_ITERATIONS defaults to 25 in code
# AGENT_COMMAND_TIMEOUT defaults to 60000ms in code
```
