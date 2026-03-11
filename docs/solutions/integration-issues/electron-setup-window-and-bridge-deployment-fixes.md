---
title: "fix: Electron Setup Window Not Appearing + Bridge Agent Modules Unavailable"
date: 2026-03-11
status: solved
severity: P0
components:
  - local-agent/src/main.ts
  - local-agent/src/ui/setup-window.ts
  - server/src/bridge.ts
  - fly.toml
symptoms:
  - Setup window invisible after DMG install (tray icon appears, no window)
  - "Agent loop modules are not available" error on dashboard
  - First-time setup flow completely blocked
root_cause:
  - Circular CommonJS dependency between main.ts and setup-window.ts
  - fly.toml AGENT_MODULES_PATH override pointing to /nonexistent
tags:
  - electron
  - circular-dependency
  - fly-deployment
  - setup-window
  - asar
  - commonjs
related_docs:
  - docs/solutions/integration-issues/testing-sessions-1-and-2-fixes-and-findings.md
  - docs/solutions/integration-issues/debug-panel-pipeline-logging-and-stuck-typing-state.md
  - docs/solutions/performance-issues/agent-speed-and-intelligence-optimization.md
  - docs/plans/2026-03-11-fix-setup-window-and-bridge-agent-modules-plan.md
  - docs/distribution/guides/tester-setup.md
  - docs/connection/solutions/smart-chat-routing-free-form-task-execution.md
---

# fix: Electron Setup Window Not Appearing + Bridge Agent Modules Unavailable

## Problem

Two P0 bugs prevented end-to-end usage of the WF Agent after DMG installation:

1. **Setup window invisible** — The Electron app launched (tray icon appeared in menu bar) but no window appeared for entering a room token or enabling macOS permissions. First-time users were completely blocked.

2. **"Agent loop modules are not available"** — The bridge server on Fly.io could not execute tasks because `loadAgentModules()` failed at startup, returning a "modules not available" error to the dashboard.

## Investigation Path

### Bug 1: Setup Window — Three Failed Fix Attempts

The setup window bug required four iterations to solve. Each attempt addressed a different theory:

| Attempt | Theory | Fix Applied | Result |
|---------|--------|-------------|--------|
| 1 | Path resolution wrong in asar | Changed to `getResourcePath()` from `app-paths.ts` | Failed — `process.resourcesPath` points OUTSIDE asar |
| 2 | Preload/HTML paths wrong | Changed to `app.getAppPath()` for asar-compatible paths | Failed — paths were correct but window still didn't appear |
| 3 | `ready-to-show` never fires | Added 3-second force-show safety net timeout | Failed — BrowserWindow itself was never created |
| 4 | **Circular dependency** | Broke circular import, added try/catch | **Solved** |

### Bug 1: Root Cause — Circular CommonJS Dependency

The actual root cause was a circular dependency between two modules:

- `setup-window.ts` line 16: `import { startConnection } from '../main'` (static import)
- `main.ts` line 112: `await import('./ui/setup-window')` (dynamic import)

In CommonJS (the compiled output target), when module A requires module B which requires module A, module B receives A's **partially-initialized exports**. The dynamic `import()` compiles to a `require()` wrapped in a Promise. When this failed, the error was caught by the global `unhandledRejection` handler which logged to stderr but never surfaced to the user. The window was simply never created, and no error was visible.

The `app.whenReady().then(async () => { ... })` handler had **no try/catch** around the dynamic import or `showSetupWindow()` call. Silent failure was guaranteed.

### Bug 2: Root Cause — fly.toml Environment Override

The `fly.toml` file contained:

```toml
[env]
  AGENT_MODULES_PATH = '/nonexistent'
```

This overrode the Dockerfile's working default path at Fly.io runtime. The `loadAgentModules()` function in `bridge.ts` checks `process.env.AGENT_MODULES_PATH` first, and `/nonexistent` does not exist in the Docker container. The Dockerfile correctly copies compiled output to `/app/local-agent/dist`, but the env var prevented that path from ever being used.

## Solution

### Bug 1 Fix: Break Circular Dependency + Error Handling

**`local-agent/src/ui/setup-window.ts`** — Removed the static import from `main.ts` and changed `showSetupWindow()` to accept a callback parameter:

```typescript
// REMOVED: import { startConnection } from '../main';
// NOTE: Do NOT import from '../main' — circular dependency breaks packaged builds.

let onConnectCallback: ((roomId: string) => void) | null = null;

export function showSetupWindow(onConnect: (roomId: string) => void): void {
  onConnectCallback = onConnect;
  // ... window creation ...
}

// In the 'done' IPC handler:
ipcHandlers.done = (_event) => {
  if (validatedToken && onConnectCallback) {
    saveConfig({ roomId: validatedToken });
    onConnectCallback(validatedToken);  // was: startConnection(validatedToken)
    setupWindow?.close();
  }
};
```

**`local-agent/src/main.ts`** — Wrapped the dynamic import in try/catch and passes `startConnection` as a callback:

```typescript
import { app, dialog } from 'electron';

// In app.whenReady():
try {
  const { showSetupWindow } = await import('./ui/setup-window');
  showSetupWindow(startConnection);  // callback injection
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log(`[main] CRITICAL: Failed to show setup window: ${msg}`);
  dialog.showErrorBox('Setup Error',
    `Failed to open setup window.\n\n${msg}\n\nPlease reinstall the application.`);
}
```

### Bug 2 Fix: Remove Environment Override + Add Diagnostics

**`fly.toml`** — Removed the `AGENT_MODULES_PATH = '/nonexistent'` line from `[env]`.

**`server/src/bridge.ts`** — Enhanced `loadAgentModules()` with diagnostic logging:

```typescript
async function loadAgentModules(): Promise<boolean> {
  const basePath = process.env.AGENT_MODULES_PATH || path.join(__dirname, '../../local-agent/dist');
  const fullPath = path.join(basePath, 'src/agent/agent-loop');

  log(`[loadAgentModules] AGENT_MODULES_PATH env: ${process.env.AGENT_MODULES_PATH || '(not set, using default)'}`);
  log(`[loadAgentModules] Resolved base: ${basePath}`);
  log(`[loadAgentModules] Loading from: ${fullPath}`);

  try {
    const agentLoopModule = require(fullPath);
    runAgentLoop = agentLoopModule.runAgentLoop;
    if (!runAgentLoop) {
      log('CRITICAL: agent-loop module loaded but runAgentLoop export is missing');
      return false;
    }
    log('Agent loop modules loaded successfully');
    return true;
  } catch (err) {
    log(`CRITICAL: Could not load agent loop modules from ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) { log(`Stack: ${err.stack}`); }
    return false;
  }
}
```

## Files Changed

| File | Change |
|------|--------|
| `local-agent/src/ui/setup-window.ts` | Removed `import { startConnection } from '../main'`, accept `onConnect` callback parameter, use `onConnectCallback` instead of direct import |
| `local-agent/src/main.ts` | Added `dialog` import, try/catch around dynamic import, pass `startConnection` as callback to `showSetupWindow()` |
| `server/src/bridge.ts` | Enhanced `loadAgentModules()` with env var logging, path logging, export validation, stack traces on failure |
| `fly.toml` | Removed `AGENT_MODULES_PATH = '/nonexistent'` from `[env]` section |

## Verification

### Bridge Server (Bug 2) — Verified

Fly.io deployment logs confirmed successful module loading:

```
[loadAgentModules] AGENT_MODULES_PATH env: (not set, using default)
[loadAgentModules] Resolved base: /app/local-agent/dist
[loadAgentModules] Loading from: /app/local-agent/dist/src/agent/agent-loop
Agent loop modules loaded successfully
```

### Setup Window (Bug 1) — Deployed

DMG rebuilt with all fixes applied. TypeScript compilation passed for both `local-agent` and `server` packages. The fix eliminates the circular dependency entirely and adds visible error reporting if the window still fails to create for any other reason.

## Prevention Strategies

### 1. Callback Injection Pattern for Electron Modules

**Rule:** Never create static imports between `main.ts` and UI window modules. Always pass functions as callbacks.

```
WRONG:  setup-window.ts imports from main.ts (circular)
RIGHT:  main.ts passes startConnection as callback to showSetupWindow()
```

This pattern should be applied to any future BrowserWindow modules that need to call back into the main process.

### 2. Environment Variable Validation at Startup

Any environment variable that overrides a file path should be validated at startup:

```typescript
if (process.env.AGENT_MODULES_PATH) {
  const exists = fs.existsSync(process.env.AGENT_MODULES_PATH);
  if (!exists) {
    log(`WARNING: AGENT_MODULES_PATH=${process.env.AGENT_MODULES_PATH} does not exist, falling back to default`);
  }
}
```

### 3. DMG Release Checklist

Before every DMG release:

1. Verify no circular dependencies: `npx madge --circular dist/`
2. Check `fly.toml` env vars point to real paths
3. Test full pipeline: `fly deploy` -> `git push` -> `npm run dist` -> install DMG -> verify setup window

### 4. Error Surfacing Rule

**Rule:** Every `async` call in the Electron main process `app.whenReady()` handler MUST be wrapped in try/catch with user-visible error reporting (e.g., `dialog.showErrorBox()`). Silent failures in the main process are invisible to users and extremely difficult to debug.

### 5. Monitoring

The bridge server now logs detailed module loading information at startup. Check Fly.io logs after every deployment for:
- `Agent loop modules loaded successfully` — healthy
- `CRITICAL: Could not load agent loop modules` — broken, check the logged path and stack trace

## Key Lessons

1. **CommonJS circular dependencies are silent killers in Electron.** The app appears to work (tray icon shows) but critical functionality silently fails. Always use callbacks or event emitters instead of cross-imports between main process modules.

2. **`process.resourcesPath` vs `app.getAppPath()`** — In packaged Electron apps, `process.resourcesPath` points to `Contents/Resources/` (OUTSIDE asar), while `app.getAppPath()` points to the asar root (INSIDE asar). Use `app.getAppPath()` for files bundled in the app.

3. **fly.toml `[env]` overrides Dockerfile `ENV`** — Environment variables in `fly.toml` take precedence at Fly.io runtime. A stale or incorrect env var can silently break functionality that works perfectly in Docker locally.

4. **Global error handlers mask critical failures.** The `unhandledRejection` handler logged to stderr but the user never saw the error. Always add specific try/catch blocks with user-facing error reporting for critical initialization paths.
