---
title: "feat: Workflow Library & Recording Persistence"
type: feat
status: active
date: 2026-03-06
origin: docs/brainstorms/2026-03-06-workflow-library-recording-persistence-brainstorm.md
---

# feat: Workflow Library & Recording Persistence

## Overview

Connect the dashboard's recording flow to a new Workflow Library view so that recorded workflows are automatically parsed, persisted, and browsable. When a user records a workflow, the local agent auto-parses it via Claude and stores it on disk. The dashboard fetches and displays these workflows through the existing WebSocket relay, allowing users to view details, run, and delete workflows.

This feature bridges two working-but-disconnected systems: the local agent's recording pipeline and the dashboard's UI shell. (see brainstorm: `docs/brainstorms/2026-03-06-workflow-library-recording-persistence-brainstorm.md`)

## Problem Statement

Currently:
- The dashboard RecordView has start/stop buttons but they're TODO stubs — no WebSocket commands are sent
- The local agent has a full recording system and 7 parsed workflow files on disk, but the dashboard can't see them
- The `workflowStore` uses hardcoded mock data instead of real workflows
- The Workflow Library dock icon opens Settings (wrong route)
- No `WorkflowLibrary` component or route exists

Users can visually "record" in the dashboard but nothing actually records, nothing saves, and there's nowhere to see saved workflows.

## Proposed Solution

Wire the full pipeline: Dashboard RecordView → WebSocket → Server relay → Local Agent recording → auto-parse → save to disk → fetch via WebSocket → display in new Workflow Library view.

**Key architectural decision:** Server is a pure relay — no storage, no caching. All workflow data lives on the local agent's filesystem. (see brainstorm: decision #1, #7, #13)

## Technical Approach

### Architecture

```
Dashboard (Vercel)          Server (Bridge)         Local Agent (Electron)
     │                           │                        │
     │ dashboard_start_recording │                        │
     │ ─────────────────────────>│ relay ─────────────────>│ session-manager.startSession()
     │                           │                        │
     │ agent_recording_started   │                        │
     │ <─────────────────────────│ relay <─────────────────│
     │                           │                        │
     │ dashboard_stop_recording  │                        │
     │ ─────────────────────────>│ relay ─────────────────>│ session-manager.stopSession()
     │                           │                        │   └─> auto-parse via Claude
     │ agent_recording_parsing   │                        │
     │ <─────────────────────────│ relay <─────────────────│
     │                           │                        │
     │ agent_workflow_parsed     │                        │
     │ <─────────────────────────│ relay <─────────────────│ saves workflow.json
     │                           │                        │
     │ dashboard_list_workflows  │                        │
     │ ─────────────────────────>│ relay ─────────────────>│ reads workflows/ dir
     │                           │                        │
     │ agent_workflow_list       │                        │
     │ <─────────────────────────│ relay <─────────────────│
```

### Implementation Phases

#### Phase 1: Shared Types & Protocol (shared/)

Add new WebSocket message interfaces to the shared protocol.

**Tasks:**
- [ ] Add 5 dashboard→server message interfaces to `shared/types.ts`:
  - `DashboardStartRecording { type, description }`
  - `DashboardStopRecording { type }`
  - `DashboardListWorkflows { type }`
  - `DashboardGetWorkflow { type, workflowId }`
  - `DashboardDeleteWorkflow { type, workflowId }`
- [ ] Add 7 agent→server→dashboard message interfaces:
  - `AgentRecordingStarted { type, sessionId }`
  - `AgentRecordingStopped { type, sessionId }`
  - `AgentRecordingParsing { type }`
  - `AgentWorkflowParsed { type, workflow: WorkflowSummary }`
  - `AgentWorkflowList { type, workflows: WorkflowSummary[] }`
  - `AgentWorkflowDetail { type, workflow: WorkflowDefinition }`
  - `AgentWorkflowDeleted { type, workflowId }`
  - `AgentRecordingError { type, error: string }` — for parse failures (see brainstorm: decision #12)
- [ ] Define `WorkflowSummary` type (subset of `WorkflowDefinition`): `{ id, name, description, createdAt, applicationCount, stepCount }`
- [ ] Add all new types to the `WebSocketMessage` union type

**Files:**
- `shared/types.ts` (lines 378-502: existing protocol, line 497: union type)

**Success criteria:** Types compile. All 4 packages can import the new message types.

---

#### Phase 2: Local Agent — Recording Commands & Auto-Parse (local-agent/)

Enable the local agent to receive recording start/stop commands via WebSocket and auto-parse after recording.

**Tasks:**
- [ ] Add WebSocket message handlers for `dashboard_start_recording` and `dashboard_stop_recording` in the local agent's connection handler
  - Route to `session-manager.startSession()` / `stopSession()`
  - Send `agent_recording_started` / `agent_recording_stopped` back through WebSocket
  - Reject `dashboard_start_recording` if a recording is already in progress (return error message)
- [ ] Add auto-parse trigger in `session-manager.ts` after `stopSession()` completes manifest building (~line 220):
  - Send `agent_recording_parsing` message to dashboard (triggers spinner)
  - Call `workflow-parser.ts` `parseRecordingToWorkflow(sessionDir)`
  - On success: send `agent_workflow_parsed { workflow: WorkflowSummary }` back
  - On failure: send `agent_recording_error { error }` back (see brainstorm: decision #12). Raw recording is preserved on disk.
- [ ] Add recording timeout: auto-stop after 30 minutes with `agent_recording_stopped` message
- [ ] Handle WebSocket disconnection during recording: auto-stop recording after 30-second grace period if dashboard connection is lost

**Files:**
- `local-agent/src/connection/command-handler.ts` (lines 30-83: message routing pattern)
- `local-agent/src/recorder/session-manager.ts` (lines 160-231: `stopSession()`)
- `local-agent/src/agent/workflow-parser.ts` (lines 40-112: `parseRecordingToWorkflow()`)

**Success criteria:** `startSession` and `stopSession` can be triggered via WebSocket. After stop, workflow is auto-parsed and saved to `workflows/<id>.json`. Error messages sent on failure.

---

#### Phase 3: Local Agent — Workflow CRUD Commands (local-agent/)

Enable the local agent to list, get, and delete workflows via WebSocket.

**Tasks:**
- [ ] Add handler for `dashboard_list_workflows`:
  - Read all `.json` files from `local-agent/workflows/` directory
  - Parse each file, extract `WorkflowSummary` fields (id, name, description, createdAt, applicationCount, stepCount)
  - Skip files that fail JSON parsing (log warning, don't crash)
  - Send `agent_workflow_list { workflows }` back
- [ ] Add handler for `dashboard_get_workflow`:
  - Read specific `workflows/<workflowId>.json`
  - Send `agent_workflow_detail { workflow }` with full `WorkflowDefinition`
  - If file not found: send error response
- [ ] Add handler for `dashboard_delete_workflow`:
  - Delete `workflows/<workflowId>.json` from disk
  - Send `agent_workflow_deleted { workflowId }` back
  - If file not found: still send success (idempotent)

**Files:**
- `local-agent/src/connection/command-handler.ts` (add new cases)
- New file: `local-agent/src/workflows/workflow-manager.ts` — encapsulates list/get/delete logic against the `workflows/` directory

**Success criteria:** All 3 commands work via WebSocket. Corrupted JSON files are skipped gracefully.

---

#### Phase 4: Server — Relay New Message Types (server/)

Add pass-through relay for all new message types in the bridge server.

**Tasks:**
- [ ] Add relay cases in `bridge.ts` WebSocket `onmessage` handler (~line 614) for all 5 dashboard→agent messages:
  - `dashboard_start_recording` → forward to local agent
  - `dashboard_stop_recording` → forward to local agent
  - `dashboard_list_workflows` → forward to local agent
  - `dashboard_get_workflow` → forward to local agent
  - `dashboard_delete_workflow` → forward to local agent
- [ ] Add relay cases for all 8 agent→dashboard messages:
  - `agent_recording_started` → forward to dashboard
  - `agent_recording_stopped` → forward to dashboard
  - `agent_recording_parsing` → forward to dashboard
  - `agent_workflow_parsed` → forward to dashboard
  - `agent_workflow_list` → forward to dashboard
  - `agent_workflow_detail` → forward to dashboard
  - `agent_workflow_deleted` → forward to dashboard
  - `agent_recording_error` → forward to dashboard
- [ ] No server-side logic — pure relay (see brainstorm: decision #13)

**Files:**
- `server/src/bridge.ts` (lines 603-676: message routing)

**Success criteria:** All messages pass through correctly. Server adds no transformation or storage.

---

#### Phase 5: Dashboard — Update workflowStore & Message Router (dashboard/)

Replace mock data with WebSocket-driven workflow state.

**Tasks:**
- [ ] Update `workflowStore.ts`:
  - Remove `MOCK_WORKFLOWS` array
  - Add state fields: `workflows: WorkflowSummary[]`, `selectedWorkflow: WorkflowDefinition | null`, `loading: boolean`, `recordingState: 'idle' | 'recording' | 'parsing' | 'complete' | 'error'`, `recordingError: string | null`
  - Add actions: `fetchWorkflows()` (sends `dashboard_list_workflows`), `fetchWorkflowDetail(id)` (sends `dashboard_get_workflow`), `deleteWorkflow(id)` (sends `dashboard_delete_workflow`), `startRecording(description)`, `stopRecording()`
  - Add handlers called by message-router: `setWorkflows(list)`, `setWorkflowDetail(def)`, `removeWorkflow(id)`, `setRecordingState(state)`, `setRecordingError(error)`
- [ ] Update `message-router.ts` — add cases for all 8 incoming agent messages:
  - `agent_recording_started` → `workflowStore.setRecordingState('recording')`
  - `agent_recording_stopped` → (intermediate state, wait for parsing)
  - `agent_recording_parsing` → `workflowStore.setRecordingState('parsing')`
  - `agent_workflow_parsed` → `workflowStore.setRecordingState('complete')` + add to workflow list
  - `agent_recording_error` → `workflowStore.setRecordingState('error')` + set error message
  - `agent_workflow_list` → `workflowStore.setWorkflows(msg.workflows)`
  - `agent_workflow_detail` → `workflowStore.setWorkflowDetail(msg.workflow)`
  - `agent_workflow_deleted` → `workflowStore.removeWorkflow(msg.workflowId)`

**Files:**
- `dashboard/src/stores/workflowStore.ts` (lines 1-145: full store)
- `dashboard/src/services/message-router.ts` (lines 26-82: message handling)

**Success criteria:** Store fetches real workflows via WebSocket. No mock data. Recording state tracks the full lifecycle.

---

#### Phase 6: Dashboard — Wire RecordView to WebSocket (dashboard/)

Connect RecordView's buttons to real WebSocket commands.

**Tasks:**
- [ ] Replace `handleStart()` TODO stub with: call `workflowStore.startRecording(workflowName)` which sends `dashboard_start_recording` via WebSocket
  - Disable "Start Recording" button if `connectionStore.agentConnected` is false (show "Connect local agent to record")
  - Disable if recording already in progress
- [ ] Replace `handleStop()` TODO stub with: call `workflowStore.stopRecording()` which sends `dashboard_stop_recording`
- [ ] Update RecordView state rendering to use `workflowStore.recordingState` instead of local `useState`:
  - `idle` → Show name input + "Start Recording" button
  - `recording` → Show red dot + "Stop Recording" button
  - `parsing` → Show spinner + "Processing your recording..." text (see brainstorm: decision #9)
  - `complete` → Show "Workflow saved!" with workflow name + "Record another" button
  - `error` → Show "Processing failed — recording saved, try again later" (see brainstorm: decision #12) + "Record another" button
- [ ] Workflow name: captured from the existing name input field before recording starts. Passed as `description` in `dashboard_start_recording`.

**Files:**
- `dashboard/src/components/Record/RecordView.tsx` (lines 8-119)
- `dashboard/src/components/Record/RecordView.module.css`

**Success criteria:** Clicking Start/Stop sends real WebSocket commands. UI reflects actual recording state from local agent.

---

#### Phase 7: Dashboard — Build Workflow Library View (dashboard/)

Create the Workflow Library canvas view with cards, detail panel, and empty states.

**Tasks:**
- [ ] Create `WorkflowLibrary/WorkflowLibraryView.tsx`:
  - On mount: check `connectionStore.agentConnected`. If connected, call `workflowStore.fetchWorkflows()`. If not, show disconnected empty state (see brainstorm: decision #8).
  - Show loading state while waiting for `agent_workflow_list`
  - Render list of `WorkflowCard` components
  - If `workflows.length === 0` and agent is connected: show "No workflows yet — record your first workflow" with CTA
  - If a workflow is selected: show `WorkflowDetail` panel alongside or below the list
  - Workflow list ordered by `createdAt` descending (newest first)
- [ ] Create `WorkflowLibrary/WorkflowCard.tsx`:
  - Minimal: workflow name + creation date (see brainstorm: decision #4)
  - Clickable — on click: call `workflowStore.fetchWorkflowDetail(id)` and show detail panel
  - Highlight selected card
- [ ] Create `WorkflowLibrary/WorkflowDetail.tsx`:
  - Show: name, description, creation date, list of applications used, step count
  - **Run button**: calls `workflowStore.runWorkflow(id)` — uses existing `dashboard_workflow_run` (see brainstorm: decision #6). Disable if agent not connected.
  - **Delete button**: shows confirmation dialog, then calls `workflowStore.deleteWorkflow(id)` (see brainstorm: decision #11)
  - Confirmation dialog: shows workflow name and "This action cannot be undone"
- [ ] Create CSS Modules for all 3 components following existing design system:
  - Use CSS variables (`var(--color-bg)`, `var(--space-lg)`, etc.)
  - Orange accent (`#E86A33`) for the Run button only (single critical action per view)
  - 8px base spacing, Inter font, no icons in navigation
- [ ] Fix `SidebarDock.tsx` line 34: change `onClick` from opening `'settings'` to `'workflow-library'`
- [ ] Add route in `App.tsx` (~line 108): `{activeTabId === 'workflow-library' && <WorkflowLibraryView />}`

**Files:**
- New: `dashboard/src/components/WorkflowLibrary/WorkflowLibraryView.tsx`
- New: `dashboard/src/components/WorkflowLibrary/WorkflowLibraryView.module.css`
- New: `dashboard/src/components/WorkflowLibrary/WorkflowCard.tsx`
- New: `dashboard/src/components/WorkflowLibrary/WorkflowCard.module.css`
- New: `dashboard/src/components/WorkflowLibrary/WorkflowDetail.tsx`
- New: `dashboard/src/components/WorkflowLibrary/WorkflowDetail.module.css`
- Modify: `dashboard/src/components/Sidebar/SidebarDock.tsx` (line 34)
- Modify: `dashboard/src/App.tsx` (line 108)

**Success criteria:** Library shows real workflows fetched via WebSocket. Cards display name + date. Detail shows full info with working Run and Delete buttons. Empty states display correctly for disconnected agent and empty library.

---

#### Phase 8: End-to-End Testing & Polish

Verify the complete flow works across all 3 packages.

**Tasks:**
- [ ] Test recording flow: Dashboard Start → Local Agent records → Stop → Auto-parse → Workflow appears in library
- [ ] Test library: Open library → see all workflows → click card → see details → click Run
- [ ] Test deletion: Click Delete → confirm → workflow removed from library and disk
- [ ] Test disconnected state: Open library without local agent running → see empty state message
- [ ] Test parse failure: Simulate Claude API error → RecordView shows error, recording preserved
- [ ] Test recording while disconnected: Start Recording button disabled when agent not connected
- [ ] Verify design rules: only 3 colors, Inter font, 8px spacing, CSS Modules, orange accent on single CTA

**Success criteria:** Full end-to-end flow works. All edge cases handled gracefully.

## System-Wide Impact

### Interaction Graph

- Dashboard `RecordView` → `workflowStore.startRecording()` → `wsService.send()` → Server `bridge.ts` relay → Local Agent `command-handler.ts` → `session-manager.startSession()`
- Local Agent `stopSession()` → `manifest-builder.buildManifest()` → `workflow-parser.parseRecordingToWorkflow()` → saves to `workflows/<id>.json` → sends `agent_workflow_parsed` → Server relay → Dashboard `message-router.ts` → `workflowStore.setRecordingState('complete')`
- Dashboard `WorkflowLibraryView` mount → `workflowStore.fetchWorkflows()` → WebSocket → Server → Local Agent reads `workflows/` dir → `agent_workflow_list` → Dashboard renders cards

### Error Propagation

- Claude API failure in `workflow-parser.ts` → caught in `session-manager.ts` → sends `agent_recording_error` → Server relay → Dashboard `message-router` → `workflowStore.setRecordingState('error')` → RecordView shows error message
- WebSocket disconnection → `connectionStore.status` changes → RecordView/Library detect via store and show appropriate disconnected state
- File not found on delete → Local Agent treats as success (idempotent) → sends `agent_workflow_deleted`

### State Lifecycle Risks

- **Recording in progress + browser close:** Local Agent auto-stops after 30-second grace period. Raw recording preserved.
- **Multiple simultaneous recordings:** Local Agent rejects second `start_recording` with error.
- **Delete during execution:** V1 does not lock workflows during execution — deletion removes the file but running execution continues with in-memory data. Acceptable for V1.
- **Parse failure:** Raw recording preserved in `recordings/<sessionId>/`. Workflow file not created. Retry-parse is out of scope for V1 but data is not lost.

### API Surface Parity

- All 12 new WebSocket message types must be added to `shared/types.ts` and handled in all 3 packages
- The existing `dashboard_workflow_run` / `server_workflow_progress` messages continue to work unchanged
- `WorkflowSummary` is a new shared type used in list operations; `WorkflowDefinition` already exists in `local-agent/src/agent/workflow-types.ts` and should be moved to `shared/` or re-exported

## Acceptance Criteria

### Functional Requirements

- [ ] Clicking "Start Recording" in dashboard sends real WebSocket command to local agent and recording begins
- [ ] Clicking "Stop Recording" stops recording, triggers auto-parse, shows processing spinner
- [ ] After successful parse, RecordView shows "Workflow saved!" with the workflow name
- [ ] If parse fails, RecordView shows error message. Raw recording is preserved on disk.
- [ ] Workflow Library dock icon opens the Workflow Library view (not Settings)
- [ ] Workflow Library displays all workflows from local agent as cards (name + date)
- [ ] Clicking a card shows detail view (description, apps, steps, Run button, Delete button)
- [ ] Run button executes the workflow via existing `runWorkflow()` mechanism
- [ ] Delete button shows confirmation, then removes workflow from library and disk
- [ ] When local agent is not connected, library shows "Connect your local agent to see workflows"
- [ ] When workflows directory is empty, library shows "No workflows yet" with CTA to record
- [ ] Start Recording button is disabled when local agent is not connected

### Non-Functional Requirements

- [ ] All UI follows locked design rules: 3 colors, Inter font, 8px spacing, CSS Modules
- [ ] Orange accent used only on single most critical action per view
- [ ] No mock/hardcoded workflow data remains in production code

## Dependencies & Prerequisites

- Local agent must be running and connected via WebSocket for recording and library features to work
- Claude API key must be configured in local agent for auto-parse
- `workflow-parser.ts` must be working (already verified — 7 existing workflows parsed successfully)

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude API timeout during auto-parse | Medium | Medium | Show error, preserve raw recording, user can record again |
| WebSocket disconnect during recording | Low | High | Auto-stop recording after 30s grace period |
| Large workflows directory (100+ files) | Low (V1) | Low | Sequential file reads; pagination deferred to future |
| Corrupted workflow JSON on disk | Low | Medium | Skip invalid files in list, log warning |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-06-workflow-library-recording-persistence-brainstorm.md](docs/brainstorms/2026-03-06-workflow-library-recording-persistence-brainstorm.md) — Key decisions carried forward: WebSocket relay with no database (#1), auto-parse after recording (#2), functional Run button (#6), server as pure relay (#13), parse failure handling (#12)

### Internal References

- WebSocket protocol: `shared/types.ts:378-502`
- Bridge server relay pattern: `server/src/bridge.ts:603-676`
- Message router pattern: `dashboard/src/services/message-router.ts:26-82`
- Zustand store pattern: `dashboard/src/stores/workflowStore.ts:48-144`
- RecordView (TODO stubs): `dashboard/src/components/Record/RecordView.tsx:13-23`
- Session manager: `local-agent/src/recorder/session-manager.ts:160-231`
- Workflow parser: `local-agent/src/agent/workflow-parser.ts:40-112`
- WorkflowDefinition type: `local-agent/src/agent/workflow-types.ts:8-19`
- Dock icon bug: `dashboard/src/components/Sidebar/SidebarDock.tsx:34`
- Tab routing: `dashboard/src/App.tsx:103-108`
- Command handler: `local-agent/src/connection/command-handler.ts:30-83`
