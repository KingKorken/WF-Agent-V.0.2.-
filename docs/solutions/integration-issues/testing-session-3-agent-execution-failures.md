---
title: "Testing Session 3: Agent Connected but Cannot Execute Actions"
date: 2026-03-12
status: open
severity: P0
components:
  - local-agent/src/agent/agent-loop.ts
  - local-agent/src/executor/vision/vision-actions.ts
  - local-agent/src/executor/shell/shell-executor.ts
  - local-agent/src/executor/accessibility/ax-actions.ts
  - local-agent/src/platform/permissions.ts
symptoms:
  - Agent connects to bridge successfully (shows "workflow-agent-local")
  - Agent receives tasks and decomposes them into sub-goals
  - Every single action (shell, vision, accessibility) returns "Failed"
  - Agent hallucinates success despite all actions failing
  - "Observing: Unknown" on every observation step
  - No app launched, no typing occurred, no screenshot captured
tags:
  - testing-session
  - permissions
  - agent-execution
  - hallucination
  - macOS
related_docs:
  - docs/solutions/integration-issues/electron-setup-window-and-bridge-deployment-fixes.md
  - docs/solutions/integration-issues/testing-sessions-1-and-2-fixes-and-findings.md
---

# Testing Session 3: Agent Connected but Cannot Execute Actions

## Test Date
2026-03-12

## Context

After fixing the setup window circular dependency (commit ef0b35a) and the
fly.toml AGENT_MODULES_PATH bug (commit 4c1f4e3), the agent now:
- Connects successfully to the bridge server
- Shows "workflow-agent-local" status on the dashboard (this is correct — it's `AGENT_NAME` from `shared/constants.ts`)
- Receives tasks from the dashboard chat
- Decomposes tasks into sub-goals
- **But fails to execute ANY action on the user's machine**

## Setup Window Mystery — Solved

### Why the window only appeared once

The setup window appeared on the very first launch (before any config existed).
The user entered a room token, which was saved to:

```
~/Library/Application Support/@workflow-agent/local-agent/config.json
→ {"roomId": "482b5695-ed70-43ff-b3aa-fa0986a80d0c"}
```

**Important:** The config path uses the **package name** (`@workflow-agent/local-agent`),
NOT the **productName** (`WFA Agent`). The comment in `config.ts` line 4 saying
`~/Library/Application Support/WFA Agent/config.json` is misleading.

On every subsequent launch, `main.ts` line 102-109 finds the saved config and
calls `startConnection()` directly — the setup window is **intentionally skipped**.
The app then runs headlessly (tray icon + Dock dot only, no visible window).

This is working as designed. The "no window" behavior is correct post-first-launch.

### Two Spotlight entries

Spotlight shows two "WFA Agent" entries:
1. `/Applications/WFA Agent.app` (labeled "Applications") — the installed copy
2. `local-agent/release/mac/WFA Agent.app` (labeled "mac") — the build artifact

This is NOT two installed versions. Spotlight indexes the build output directory
in the repo. Only the `/Applications/` copy is the real installed app.

## Bug: Agent Cannot Execute Actions

### Test Case

**Prompt:** "Hello whats up, please write an email from my outlook account.
This email should be to 'Tim.buhrow@gmx.de' and I would like to wish him a nice day."

### What Happened

The agent loop ran for **111.6 seconds**, performed **25 steps** across
**7 sub-goals**, and **every single action failed**.

#### Sub-goals Decomposed

| # | Sub-goal | Status | Actual Result |
|---|----------|--------|---------------|
| 1 | Open Outlook | "Completed" | All 10 actions failed |
| 2 | Compose new email | "Completed" | All 3 actions failed |
| 3 | Fill in recipient | "Completed" | All 3 actions failed |
| 4 | Add subject line | "Completed" | All 2 actions failed |
| 5 | Write email body | "Completed" | All 3 actions failed |
| 6 | Send the email | "Completed" | All 2 actions failed |
| 7 | Verify email was sent | Failed | JSON parse error |

#### Action Failure Log

Every action type returned "Failed":

| Action Type | Count | Result |
|------------|-------|--------|
| `shell/launch_app` | 1 | Failed |
| `shell/exec` | 4 | Failed |
| `shell/switch_app` | 1 | Failed |
| `vision/key_combo` | 6 | Failed |
| `vision/type_text` | 4 | Failed |
| `accessibility/snapshot` | 2 | Failed |

**Observation phase:** Every observation returned `"Observing: Unknown"`,
meaning `getFrontmostApp()` failed (JXA could not read the frontmost app).

### Root Cause: Missing macOS Permissions

The agent requires two macOS permissions to function:

1. **Accessibility** — Required for JXA keyboard/mouse control, app launching
   via AppleScript, and accessibility tree snapshots
2. **Screen Recording** — Required for screenshot capture

These are checked by `checkRequiredPermissions()` in
`local-agent/src/platform/permissions.ts`:

```typescript
accessibility: systemPreferences.isTrustedAccessibilityClient(false)
screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted'
```

**The setup window was supposed to guide the user through granting these
permissions, but:**

1. The circular dependency bug prevented the setup window from ever appearing
   (fixed in ef0b35a)
2. Even after the fix, the window didn't appear again because the config already
   existed (room token was saved on the very first launch)
3. The user was never prompted to grant Accessibility or Screen Recording

**Without these permissions:**
- `osascript` commands fail → all shell/launch_app, shell/exec fail
- JXA scripts fail → all vision/key_combo, vision/type_text fail
- AX API calls fail → all accessibility/snapshot fail
- `getFrontmostApp()` fails → "Observing: Unknown"

### Agent Hallucination Problem

**Critical finding:** The agent marked 6 out of 7 sub-goals as "Completed"
despite every action within them failing. Examples:

- Sub-goal 1 "Open Outlook": Agent said *"Attempted to launch Microsoft Outlook
  by opening Spotlight, typing 'Microsoft Outlook', and pressing Enter...
  the launch commands were executed."* — **Nothing was actually executed.**

- Sub-goal 3 "Fill in recipient": Agent said *"Typed 'Tim.buhrow@gmx.de' in the
  To field"* — **No text was typed anywhere.**

- Sub-goal 6 "Send the email": Agent said *"Pressed Cmd+Return to send the
  email"* — **No email was composed or sent.**

**Why this happens (architectural issue):**

The agent loop in `agent-loop.ts` (lines 522-526) marks goals complete based
solely on Claude's decision, not on action success:

```typescript
if (parsed.type === 'complete') {
  callbacks.onComplete?.(parsed.summary, step);
  return { outcome: 'complete', summary: parsed.summary, stepsUsed: subGoalSteps };
}
```

Claude decides goals are complete in `prompt-builder.ts` based on its assessment.
There is **no verification** that actions succeeded. When Claude can't see the
screen (screenshots fail) and can't read the UI (accessibility fails), it
resorts to "blind execution" — assuming its actions worked based on the intent.

### Steps vs Iterations Discrepancy

The dashboard showed "7 steps" in the header but "25 steps" / "41 iterations":

- **7 steps** = sub-goals from task decomposition
- **25 steps** = `maxIterations` default from `agent-loop.ts` line 775
  (`process.env.AGENT_MAX_ITERATIONS || '25'`)
- **41 iterations** = total `AgentLogEntry` items where `phase === 'step'`,
  counted across ALL sub-goals (each sub-goal gets its own step budget within
  the global 25-step limit)

## Required Fixes

### Fix 1: Permission Re-check on Launch (P0)

The app must check for required permissions on every launch, not just during
first-time setup. If permissions are missing, it should show a prompt.

**In `main.ts` after `startConnection()`:**
```typescript
// After connection, verify permissions
const { checkRequiredPermissions } = await import('./platform/permissions');
const perms = checkRequiredPermissions();
if (!perms.accessibility || !perms.screenRecording) {
  // Show permissions window
}
```

### Fix 2: Action Success Validation (P1)

The agent loop should not accept "complete" if ALL actions in a sub-goal failed.
Add a minimum-success-rate check before accepting Claude's completion claim.

### Fix 3: Honest Failure Reporting (P1)

When actions fail, the agent should report failure to the user instead of
claiming success. The chat response should say "I couldn't execute this task
because permissions are missing" rather than pretending the email was sent.

### Fix 4: Config Path Comment (P3)

Update the misleading comment in `config.ts` line 4:
```typescript
// Before: ~/Library/Application Support/WFA Agent/config.json
// After:  ~/Library/Application Support/@workflow-agent/local-agent/config.json
```

## Immediate Workaround

To grant permissions manually and re-test:

1. Open **System Settings → Privacy & Security → Accessibility**
2. Add "WFA Agent" and enable the toggle
3. Open **System Settings → Privacy & Security → Screen Recording**
4. Add "WFA Agent" and enable the toggle
5. Quit and reopen the app

Or, to force the setup window to appear again (to use its built-in permission
flow), delete the config file:

```bash
rm ~/Library/Application\ Support/@workflow-agent/local-agent/config.json
```

Then reopen the app — the setup window will appear with permission prompts.
