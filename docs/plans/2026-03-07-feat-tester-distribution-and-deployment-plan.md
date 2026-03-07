---
title: "Tester Distribution & Deployment"
type: feat
status: active
date: 2026-03-07
origin: docs/brainstorms/2026-03-07-tester-distribution-and-deployment-brainstorm.md
deepened: 2026-03-07
---

# Tester Distribution & Deployment

Get non-technical macOS testers running WFA end-to-end with their own workflows. Download a DMG, install, paste a room token, and go.

## Enhancement Summary

**Deepened on:** 2026-03-07
**Sections enhanced:** 6 phases + acceptance criteria + risk analysis
**Research agents used:** 14 (Fly.io deployment, electron-builder DMG, macOS permissions, WebSocket protocol, config embedding, TypeScript reviewer, security sentinel, performance oracle, architecture strategist, deployment verification, code simplicity, pattern recognition, spec flow analyzer, learnings researcher)
**Framework docs queried:** electron-builder, Electron, Fly.io (via Context7)

### Critical Improvements (Must Fix)

1. **Add `requestId` correlation to workflow fetch protocol** — Without it, concurrent workflow runs can't match responses to requests (TypeScript review, WebSocket research)
2. **Use proper `WorkflowDefinition` type instead of `Record<string, unknown>`** — Current type abandons type safety at the most critical boundary (TypeScript review)
3. **Centralize `app.isPackaged` path logic into `AppPaths` utility** — 6+ files repeating the same ternary is a DRY violation and a bug magnet (TypeScript review, architecture review, pattern review)
4. **Add `requestId` field to both protocol messages** — Required for reliable request-response over WebSocket (WebSocket research)
5. **Fix shell script quoting** — `cat << EOF` expands `$` variables; API keys with `$` will break. Use `cat << 'EOF'` (single-quoted delimiter) or a Node.js script instead (config embedding research, security review)
6. **Add `extendInfo` to electron-builder config** — Required for microphone permission dialog: `NSMicrophoneUsageDescription` in Info.plist (Electron docs, macOS permissions research)
7. **macOS Sequoia Gatekeeper change** — Control-click bypass removed in Sequoia. Must use System Settings > Privacy & Security > "Open Anyway" instead of right-click > Open (macOS permissions research)

### YAGNI Simplifications

8. **Consider skipping Phase 4c-2 (skills registry paths)** — Python skills are explicitly skipped for testing. Don't fix code paths that aren't used (simplicity review)
9. **Custom app icon (Phase 4e) is optional** — Use Electron's default or auto-generate with `npx electron-icon-builder --input=logo.png --output=assets` (simplicity review)

### Architectural Debt (Post-Testing)

10. **Move `formatWorkflowAsGoal` to `shared/` package** — Currently duplicated in local-agent and server. Extract to shared workspace to prevent divergence (architecture review)
11. **Bridge is a BFF, not a relay** — Document that the bridge runs Claude API calls and workflow formatting. This is architecturally sound for 5 testers but should be made explicit (architecture review)
12. **Config storage should migrate to macOS Keychain for production** — `config.json` with plaintext token is acceptable for testing, not production. Use `keytar` package later (security review)

---

**Origin brainstorm:** [docs/brainstorms/2026-03-07-tester-distribution-and-deployment-brainstorm.md](../brainstorms/2026-03-07-tester-distribution-and-deployment-brainstorm.md) -- Key decisions: unsigned DMG, API key embedded at build time, first-launch room token prompt, macOS-only, skip Python skills.

## Overview

This plan covers 6 phases to go from "works on localhost" to "testers download and use it":

1. Deploy bridge server to Fly.io
2. Configure Vercel dashboard
3. Wire structured workflow execution (fix handleWorkflowRun)
4. Package Electron app as macOS DMG (electron-builder)
5. Add first-launch setup (room token prompt + macOS permissions)
6. Create tester onboarding materials

## Problem Statement

The WFA agent works end-to-end on localhost but cannot reach non-technical testers because:
- The Electron app requires Node.js, npm, and manual builds
- Environment variables (WS_URL, ROOM_ID, ANTHROPIC_API_KEY) must be set via terminal
- The bridge server is not deployed publicly
- Workflow execution uses a vague text goal instead of the structured WorkflowDefinition
- No macOS permission guidance exists for non-technical users

## Proposed Solution

Package the Electron agent as an unsigned macOS DMG with embedded config. Deploy the bridge to Fly.io. Fix workflow execution to use structured goals. Add a first-launch setup flow for room token and macOS permissions.

---

## Implementation Phases

### Phase 1: Deploy Bridge Server to Fly.io

**Goal:** Bridge server running at `wss://wfa-bridge.fly.dev`, health check passing.

**Prerequisite:** Install `flyctl` CLI.

**Tasks:**

- [ ] Install flyctl: `brew install flyctl` or `curl -L https://fly.io/install.sh | sh`
- [ ] Authenticate: `fly auth login`
- [ ] Launch app: `fly launch --name wfa-bridge --region fra --no-deploy` (Frankfurt, don't deploy yet)
- [ ] Set secrets (NOT in fly.toml):
  ```
  fly secrets set VALID_ROOMS="<uuid1>,<uuid2>,<uuid3>,<uuid4>,<uuid5>"
  fly secrets set ANTHROPIC_API_KEY="sk-ant-..."
  ```
- [ ] Deploy: `fly deploy`
- [ ] Verify health: `curl https://wfa-bridge.fly.dev/health` returns `{"status":"ok"}`
- [ ] Verify WebSocket: connect with `wscat -c wss://wfa-bridge.fly.dev` and confirm it stays open
- [ ] Set API key usage cap in Anthropic Console (Settings > Billing > Usage Limits) -- set a monthly spend limit appropriate for testing (see brainstorm decision #7)

**Files:** No code changes. Uses existing `Dockerfile` and `fly.toml`.

**Success criteria:** Health endpoint returns 200 from `wfa-bridge.fly.dev`. WebSocket accepts connections with valid room tokens and rejects invalid ones.

#### Research Insights

**Fly.io WebSocket Best Practices:**
- `auto_stop_machines = "off"` is critical — default `"stop"` kills persistent WebSocket connections during idle periods
- Use `concurrency.type = "connections"` (not `"requests"`) for WebSocket servers in fly.toml
- TLS termination is automatic — Fly.io handles `wss://` at the edge, your app listens on plain `ws://` internally
- Frankfurt (`fra`) is optimal for German testers; single machine (`shared-cpu-1x`, 256MB) is sufficient for 5 users at ~$2-3/month
- `fly secrets set` encrypts at rest; access via `process.env.SECRET_NAME` at runtime

**Post-Deploy Smoke Test:**
```bash
# 1. Health check
curl https://wfa-bridge.fly.dev/health

# 2. WebSocket connectivity
wscat -c wss://wfa-bridge.fly.dev

# 3. Send test hello with valid room token
# > {"type":"hello","agentName":"test","version":"0.1.0","platform":"darwin","supportedLayers":[],"roomId":"<valid-uuid>"}

# 4. Monitor logs
fly logs

# 5. Check status
fly status
```

**Rollback:**
```bash
# List previous deployments
fly releases

# Roll back to previous version
fly deploy --image registry.fly.io/wfa-bridge:deployment-<VERSION>
```

**From Learnings (bridge-server-websocket-production-deployment.md):**
- Health check endpoint must be HTTP (`/health`), not WebSocket
- `maxPayload: 5MB` is already configured (screenshots are 100-500KB base64)
- Ping/pong heartbeat at 45s interval prevents stale connections
- Non-root Docker user already configured via `appuser` (uid/gid 1001)

---

### Phase 2: Configure Vercel Dashboard

**Goal:** Dashboard at Vercel connects to Fly.io bridge when opened with `?room=uuid`.

**Tasks:**

- [ ] In Vercel project settings, add environment variable: `VITE_WS_URL=wss://wfa-bridge.fly.dev`
  - Scope: Production (required), Preview (optional — same URL or staging URL), Development (`ws://localhost:8765`)
- [ ] Trigger redeploy (VITE_ prefix variables are build-time, requires rebuild)
- [ ] Verify: open `https://<vercel-url>?room=<valid-uuid>` and check browser console for WebSocket connection attempt to `wss://wfa-bridge.fly.dev`
- [ ] Verify: without `?room=`, dashboard shows "Cloud preview" state (isCloudPreview returns true)

**Files:** No code changes. Configuration only.

**Success criteria:** Dashboard connects to bridge via WSS when room token is in URL.

#### Research Insights

**Vercel + Vite Environment Variables:**
- `VITE_WS_URL` is statically replaced at build time via `import.meta.env.VITE_WS_URL` — the value is hardcoded into the JavaScript bundle after build
- Changes require a new deployment; previous deployments retain their original baked-in values
- `VITE_` prefix variables are safe for WebSocket URLs (they're meant to be public; auth happens at connection time)
- Instant rollback: Vercel Dashboard > Deployments > find previous working deployment > "Promote to Production"

**Verification:**
```bash
# After deploy, inspect the built bundle to confirm the URL is embedded
# In browser DevTools > Sources > search for "wss://wfa-bridge"
```

**From Learnings:**
- The `config/room.ts` module with `isCloudPreview()` is the correct pattern — avoids hostname sniffing
- `getRoomId()` extracts UUID from `?room=` query param with UUID v4 regex validation

---

### Phase 3: Wire Structured Workflow Execution

**Goal:** When a tester clicks "Run" on a workflow, the agent receives the full structured plan with steps, layers, applications, and variables -- not just a text string.

**Architecture decision:** The bridge server cannot access workflow JSON files (they live on the local agent's disk). Solution: the bridge requests the workflow definition from the agent before starting the loop.

**Tasks:**

#### 3a. Add protocol messages for workflow fetch

- [ ] Add `ServerRequestWorkflow` type to `shared/types.ts`:
  ```typescript
  export interface ServerRequestWorkflow {
    type: 'server_request_workflow';
    requestId: string; // UUID — required for matching responses
    workflowId: string;
  }
  ```
- [ ] Add `AgentWorkflowData` type to `shared/types.ts`:
  ```typescript
  export interface AgentWorkflowData {
    type: 'agent_workflow_data';
    requestId: string; // Echo back the requestId from the request
    workflowId: string;
    workflow: WorkflowDefinition | null; // null if not found
  }
  ```
- [ ] Import or re-export `WorkflowDefinition` and `WorkflowStep` types in `shared/types.ts` (currently defined in `local-agent/src/agent/workflow-types.ts` — move to shared so both server and local-agent can reference)
- [ ] Add both to `WebSocketMessage` union type
- [ ] Add `'server_request_workflow'` and `'agent_workflow_data'` to bridge's `KNOWN_MESSAGE_TYPES` Set

#### 3b. Handle workflow data request in local agent

- [ ] In `local-agent/src/connection/dashboard-message-handler.ts`, add handler for `server_request_workflow`:
  - Read workflow JSON from `workflows/<workflowId>.json` via `getWorkflow()`
  - Send `agent_workflow_data` response echoing back the `requestId`
  - If not found, send `agent_workflow_data` with `workflow: null`

#### 3c. Copy formatWorkflowAsGoal into server package

- [ ] Create `server/src/workflow-formatter.ts` by copying `formatWorkflowAsGoal()` from `local-agent/src/agent/workflow-executor.ts` (it has no external dependencies -- pure string formatting of a JSON object)
- [ ] Remove the dynamic `require()` of `formatWorkflowAsGoal` from `loadAgentModules()` in `bridge.ts` -- it's now a local import

#### 3d. Update bridge handleWorkflowRun with correlation-based request-response

- [ ] In `server/src/bridge.ts` `handleWorkflowRun()` (line 559):
  - Generate a `requestId` via `crypto.randomUUID()`
  - Send `server_request_workflow` with `requestId` and `workflowId` to the agent socket
  - Use a `pendingRequests: Map<string, { resolve, reject, timeoutId }>` to track the request
  - Wait for `agent_workflow_data` response matching the `requestId` (with a 10-second timeout)
  - If workflow data is received, use the local `formatWorkflowAsGoal(workflow)` to build a structured goal
  - If workflow data is null or timeout, fall back to the current text-based goal (log a warning)
  - Clean up: `clearTimeout` on response, `delete` from pendingRequests on timeout or response
  - On agent disconnect: reject all pending requests
  - Import `formatWorkflowAsGoal` from `./workflow-formatter` (always available, no dynamic require)

**Files:**
- `shared/types.ts` -- add 2 message types, move WorkflowDefinition here
- `server/src/bridge.ts` -- update handleWorkflowRun, add to KNOWN_MESSAGE_TYPES, add pendingRequests Map
- `server/src/workflow-formatter.ts` -- **new**, copy of formatWorkflowAsGoal
- `local-agent/src/connection/dashboard-message-handler.ts` -- add handler

**Success criteria:** Running a workflow from the dashboard produces a structured goal string with steps and applications, visible in bridge server logs.

#### Research Insights

**WebSocket Request-Response Pattern (Critical Fix):**
- **Always use correlation IDs** (`requestId`) to match responses to requests — without them, concurrent workflow runs silently corrupt each other
- Use a `Map<string, PendingRequest>` pattern with integrated timeout (not external `Promise.race`)
- On WebSocket close/error, reject ALL pending requests immediately to prevent hanging promises
- TCP guarantees message ordering within a single WebSocket connection — no need for additional sequencing
- 10 seconds is better than 5 for the timeout (disk I/O on slow machines, large workflow files)

**Type Safety (Critical Fix):**
- `Record<string, unknown>` abandons type safety at the network boundary — use proper `WorkflowDefinition` type
- Move `WorkflowDefinition` and `WorkflowStep` to `shared/types.ts` so both server and local-agent can reference them without duplication
- The `formatWorkflowAsGoal` function only depends on `WorkflowDefinition` and `WorkflowStep` types (no external packages) — confirmed by source verification

**From Learnings:**
- Message naming convention is consistent: `server_request_workflow` (server → agent) follows `{sender}_{action}` pattern
- Add both new types to `KNOWN_MESSAGE_TYPES` Set for the existing message validation whitelist
- Use `Object.keys(obj).includes()` not `in` operator for TypeScript safety (documented pitfall)

---

### Phase 4: Package Electron App as macOS DMG

**Goal:** A `.dmg` file that non-technical users can install by dragging to Applications.

**Tasks:**

#### 4a. Install and configure electron-builder

- [ ] Add electron-builder as devDependency: `npm install --save-dev electron-builder --workspace=@workflow-agent/local-agent`
- [ ] Add build configuration to `local-agent/package.json`:
  ```json
  "build": {
    "appId": "com.wfa.agent",
    "productName": "WFA Agent",
    "directories": {
      "output": "release",
      "buildResources": "assets"
    },
    "mac": {
      "category": "public.app-category.productivity",
      "target": [{ "target": "dmg", "arch": ["x64"] }],
      "icon": "assets/icon.icns",
      "identity": null,
      "hardenedRuntime": false,
      "gatekeeperAssess": false,
      "extendInfo": {
        "NSMicrophoneUsageDescription": "WFA Agent records your voice instructions during workflow automation.",
        "NSScreenCaptureDescription": "WFA Agent captures screen content to record and replay workflows.",
        "NSAppleEventsUsageDescription": "WFA Agent uses Apple Events to automate applications."
      }
    },
    "dmg": {
      "title": "WFA Agent",
      "contents": [
        { "x": 130, "y": 220 },
        { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
      ]
    },
    "files": [
      "dist/**/*",
      "package.json"
    ],
    "extraResources": [
      { "from": "bin/", "to": "bin/", "filter": ["**/*"] }
    ],
    "asar": true
  }
  ```
- [ ] Add build script to `local-agent/package.json`:
  ```json
  "dist": "npm run build && electron-builder --mac"
  ```

#### 4b. Centralize path resolution (new — addresses DRY violation)

- [ ] Create `local-agent/src/utils/app-paths.ts`:
  ```typescript
  import { app } from 'electron';
  import path from 'path';

  const IS_PACKAGED = app.isPackaged;
  const DEV_ROOT = path.join(__dirname, '../../..');

  export function getBinPath(binaryName: string): string {
    return IS_PACKAGED
      ? path.join(process.resourcesPath, 'bin', binaryName)
      : path.join(DEV_ROOT, 'bin', binaryName);
  }

  export function getUserDataPath(subdir: string): string {
    const dir = IS_PACKAGED
      ? path.join(app.getPath('userData'), subdir)
      : path.join(DEV_ROOT, subdir);
    require('fs').mkdirSync(dir, { recursive: true });
    return dir;
  }

  export function getResourcePath(relativePath: string): string {
    return IS_PACKAGED
      ? path.join(process.resourcesPath, relativePath)
      : path.join(DEV_ROOT, relativePath);
  }
  ```
- [ ] Update all files to use `app-paths` instead of inline ternaries

#### 4c. Fix native binary paths for packaged app (using centralized paths)

- [ ] In `local-agent/src/recorder/event-logger.ts` (~line 99), replace:
  ```typescript
  import { getBinPath } from '../utils/app-paths';
  const BINARY_PATH = getBinPath('event-monitor-darwin');
  ```
- [ ] In `local-agent/src/recorder/audio-capture.ts` (~line 16), same:
  ```typescript
  import { getBinPath } from '../utils/app-paths';
  const BINARY_PATH = getBinPath('audio-recorder-darwin');
  ```

#### 4d. Fix workflow/recording storage paths (using centralized paths)

- [ ] In `local-agent/src/workflows/workflow-manager.ts`:
  ```typescript
  import { getUserDataPath } from '../utils/app-paths';
  const WORKFLOWS_DIR = getUserDataPath('workflows');
  ```
- [ ] Same for `local-agent/src/recorder/session-manager.ts`:
  ```typescript
  import { getUserDataPath } from '../utils/app-paths';
  const RECORDINGS_DIR = getUserDataPath('recordings');
  ```

#### 4e. Fix skills registry paths for packaged app (OPTIONAL — skills not used in testing)

> **YAGNI note:** Python skills are explicitly skipped for this testing round. This task is optional. Only implement if testing reveals that the skills registry initialization blocks app startup.

- [ ] In `local-agent/src/skills/registry.ts`, update using `getResourcePath()`:
  ```typescript
  import { getResourcePath } from '../utils/app-paths';
  export const SKILLS_DIR = getResourcePath('skills');
  export const SKILLS_DIST_DIR = getResourcePath('skills-dist');
  const REGISTRY_PATH = getResourcePath(path.join('skills', 'registry.json'));
  ```
- [ ] Add skills directories to `extraResources`:
  ```json
  "extraResources": [
    { "from": "bin/", "to": "bin/", "filter": ["**/*"] },
    { "from": "src/skills/", "to": "skills/", "filter": ["*.json", "*.py"] },
    { "from": "dist/src/skills/", "to": "skills-dist/", "filter": ["*.js"] }
  ]
  ```

#### 4f. Embed config via generated constants file

`process.env` reads at runtime, not build time -- in a packaged Electron app on a tester's machine, build-time env vars don't exist. Instead, a pre-build script writes a TypeScript constants file that `tsc` compiles into the bundle.

- [ ] Create `local-agent/scripts/generate-config.sh`:
  ```bash
  #!/bin/bash
  # Generates src/build-config.ts with baked-in values before tsc runs.
  # Usage: WFA_BRIDGE_URL=wss://... WFA_ANTHROPIC_KEY=sk-ant-... ./scripts/generate-config.sh

  BRIDGE="${WFA_BRIDGE_URL:-ws://localhost:8765}"
  KEY="${WFA_ANTHROPIC_KEY:-}"

  cat > src/build-config.ts << 'ENDOFTEMPLATE'
  // AUTO-GENERATED by scripts/generate-config.sh -- do not edit
  ENDOFTEMPLATE

  # Use printf to safely handle special characters in API keys
  printf "export const BRIDGE_URL = '%s';\n" "$BRIDGE" >> src/build-config.ts
  printf "export const ANTHROPIC_KEY = '%s';\n" "$KEY" >> src/build-config.ts
  echo "Generated src/build-config.ts (bridge: ${BRIDGE})"
  ```
- [ ] Add `local-agent/src/build-config.ts` to `.gitignore` (generated file, never committed -- contains API key)
- [ ] Create a checked-in `local-agent/src/build-config.ts` default for dev:
  ```typescript
  // Default dev config -- overwritten by scripts/generate-config.sh for distribution builds
  export const BRIDGE_URL = 'ws://localhost:8765';
  export const ANTHROPIC_KEY = '';
  ```
- [ ] Update `local-agent/src/main.ts` to use build-config with env var override:
  ```typescript
  import { BRIDGE_URL, ANTHROPIC_KEY } from './build-config';
  const serverUrl = process.env.WS_URL || BRIDGE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY || ANTHROPIC_KEY;
  ```
- [ ] Update build scripts in `local-agent/package.json`:
  ```json
  "prebuild:dist": "bash scripts/generate-config.sh",
  "dist": "npm run prebuild:dist && npm run build && electron-builder --mac"
  ```
- [ ] Build command for testers:
  ```bash
  WFA_BRIDGE_URL=wss://wfa-bridge.fly.dev \
  WFA_ANTHROPIC_KEY=sk-ant-... \
  npm run dist --workspace=@workflow-agent/local-agent
  ```

#### 4g. Create app icon (OPTIONAL for testing)

- [ ] Create `local-agent/assets/icon.icns` (macOS icon format)
  - Fastest path: `npx electron-icon-builder --input=logo.png --output=assets` (generates all required sizes from a single 1024x1024 PNG)
  - Or use macOS built-in: create `icon.iconset/` with all sizes, run `iconutil -c icns icon.iconset -o assets/icon.icns`
- [ ] Update `local-agent/src/ui/tray.ts` to use a real icon instead of `nativeImage.createEmpty()`
- [ ] For the tray: use a 22x22 template icon (`Template` suffix for dark/light mode)

#### 4h. Build and test the DMG

- [ ] Run: `npm run dist --workspace=@workflow-agent/local-agent`
- [ ] Open the generated DMG from `local-agent/release/`
- [ ] Drag to Applications
- [ ] Bypass Gatekeeper: System Settings > Privacy & Security > "Open Anyway" (macOS Sequoia removed right-click bypass)
- [ ] Verify: app appears in menu bar, connects to bridge (or shows room token prompt)

**Smoke test checklist after build:**
```bash
# Verify DMG integrity
hdiutil verify release/WFA-Agent-*.dmg

# Check app structure
hdiutil attach release/WFA-Agent-*.dmg
ls -la "/Volumes/WFA Agent/WFA Agent.app/Contents/Resources/bin/"
file "/Volumes/WFA Agent/WFA Agent.app/Contents/Resources/bin/event-monitor-darwin"
hdiutil detach "/Volumes/WFA Agent"
```

**Files:**
- `local-agent/package.json` -- electron-builder config, dist script
- `local-agent/src/utils/app-paths.ts` -- **new**, centralized path resolution
- `local-agent/scripts/generate-config.sh` -- **new**, pre-build config generator
- `local-agent/src/build-config.ts` -- **new**, generated constants (gitignored)
- `local-agent/src/main.ts` -- use build-config module
- `local-agent/src/recorder/event-logger.ts` -- use getBinPath
- `local-agent/src/recorder/audio-capture.ts` -- use getBinPath
- `local-agent/src/workflows/workflow-manager.ts` -- use getUserDataPath
- `local-agent/src/recorder/session-manager.ts` -- use getUserDataPath
- `local-agent/src/ui/tray.ts` -- real icon (optional)
- `local-agent/assets/icon.icns` -- **new**, app icon (optional)

**Success criteria:** DMG builds, installs, launches from Applications, shows in menu bar.

#### Research Insights

**electron-builder Configuration:**
- Set `mac.identity: null` to explicitly disable code signing (avoids accidental signing attempts)
- `extendInfo` in mac config injects keys into Info.plist — required for `NSMicrophoneUsageDescription` (otherwise `askForMediaAccess('microphone')` silently fails)
- `asar: true` is correct — but native binaries must NEVER be inside asar. They go in `extraResources` which copies to `Contents/Resources/` outside the asar archive
- `"files"` should exclude `node_modules/**/*` from explicit listing — electron-builder handles production dependencies automatically. Including it bloats the bundle with dev dependencies
- Output to `release/` (not `dist/`) to avoid collision with TypeScript `dist/` output directory

**DMG Size Optimization:**
- Expected DMG size: ~150-250MB (Electron framework ~150MB + dependencies + binaries)
- Exclude `.ts` source, `.map` files, `*.md` from the bundle
- Consider `--dir` flag first (`electron-builder --mac --dir`) to test without creating DMG — faster iteration

**macOS Sequoia Gatekeeper (Critical Update):**
- macOS Sequoia 15+ **removed** the Control-click/right-click > Open bypass
- Testers must now go to System Settings > Privacy & Security > scroll down > click "Open Anyway"
- This is a more complex flow — onboarding materials must show this explicitly with screenshots

**Shell Script Security (Critical Fix):**
- Original `cat << EOF` heredoc expands `$` and backticks — an API key containing `$` or `` ` `` would break or execute shell commands
- Fixed by using `printf '%s'` for safe variable interpolation
- Alternative: use a Node.js script (`tsx scripts/generate-config.ts`) for cross-platform safety

**API Key in asar Bundle (Accepted Risk):**
- asar archives are trivially extractable: `npx asar extract app.asar extracted/`
- API key will be visible in plaintext JavaScript — this is accepted for 5 internal testers
- Mitigation: Anthropic Console spending limit + key rotation after testing
- For production: move ALL Claude API calls to bridge server, never embed key in client

---

### Phase 5: First-Launch Setup (Room Token + Permissions)

**Goal:** Non-technical user opens the app for the first time, pastes their room token, grants macOS permissions, and connects to the bridge.

**Tasks:**

#### 5a. Create setup window

- [ ] Create `local-agent/src/ui/setup-window.ts`:
  - An Electron `BrowserWindow` that shows on first launch (when no room token is saved)
  - Window config: `modal: true`, `resizable: false`, `minimizable: false`, `fullscreenable: false`
  - Simple HTML page with: WFA logo, welcome text, room token input field, "Connect" button
  - Room token is validated (UUID format) before saving
  - On "Connect" click: validate token against bridge (attempt WebSocket connection) before proceeding
  - Show loading state during validation ("Connecting...")
  - Show error state if token invalid or bridge unreachable ("Connection failed. Check your token and try again.")
  - Saved to `app.getPath('userData')/config.json`
  - Window closes and is destroyed (not hidden) after successful connection

#### 5b. macOS permissions check

- [ ] Create `local-agent/src/utils/permissions.ts`:
  ```typescript
  import { systemPreferences } from 'electron';

  // Guard: this module must only be imported in the main process
  if (process.type !== 'browser') {
    throw new Error('permissions.ts must only be imported in main process');
  }

  export interface PermissionStatus {
    accessibility: boolean;
    screenRecording: boolean;
    microphone: boolean;
  }

  export function checkPermissions(): PermissionStatus {
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
      microphone: systemPreferences.getMediaAccessStatus('microphone') === 'granted',
    };
  }
  ```
- [ ] In the setup window, show permission status (green/red indicators) after successful room token connection
- [ ] For each missing permission:
  - **Accessibility:** Button that opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
  - **Screen Recording:** Button that opens `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
  - **Microphone:** Call `systemPreferences.askForMediaAccess('microphone')` (triggers native prompt)
- [ ] Show "Refresh" button to re-check permissions after granting
- [ ] Note: All permission changes require app restart to take effect on macOS — show explicit restart message with a "Quit & Reopen" button

#### 5c. Persist config and use on subsequent launches

- [ ] On launch, check for `config.json` in `app.getPath('userData')`
- [ ] If exists and contains valid room token: skip setup, connect directly
- [ ] If not exists: show setup window
- [ ] If setup window is closed without completing: reappear on next launch
- [ ] Load ROOM_ID from config instead of env var (env var still overrides for dev)

**Files:**
- `local-agent/src/ui/setup-window.ts` -- **new**, setup BrowserWindow
- `local-agent/src/ui/setup.html` -- **new**, setup page HTML
- `local-agent/src/utils/permissions.ts` -- **new**, macOS permission checks
- `local-agent/src/main.ts` -- check config on launch, show setup or connect

**Success criteria:** First launch shows setup window. After entering token and granting permissions, app connects and runs as menu bar agent. Second launch skips setup.

#### Research Insights

**macOS Permissions (Critical Findings):**
- `systemPreferences.isTrustedAccessibilityClient(false)` — pass `false` for silent status check, `true` to trigger the native prompt. Known bug: calling with `false` first can disable the prompt for future calls with `true` (Electron issue #28395)
- `getMediaAccessStatus('screen')` — **does NOT update after permissions change** without app restart (Electron issue #36722). Polling is unreliable. Best approach: guide users to restart the app after granting permissions
- `askForMediaAccess('microphone')` — **requires `NSMicrophoneUsageDescription` in Info.plist** or the dialog won't show. This is set via `extendInfo` in electron-builder config (Phase 4a)
- System Settings URLs (`x-apple.systempreferences:...`) work on Ventura, Sonoma, and Sequoia (as of 2026) but are **not officially documented by Apple** — could break in future macOS versions
- macOS Sequoia (15.1+) shows **monthly permission prompts** for screen recording apps — this is normal macOS behavior, inform testers

**Setup Window UX (From Spec Flow Analysis):**
- Validate room token against bridge immediately on "Connect" click (don't wait until after permissions)
- If bridge is unreachable: show "Connection failed" with retry button (don't loop automatically)
- If setup window is closed before completion: reappear on next launch (check for missing config)
- If tester enters wrong token: show clear error message, keep input field populated for correction
- After permission grant + restart: app should auto-connect using persisted config (no re-entry of token)

**Edge Cases Identified (From Spec Flow Analysis):**
- Two testers with same room token: bridge's socket replacement policy handles this (close old, accept new). Each room supports ONE agent + ONE dashboard
- Tester opens dashboard before agent: dashboard shows "Connect local agent to record" — existing behavior, acceptable
- Mac sleep/wake: WebSocket client already has reconnection with exponential backoff — no additional work needed
- Agent doesn't auto-start on Mac restart: acceptable for testing. Login Items would require additional setup

---

### Phase 6: Tester Onboarding Materials

**Goal:** A tester receives a DMG + email with everything they need to get started.

**Tasks:**

- [ ] Update `TESTER_SETUP.md` with DMG-based instructions:
  1. Download DMG from [link]
  2. Open DMG, drag WFA Agent to Applications
  3. Open WFA Agent from Applications folder
  4. **macOS Sequoia:** Go to System Settings > Privacy & Security > scroll down > click "Open Anyway" (first time only)
  5. Paste your room token (from email) into the setup screen
  6. Grant macOS permissions when prompted (Accessibility, Screen Recording, Microphone)
  7. **Restart the app** after granting Accessibility and Screen Recording
  8. Open dashboard: `https://<vercel-url>?room=<your-token>`
  9. Verify: dashboard shows "Connected"
- [ ] Include screenshots of: System Settings "Open Anyway" dialog, permission prompts, setup window, connected state
- [ ] Create email template for testers with: DMG download link, room token, dashboard URL, quick troubleshooting
- [ ] Generate SHA-256 checksum for DMG file and include in distribution:
  ```bash
  shasum -a 256 "WFA Agent.dmg" > WFA-Agent-checksum.txt
  ```

**Files:**
- `TESTER_SETUP.md` -- updated for non-technical users

**Success criteria:** A non-technical macOS user can follow the guide without additional support.

#### Research Insights

**Distribution Security:**
- Generate SHA-256 checksum of DMG and send via separate channel (e.g., text message while DMG goes via email)
- Unsigned DMG has no tamper protection — checksum is the only integrity verification
- File hosting: email attachment may hit size limits (~25MB Gmail limit, DMG will be ~150-250MB). Use cloud storage link (Google Drive, Dropbox) instead

**Onboarding Best Practices (From Spec Flow Analysis):**
- Include Gatekeeper bypass screenshots for macOS Sequoia specifically (different flow from older macOS)
- Mention that Screen Recording permission prompts may recur monthly on Sequoia — this is normal
- Include troubleshooting: "If dashboard shows 'Disconnected', try quitting and relaunching the agent from Applications"
- Include tester feedback channel (Slack/email) for bug reports

---

## Scope Boundaries (YAGNI)

Per brainstorm, NOT building:
- Windows support
- Code signing / notarization
- Auto-update mechanism
- Cross-workflow learning / intelligence layer
- Workflow editing in dashboard
- Variable input UI
- Workflow cancel
- Test suite
- Architecture docs

---

## Acceptance Criteria

### Functional Requirements

- [ ] Bridge server deployed to Fly.io, health check passing at `wfa-bridge.fly.dev/health`
- [ ] Dashboard connects to bridge when `VITE_WS_URL` is set and `?room=uuid` is in URL
- [ ] Workflow execution uses structured goal with steps, layers, and applications
- [ ] DMG builds successfully, installs, and launches on macOS
- [ ] First-launch setup prompts for room token and checks macOS permissions
- [ ] App connects to bridge after setup, runs as menu bar agent
- [ ] Tester can record a workflow, see it in the library, and run it -- end to end

### Non-Functional Requirements

- [ ] API key spending limit set in Anthropic Console
- [ ] Room tokens stored as Fly.io secrets (not in code or fly.toml)
- [ ] Native binaries work correctly when app is packaged (not just in dev)
- [ ] Workflow/recording data stored in `~/Library/Application Support/WFA Agent/`
- [ ] DMG checksum generated and distributed to testers

---

## Dependencies & Prerequisites

| Dependency | Required For | Status |
|---|---|---|
| `flyctl` CLI | Phase 1 | Install via brew |
| Fly.io account | Phase 1 | Needs signup |
| Anthropic API key | Phase 1 | Existing |
| Vercel project access | Phase 2 | Existing |
| electron-builder npm package | Phase 4 | Install |
| macOS icon (.icns file) | Phase 4 | Optional — use default or auto-generate |

## Risk Analysis

| Risk | Impact | Mitigation |
|---|---|---|
| Unsigned app blocked by macOS Sequoia 15+ (no right-click bypass) | Testers can't open app | Updated onboarding: System Settings > Privacy & Security > "Open Anyway" with screenshots |
| electron-builder + asar breaks native binary paths | Recording/screenshots fail | Phase 4b uses centralized `AppPaths` utility with `app.isPackaged` check |
| formatWorkflowAsGoal has hidden dependency on local-agent modules | Bridge can't format goals on Fly.io | Phase 3c copies the function into server package (confirmed no external deps) |
| Skills registry paths break in packaged app | Skills don't load | Phase 4e is OPTIONAL — skills aren't used in testing. Skip unless blocking |
| Embedded API key extracted from asar bundle | Key leaked, costs incurred | Anthropic Console usage cap limits damage; key rotated after testing |
| macOS permissions require app restart (all three) | Confusing for non-technical user | Setup window shows explicit restart message; onboarding materials explain |
| `getMediaAccessStatus('screen')` doesn't update without restart | Permission check appears stuck | Don't poll — guide user to restart after granting permissions |
| Shell script `generate-config.sh` breaks on API keys with special chars | Build fails or generates bad config | Fixed: uses `printf '%s'` instead of heredoc variable expansion |
| Concurrent workflow runs without requestId cause response mismatch | Wrong workflow data used for execution | Fixed: added `requestId` correlation to protocol messages |
| DMG too large for email attachment (~150-250MB) | Tester can't download | Use cloud storage link (Google Drive, Dropbox) instead of email attachment |

---

## Deployment Verification Checklist

### Pre-Deploy (Phase 1)
- [ ] Dockerfile builds locally: `docker build -t wfa-bridge:test .`
- [ ] Health check works in local Docker: `curl http://localhost:8765/health`
- [ ] All 15 bridge tests pass (8 protocol + 7 integration)
- [ ] `fly.toml` has `auto_stop_machines = "off"` and `primary_region = "fra"`

### Post-Deploy (Phase 1)
- [ ] `curl https://wfa-bridge.fly.dev/health` returns 200
- [ ] `wscat -c wss://wfa-bridge.fly.dev` connects
- [ ] Send hello with valid room token → accepted
- [ ] Send hello with invalid room token → rejected
- [ ] `fly logs` shows no errors

### Post-Deploy (Phase 2)
- [ ] Dashboard `?room=<uuid>` shows WebSocket connection in DevTools
- [ ] Dashboard without `?room=` shows cloud preview state

### Pre-Distribution (Phase 4-5)
- [ ] DMG builds without errors
- [ ] DMG integrity: `hdiutil verify release/WFA-Agent-*.dmg`
- [ ] App structure: native binaries exist in `Contents/Resources/bin/`
- [ ] App launches from /Applications
- [ ] Gatekeeper bypass via System Settings works
- [ ] Setup window displays, accepts room token, validates against bridge
- [ ] Permissions check shows correct status
- [ ] After permissions grant + restart, app auto-connects
- [ ] Second launch skips setup window

### Tester Verification (Phase 6)
- [ ] Each tester confirms installation success within 1 hour
- [ ] Each tester confirms bridge connection within 2 hours
- [ ] At least 1 tester records and runs a workflow end-to-end

---

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-07-tester-distribution-and-deployment-brainstorm.md](../brainstorms/2026-03-07-tester-distribution-and-deployment-brainstorm.md)
  - Key decisions carried forward: unsigned DMG, embedded API key, first-launch room token prompt, skip Python skills, macOS permissions setup screen

### Internal References

- Bridge server implementation: `server/src/bridge.ts` (handleWorkflowRun at line 559)
- Workflow formatter: `local-agent/src/agent/workflow-executor.ts` (formatWorkflowAsGoal at line 88)
- Workflow types: `local-agent/src/agent/workflow-types.ts` (WorkflowDefinition, WorkflowStep)
- Workflow manager: `local-agent/src/workflows/workflow-manager.ts`
- Dashboard message handler: `local-agent/src/connection/dashboard-message-handler.ts`
- Binary paths: `local-agent/src/recorder/event-logger.ts:99`, `audio-capture.ts:16`
- Tray icon: `local-agent/src/ui/tray.ts`
- Existing deployment: `Dockerfile`, `fly.toml`, `.dockerignore`
- Bridge deployment solution: `docs/solutions/integration-issues/bridge-server-websocket-production-deployment.md`

### P1 Blockers (from todos)

All 5 P1 items from `WFA - Tool UI/todos/001-005` were already fixed in the bridge server rewrite (commit `238fa6f`): maxPayload 5MB, Docker non-root user, room tokens as secrets, Dockerfile workspace copies, message validation.

### External Research Sources

- [Fly.io WebSocket deployment docs](https://fly.io/docs/reference/services/#websocket) — auto_stop, health checks, TLS
- [electron-builder DMG configuration](https://www.electron.build/dmg.html) — contents, layout, extendInfo
- [Electron systemPreferences API](https://www.electronjs.org/docs/latest/api/system-preferences) — permissions
- [macOS Sequoia Gatekeeper changes](https://www.idownloadblog.com/2024/08/07/apple-macos-sequoia-gatekeeper-change-install-unsigned-apps-mac/) — removed Control-click bypass
- [Electron issue #36722](https://github.com/electron/electron/issues/36722) — getMediaAccessStatus bug
- [Electron issue #28395](https://github.com/electron/electron/issues/28395) — isTrustedAccessibilityClient behavior
