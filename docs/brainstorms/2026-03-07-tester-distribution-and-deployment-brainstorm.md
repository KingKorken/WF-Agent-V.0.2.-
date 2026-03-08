# Brainstorm: Tester Distribution & Deployment

**Date:** 2026-03-07
**Status:** Complete
**Goal:** Get non-technical macOS testers running WFA end-to-end with their own workflows.

---

## What We're Building

A distribution-ready version of the WFA local agent as a macOS DMG that non-technical testers can download, install, and use without any terminal commands, Node.js, or API key setup. Combined with deploying the bridge server to Fly.io and configuring the Vercel dashboard.

**The end-to-end tester experience should be:**
1. Receive a DMG file + dashboard URL with room token
2. Install the app (drag to Applications, right-click > Open once for Gatekeeper)
3. App starts in system tray, auto-connects to bridge server
4. Open dashboard URL in browser, see agent connected
5. Record a workflow, run it, chat with the agent

---

## Why This Approach

**DMG with embedded config** was chosen over ZIP+launcher (more Gatekeeper friction) and dev setup (requires terminal/Node.js). Non-technical testers need a click-to-run experience.

**macOS first, Windows later.** The native binaries (event capture, audio recording) and JXA accessibility layer are macOS-only. Rather than block the test round on cross-platform work, ship macOS now and add Windows support as a separate phase.

**API key baked into the app.** Non-technical testers shouldn't need to understand API keys. The cost is borne by the developer during the testing phase. The key can be rotated after testing.

**Unsigned for now.** Apple Developer ID ($99/year) adds delay. The one-time Gatekeeper bypass (right-click > Open) is acceptable for a small tester group.

---

## Key Decisions

### 1. Distribution: Unsigned DMG via electron-builder
- Use electron-builder to create a macOS DMG
- No code signing or notarization (testers bypass Gatekeeper once)
- Include the native binaries (event-monitor-darwin, audio-recorder-darwin) in the app bundle
- Include pre-compiled Python skills (Excel, Word) or bundle a portable Python

### 2. Config: Embedded bridge URL + room token + API key
- Bridge URL (`wss://wfa-bridge.fly.dev`) baked into the build
- API key embedded via build-time env var (not in source code)
- Room token: first-launch prompt where tester pastes their token (one DMG for all testers, tokens distributed separately via email/message)

### 3. Deployment: Fly.io bridge + Vercel dashboard env var
- Deploy bridge server to Fly.io Frankfurt (`fly deploy`)
- Set secrets: `fly secrets set VALID_ROOMS="uuid1,uuid2,..." ANTHROPIC_API_KEY="sk-ant-..."`
- Set Vercel env var: `VITE_WS_URL=wss://wfa-bridge.fly.dev`
- Redeploy dashboard on Vercel

### 4. Fix: Wire up structured workflow execution
- Current: bridge sends generic text goal ("Execute the workflow X")
- Fix: load the WorkflowDefinition from the agent, use formatWorkflowAsGoal() to give Claude the structured plan with steps, layers, apps, and variables
- This improves execution quality significantly

### 5. Platform: macOS only for V1 testers
- All native binaries are macOS-only
- Accessibility layer uses JXA (macOS-specific)
- Windows support is a separate phase (requires: Windows event capture binary, Windows accessibility layer, Windows audio capture, electron-builder Windows config)

### 6. Python dependency handling
- Excel and Word skills require Python 3 with openpyxl and python-docx
- macOS Ventura+ no longer ships Python 3. Non-technical testers will not have it.
- Decision: Skip Python skills for initial testing. The agent's 5-layer system can still automate Excel/Word via accessibility and vision layers. If testers specifically need Excel/Word file manipulation, add a Python install step to onboarding later.

### 7. macOS permissions (Accessibility, Screen Recording, Microphone)
- The agent requires Accessibility access (for AX element snapshots), Screen Recording (for screenshots), and Microphone (for voice narration during recording)
- macOS will prompt the user to grant each permission on first use
- Decision: Show a guided first-launch permissions setup screen in the Electron app that explains why each permission is needed and links to System Settings. The app should detect which permissions are missing and guide the user through granting them before proceeding.

---

## Resolved Questions

**Q: Should we build the intelligence/learning layer before distributing?**
A: No. Ship what exists (learned actions, skill discovery, stuck detection are already functional). Build cross-workflow learning after collecting real usage data from testers.

**Q: Do Windows testers need full recording capability?**
A: No. macOS first, Windows later as a separate phase.

**Q: How do testers get their API key?**
A: They don't. Developer's key is baked into the app build.

**Q: Signed or unsigned DMG?**
A: Unsigned. Testers bypass Gatekeeper once via right-click > Open.

**Q: Should we fix the workflow run handler to use structured goals?**
A: Yes. Wire up formatWorkflowAsGoal() so Claude gets the full structured plan.

---

## What Exists vs What Must Be Built

### Already done (from this session + prior work):
- Bridge server with room-based multi-tenancy (tested: 8/8 protocol tests + 7/7 integration tests)
- Dashboard WebSocket fixes (isDeployedEnvironment removed, room token support)
- Local agent room support (ROOM_ID env var, roomId in AgentHello)
- Dockerfile, fly.toml, .dockerignore
- Full recording pipeline, parsing, workflow CRUD, agent loop
- All 5 execution layers
- Learned actions, skill discovery, stuck detection

### Must be built:
1. **Fly.io deployment** -- `fly launch`, `fly deploy`, set secrets
2. **Vercel env var** -- set `VITE_WS_URL=wss://wfa-bridge.fly.dev`, redeploy
3. **electron-builder config** -- package.json config for macOS DMG
4. **App config system** -- embed bridge URL + API key, first-launch room token prompt
5. **Wire formatWorkflowAsGoal()** -- connect structured workflow data to bridge's run handler
6. **macOS permissions setup** -- first-launch screen guiding Accessibility, Screen Recording, Microphone permissions
7. **API key usage cap** -- set a spending limit on the embedded Anthropic API key to prevent runaway costs
8. **Tester onboarding** -- instructions for DMG install + Gatekeeper bypass + dashboard URL

---

## Scope Boundaries (YAGNI)

**NOT building for this round:**
- Windows support
- Code signing / notarization
- Auto-update mechanism
- Cross-workflow learning / intelligence layer enhancements
- Workflow editing in dashboard
- Variable input UI in dashboard
- Workflow cancel implementation
- Test suite
- Architecture documentation

---

## Next Steps

Run `/workflows:plan` to create the implementation plan for:
1. Fly.io deployment
2. Vercel configuration
3. electron-builder DMG packaging
4. App config / room token prompt
5. Structured workflow execution fix
6. macOS permissions setup screen
7. API key usage cap
8. Tester onboarding materials
