---
title: "fix: Setup Window Not Appearing + Bridge Agent Modules Unavailable"
type: fix
status: active
date: 2026-03-11
---

# fix: Setup Window Not Appearing + Bridge Agent Modules Unavailable

## Overview

Two bugs preventing end-to-end usage of the WF Agent after DMG installation:

1. **Setup window invisible** — The Electron app opens (tray icon appears) but no window appears for entering a room token or enabling system access permissions.
2. **"Agent loop modules are not available"** — The bridge server on Fly.io cannot execute tasks because `loadAgentModules()` fails at startup. Already partially fixed (removed `AGENT_MODULES_PATH=/nonexistent` from `fly.toml`) but needs verification.

## Problem Statement

### Bug 1: Setup Window Not Appearing

The user installs the DMG, opens the app, and sees only the tray icon. No setup window appears. This blocks all first-time setup (room token entry + macOS permission grants).

**Root cause analysis:**

The setup window has been patched three times, each fix addressing a different theory. The window still doesn't appear. After thorough investigation:

1. **Config check is correct** — `loadConfig()` returns `null` when no `config.json` exists (verified: `~/Library/Application Support/WFA Agent/config.json` does not exist on the test machine). So `showSetupWindow()` IS being called.

2. **Circular dependency between `main.ts` ↔ `setup-window.ts`** — `setup-window.ts` line 16 has `import { startConnection } from '../main'` (static import), while `main.ts` line 112 has `await import('./ui/setup-window')` (dynamic import). In CommonJS, this creates a circular require. When `setup-window.js` is loaded, it `require('../main')` which returns `main.js`'s partially-initialized exports. `startConnection` is a function declaration so it IS hoisted, but other exports or side effects might not be ready.

3. **`show: false` + `ready-to-show` relies on successful `loadFile()`** — If the HTML fails to load (e.g., due to path resolution issues in asar), `ready-to-show` never fires and the window stays invisible. The 3-second force-show safety net should catch this, but only if the BrowserWindow itself was created successfully.

4. **The real likely cause: the dynamic `import()` on line 112 of `main.ts` throws silently.** The `app.whenReady().then(async () => { ... })` handler has NO try/catch around the dynamic import or `showSetupWindow()` call. If either throws, the rejection is caught by the global `unhandledRejection` handler which logs to stderr but doesn't surface to the user. The window simply never gets created.

### Bug 2: Bridge Agent Modules Unavailable

**Root cause:** `fly.toml` had `AGENT_MODULES_PATH = '/nonexistent'` on line 16, which overrode the Dockerfile's working default path at Fly.io runtime. This was already fixed and redeployed, but needs verification that the deployment took effect.

**How `loadAgentModules()` works** (`bridge.ts:116-130`):
- Default path: `path.join(__dirname, '../../local-agent/dist')` → `/app/local-agent/dist` in Docker
- Dockerfile line 57 copies compiled output to `/app/local-agent/dist` ✅
- Loads `runAgentLoop` via `require(path.join(basePath, 'src/agent/agent-loop'))`

## Proposed Solution

### Bug 1 Fix: Three-Part Resilience

#### Fix 1A: Break the circular dependency

Move `startConnection` out of `main.ts` into a new shared module, or change `setup-window.ts` to accept `startConnection` as a parameter instead of importing it.

**Recommended approach:** Change `setup-window.ts` to NOT import from `main.ts`. Instead, pass `startConnection` as a callback when calling `showSetupWindow()`.

**File:** `local-agent/src/main.ts`
```
// Change from:
showSetupWindow()

// To:
showSetupWindow(startConnection)
```

**File:** `local-agent/src/ui/setup-window.ts`
```
// Change from:
import { startConnection } from '../main';
export function showSetupWindow(): void { ... }

// To:
// Remove the import from main
export function showSetupWindow(onConnect: (roomId: string) => void): void { ... }
// Use onConnect instead of startConnection in the done handler
```

This eliminates the circular dependency entirely.

#### Fix 1B: Wrap the setup window call in try/catch

**File:** `local-agent/src/main.ts` (lines 110-113)

```typescript
// Current (no error handling):
const { showSetupWindow } = await import('./ui/setup-window');
showSetupWindow();

// Fixed:
try {
  const { showSetupWindow } = await import('./ui/setup-window');
  showSetupWindow(startConnection);
} catch (err) {
  log(`[main] CRITICAL: Failed to show setup window: ${err}`);
  // Fallback: show a dialog telling the user what happened
  const { dialog } = await import('electron');
  dialog.showErrorBox('Setup Error', `Failed to open setup window: ${err instanceof Error ? err.message : String(err)}`);
}
```

#### Fix 1C: Keep the safety net timeout (already implemented)

The 3-second force-show timeout stays as a secondary safety mechanism in case `ready-to-show` doesn't fire for other reasons.

### Bug 2 Fix: Verify Deployment

The `fly.toml` fix (removing `AGENT_MODULES_PATH=/nonexistent`) has already been applied and deployed. Verification steps:

1. Check Fly.io logs for "Agent loop modules loaded successfully" message
2. Test sending a task from the dashboard
3. If still failing, redeploy with `fly deploy --no-cache` to force a fresh build

### Bug 2 Safety: Add startup health log

**File:** `server/src/bridge.ts` (after `loadAgentModules()` call)

Add a clear log message at startup:
```typescript
const loaded = await loadAgentModules();
if (!loaded) {
  log('CRITICAL: Agent loop modules failed to load. Task execution will be unavailable.');
  log(`AGENT_MODULES_PATH=${process.env.AGENT_MODULES_PATH || '(default)'}`);
  log(`Resolved path: ${path.join(__dirname, '../../local-agent/dist')}`);
}
```

## Acceptance Criteria

- [ ] **AC-1:** On first launch (no saved config), the setup window appears within 3 seconds
- [ ] **AC-2:** If the setup window fails to load, an error dialog is shown to the user
- [ ] **AC-3:** No circular dependency between `main.ts` and `setup-window.ts`
- [ ] **AC-4:** `setup-window.ts` does not import from `main.ts`
- [ ] **AC-5:** Bridge server logs "Agent loop modules loaded successfully" on startup
- [ ] **AC-6:** Dashboard task execution works end-to-end (no "modules not available" error)
- [ ] **AC-7:** Setup window works in both dev mode (`npm run dev`) and packaged DMG
- [ ] **AC-8:** Room token entry + validation + permissions check + done flow all work

## Files Modified

| File | Change |
|------|--------|
| `local-agent/src/ui/setup-window.ts` | Remove `import { startConnection } from '../main'`, accept callback parameter |
| `local-agent/src/main.ts` | Try/catch around setup window import, pass `startConnection` as callback |
| `server/src/bridge.ts` | Add diagnostic logging on module load failure |
| `fly.toml` | Already fixed (removed `AGENT_MODULES_PATH=/nonexistent`) |

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Circular dependency fix breaks other callers of `showSetupWindow()` | Low | Low | Only called from one place in `main.ts` |
| Bridge still can't load modules after fix | Low | High | `fly deploy --no-cache` to force fresh Docker build |
| Setup window works in dev but not in packaged DMG | Medium | High | Always test with `npm run dist` + install from DMG, NEVER local dev testing |
| 3-second force-show timeout shows blank window | Low | Low | Better than invisible window; user sees something |

## Testing Requirements

**CRITICAL:** All testing must be done via full deployment pipeline — no local testing.

1. `fly deploy` (bridge server)
2. `git push origin main` (Vercel dashboard auto-deploy)
3. `WFA_BRIDGE_URL=wss://wfa-bridge.fly.dev npm run dist` (DMG rebuild)
4. Install DMG from `local-agent/release/`
5. Delete `~/Library/Application Support/WFA Agent/config.json` if it exists
6. Launch app → verify setup window appears
7. Enter room token → verify connection
8. Send task from dashboard → verify execution (no "modules not available" error)

## Sources & References

- Past solution: `docs/solutions/integration-issues/testing-sessions-1-and-2-fixes-and-findings.md` — Previous setup window and permission fixes
- Past solution: `docs/solutions/performance-issues/agent-speed-and-intelligence-optimization.md` — Bridge iteration limit and agent loop changes
- Past solution: `docs/solutions/integration-issues/debug-panel-pipeline-logging-and-stuck-typing-state.md` — Pipeline logging patterns
- Key code: `bridge.ts:116-130` — `loadAgentModules()` dynamic require
- Key code: `main.ts:93-117` — Electron startup flow
- Key code: `setup-window.ts:48-170` — Setup window creation and IPC handlers
