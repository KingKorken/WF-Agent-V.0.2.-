# Brainstorm: Workflow Library & Recording Persistence

**Date:** 2026-03-06
**Status:** Reviewed
**Feature:** Connect recording flow to Workflow Library so recorded workflows are saved, listed, and viewable

---

## What We're Building

A working end-to-end flow where:
1. User records a workflow in the dashboard (RecordView)
2. Recording is sent to the local agent, which auto-parses it into a structured WorkflowDefinition using Claude
3. The parsed workflow is stored on disk (`local-agent/workflows/<id>.json`)
4. The Workflow Library view in the dashboard displays all stored workflows (fetched via WebSocket relay)
5. Clicking a workflow shows details (description, steps, apps) with a Run button

## Why This Approach

**WebSocket relay through existing server bridge** is the right pattern because:
- The architecture already has Dashboard ↔ Server ↔ Local Agent WebSocket connections
- Workflow files already exist on disk in the local agent (`local-agent/workflows/`, 7 files currently)
- No new infrastructure needed (no database, no REST API)
- Keeps sensitive recording data local (GDPR-friendly)
- Auto-parsing removes the manual CLI step, completing the user experience

## Key Decisions

1. **Data flow: WebSocket relay** — Dashboard asks server, server asks local agent, local agent reads from disk and responds. No database.
2. **Auto-parse after recording** — When recording stops, local agent automatically triggers Claude-based workflow parsing. No manual CLI step.
3. **Workflow Library as a dashboard view** — Full canvas view (not sidebar expansion), accessed via the dock icon that currently exists but is misconfigured.
4. **Library card design: minimal** — Name + creation date. Details on click.
5. **Click behavior: expand details** — Clicking a workflow shows description, applications, step count, and a functional Run button. Not immediate execution on click — user must explicitly press Run.
6. **Run button: fully wired** — The Run button in the detail view calls `runWorkflow()` from `workflowStore`, which already sends `dashboard_workflow_run` via WebSocket. No new execution logic needed.
7. **Persistence: local filesystem** — Workflows stay as JSON files in `local-agent/workflows/`. No cloud storage for V1.
8. **Disconnected state** — When local agent is not connected, Workflow Library shows an empty state message ("Connect your local agent to see workflows") with setup guidance.
9. **Processing feedback** — After recording stops, RecordView stays open showing "Processing your recording..." with a spinner until parsing completes, then transitions to "Workflow saved!". User stays on RecordView during the 10-30 second parse.
10. **Full recording wiring** — RecordView's handleStart/handleStop will send real WebSocket commands to the local agent (not just UI simulation). Complete end-to-end recording flow.
11. **Workflow deletion** — Users can delete workflows from the detail view with a confirmation dialog. Sends a delete command via WebSocket to remove the JSON file on the local agent.
12. **Parse failure handling** — If Claude API fails or times out during auto-parse, RecordView shows an error message ("Processing failed — recording saved, try again later"). The raw recording is preserved on disk; the user can retry parsing later.
13. **Server is pure relay** — The server does not store or cache workflow data. All new message types pass through unchanged between dashboard and local agent.

## Current State (What Exists)

### Working:
- Local agent recording system (event logging, frame capture, audio capture, manifest building)
- Workflow parser (`workflow-parser.ts`) — converts recordings to WorkflowDefinition via Claude
- 7 parsed workflow JSON files in `local-agent/workflows/`
- Dashboard RecordView UI (idle → recording → processing → complete states)
- WebSocket bridge (dashboard ↔ server ↔ local agent)
- `workflowStore.ts` Zustand store (currently holds mock data)

### Broken / Missing:
- Dashboard RecordView `handleStart()`/`handleStop()` are TODO stubs — no WebSocket commands sent
- No `list_workflows` or `get_workflow` WebSocket message types in shared/types.ts
- Workflow Library dock icon opens Settings instead of a library view (`SidebarDock.tsx` line 34)
- No WorkflowLibrary component exists
- No `workflow-library` route in App.tsx
- No auto-parse trigger after recording completes
- `workflowStore` uses hardcoded MOCK_WORKFLOWS, not real data
- Server `handleWorkflowRun()` uses workflow name as plain-text goal, doesn't load structured WorkflowDefinition

## New WebSocket Message Types Needed

```
Dashboard → Server → Local Agent:
- dashboard_start_recording { description: string }
- dashboard_stop_recording {}
- dashboard_list_workflows {}
- dashboard_get_workflow { workflowId: string }
- dashboard_delete_workflow { workflowId: string }

Local Agent → Server → Dashboard:
- agent_recording_started { sessionId: string }
- agent_recording_stopped { sessionId: string }
- agent_recording_parsing {}                          // Parsing started (show spinner)
- agent_workflow_parsed { workflow: WorkflowSummary }  // Parsing complete (show success)
- agent_workflow_list { workflows: WorkflowSummary[] }
- agent_workflow_detail { workflow: WorkflowDefinition }
- agent_workflow_deleted { workflowId: string }
```

## Components to Create / Modify

### New:
- `WorkflowLibrary/WorkflowLibraryView.tsx` — Main library canvas view
- `WorkflowLibrary/WorkflowCard.tsx` — Minimal card (name + date)
- `WorkflowLibrary/WorkflowDetail.tsx` — Expanded detail panel

### Modify:
- `shared/types.ts` — Add new WebSocket message types
- `dashboard/src/stores/workflowStore.ts` — Replace mock data with WebSocket-fetched data
- `dashboard/src/services/message-router.ts` — Handle new message types
- `dashboard/src/components/Record/RecordView.tsx` — Wire handleStart/handleStop to WebSocket
- `dashboard/src/components/Sidebar/SidebarDock.tsx` — Fix Workflow Library icon routing
- `dashboard/src/App.tsx` — Add workflow-library route
- `server/src/bridge.ts` — Relay new message types
- `local-agent/src/recorder/session-manager.ts` — Trigger auto-parse after stopSession()
- `local-agent` WebSocket handler — Respond to list_workflows / get_workflow requests

## Scope Boundaries

### In scope:
- Full WebSocket wiring for recording commands (start/stop) to local agent
- Auto-parse after recording with processing feedback in RecordView
- Parse failure error handling (show error, preserve raw recording)
- New WebSocket message types for workflow CRUD (list, get, delete)
- Workflow Library canvas view with minimal cards + detail expansion
- Functional Run button in detail view (uses existing `runWorkflow()`)
- Workflow deletion with confirmation dialog
- Fix dock icon routing + add route in App.tsx
- Empty state for disconnected local agent
- Replace mock workflow data with real WebSocket-fetched data

### Out of scope (future):
- Cloud database / multi-user workflow sharing
- Workflow editing / versioning
- Search / filter in library
- Recording playback / preview
- Department grouping in library
- Retry-parse UI for failed recordings

---

## Open Questions

_None — all key decisions resolved through brainstorming._
