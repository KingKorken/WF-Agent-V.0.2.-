---
title: "Shared Skill Base — Network Learning via Bridge Server (Phase 1)"
date: 2026-03-09
category: integration-issues
component: agent/intelligence-layer
tags:
  - skill-sharing
  - bridge-server
  - websocket
  - network-learning
  - intelligence-layer
  - fly-io
  - persistence
severity: feature
status: implemented
related_files:
  - server/src/skill-repository.ts
  - server/src/bridge.ts
  - local-agent/src/skills/skill-sharing.ts
  - local-agent/src/skills/generator.ts
  - local-agent/src/skills/registry.ts
  - local-agent/src/connection/dashboard-message-handler.ts
  - local-agent/src/connection/websocket-client.ts
  - shared/types.ts
  - fly.toml
---

# Shared Skill Base — Network Learning (Phase 1)

## Problem

The WF-Agent intelligence layer generates reusable automation skills (JavaScript modules keyed by application name) on each local agent, but those skills remained siloed on the machine that created them. If one agent learned how to automate Asana, every other agent on the network had to independently discover and generate the same skill from scratch. There was no mechanism for sharing learned capabilities across the fleet of connected agents.

## Solution

Phase 1 of the Shared Skill Base introduces a network-learning loop over the existing WebSocket bridge infrastructure. When an agent generates a skill, it uploads it to the central bridge server. The server validates, stores, and broadcasts the skill to all other connected agents. On startup, each agent syncs the full skill catalog.

The implementation was scoped down from the original design (7 message types, 3 agent-side files, quality scoring, delta sync) to a simplified architecture (4 message types, 1 agent-side file) after a multi-agent review determined the initial plan was approximately 60% over-engineered for Phase 1.

## Architecture

### Shared Types (`shared/types.ts`)

- `SkillCommand` — moved from local-agent registry to the shared package for cross-package reuse
- `SharedSkillEntry` — full skill payload: identity (id, app, aliases), execution metadata (file, runtime, skillsDir, commands, notes), code (compiledCode, sourceCode), and provenance (uploadedAt, uploadedBy)
- 4 message types added to the `WebSocketMessage` discriminated union:
  - `AgentSkillUpload` — agent sends a newly generated skill
  - `AgentSkillListRequest` — agent requests the full catalog (no payload)
  - `ServerSkillListResult` — server responds with all skills
  - `ServerSkillBroadcast` — server pushes a new skill to all other agents

### Server: Skill Repository (`server/src/skill-repository.ts`, NEW)

In-memory `Map<string, SharedSkillEntry>` with JSON file persistence at `${DATA_DIR}/skill-base.json`.

- **Validation**: parseable JS via `new Function()`, under 50KB, non-empty app name
- **Deduplication**: one skill per app name (case-insensitive), latest upload replaces previous
- **Persistence**: 2-second trailing debounce, atomic write-then-rename (`writeFileSync` to `.tmp`, then `renameSync`)
- **Initialization**: `loadSkillsFromDisk()` called once from `main()`

### Server: Bridge Modifications (`server/src/bridge.ts`)

- Added skill message type strings to `KNOWN_MESSAGE_TYPES` Set
- Added `sendRawToAgent(raw: string)` method on Room class — sends pre-serialized strings to avoid double-stringify when broadcasting the same message to multiple rooms
- `agent_skill_upload` handler: validates via repository, on success serializes broadcast once and sends to all OTHER connected agents
- `agent_skill_list_request` handler: responds with `getAllSkills()` result
- Skills are **GLOBAL** (not per-room) — the broadcast loop iterates over all rooms for maximum network effect

### Local Agent: Skill Sharing (`local-agent/src/skills/skill-sharing.ts`, NEW)

Single module (197 lines) handling all agent-side skill sharing:

- `initSkillSharing(send, agentName)` — stores WebSocket send function reference
- `uploadSkillToShared(entry, sourceCode, compiledCode)` — constructs SharedSkillEntry with new UUID, sends fire-and-forget
- `requestAllSharedSkills()` — sends list request on startup
- `handleSkillListResult(msg)` — iterates and merges missing skills
- `handleSkillBroadcast(msg)` — merges single broadcast skill
- `mergeSharedSkill(shared)` — **local skills always take precedence**; writes .js to dist dir, .ts to source dir, registers with `[shared]` notes prefix

### Local Agent: Integration Points

- **`generator.ts`**: after `registerSkill(entry)`, reads compiled JS from disk and calls `uploadSkillToShared()` in try/catch (fire-and-forget)
- **`registry.ts`**: `SkillCommand` now imported from `@workflow-agent/shared`, re-exported for backward compat
- **`dashboard-message-handler.ts`**: two new switch cases route `server_skill_broadcast` and `server_skill_list_result` to the skill-sharing module
- **`websocket-client.ts`**: on connection open, calls `initSkillSharing()` then `requestAllSharedSkills()` after sending the hello message

### Infrastructure (`fly.toml`)

- Added `[mounts]` section: `source = 'skill_data'`, `destination = '/data'`
- Added `DATA_DIR = '/data'` environment variable
- Volume created via: `fly volumes create skill_data --region fra --size 1 -a wfa-bridge`

## Data Flow

### Flow 1: Agent generates and shares a skill

1. `generator.ts` completes skill generation (compile + test pass)
2. `registerSkill(entry)` saves locally in `registry.json`
3. `uploadSkillToShared(entry, sourceCode, compiledCode)` sends `agent_skill_upload`
4. Bridge server validates, stores in Map, schedules debounced persist
5. Bridge server broadcasts `server_skill_broadcast` to all other agents
6. Each receiving agent's `mergeSharedSkill()` writes files and registers locally

### Flow 2: Agent connects and syncs

1. WebSocket `on('open')` fires
2. Agent sends `hello`, then `agent_skill_list_request`
3. Server responds with `server_skill_list_result` containing all skills
4. Agent iterates and merges missing skills (skips existing local skills)

## Key Design Decisions

1. **Local skills always take precedence** — shared skills never overwrite locally generated ones
2. **Skills are GLOBAL, not per-room** — maximizes network learning effect across all agents
3. **Fire-and-forget upload** — no acknowledgment message, simplifies protocol
4. **Both .js and .ts shipped** — compiled code runs immediately, source preserved for debugging
5. **App-level deduplication** — one skill per app, latest upload wins
6. **Atomic persistence with debounce** — coalesces rapid uploads, prevents corruption
7. **Simplified from original plan** — 4 message types instead of 7, no quality scoring, no delta sync

## Files Changed

| File | Status | Change |
|------|--------|--------|
| `shared/types.ts` | Modified | `SkillCommand`, `SharedSkillEntry`, 4 message types, union entries |
| `server/src/skill-repository.ts` | New | In-memory Map + JSON persistence, validation, debounced writes |
| `server/src/bridge.ts` | Modified | Imports, `sendRawToAgent()`, `loadSkillsFromDisk()`, 2 switch cases |
| `local-agent/src/skills/skill-sharing.ts` | New | Init, upload, request, handle list/broadcast, merge |
| `local-agent/src/skills/generator.ts` | Modified | Upload block after `registerSkill()` |
| `local-agent/src/skills/registry.ts` | Modified | `SkillCommand` imported from shared, re-exported |
| `local-agent/src/connection/dashboard-message-handler.ts` | Modified | 2 switch cases for skill messages |
| `local-agent/src/connection/websocket-client.ts` | Modified | `initSkillSharing()` + `requestAllSharedSkills()` on open |
| `fly.toml` | Modified | `[mounts]` section, `DATA_DIR` env var |

## Known Limitations

- **No quality gate on propagation.** A skill that passes validation (parseable JS, under 50KB) but behaves incorrectly at runtime will propagate to all agents. Recovery requires uploading a corrected version.
- **No versioning or conflict resolution.** Skills are keyed by app name with last-write-wins semantics. No version history, no merge, no rollback.
- **Sync payload scales linearly.** The full skill set is sent as a single WebSocket message. With the 5MB maxPayload, this hits a wall at ~500-600 skills. Not a near-term risk at current scale (~20 skills).

## Deferred to Phase 2/3

- **Learned action and discovery sharing** — only skills (generated code) are shared, not lighter-weight learned actions
- **Quality scoring** — no success/failure tracking, no confidence scores
- **Dangerous pattern scanning** — validation checks structure only, not behavior
- **Delta sync** — every connection does a full list sync, no incremental mechanism
- **Skill versioning** — store last N versions per app for rollback
- **Scoped namespaces** — per-team skill isolation for multi-tenant deployments
- **Skill signing** — cryptographic provenance verification

## Testing Guidance

### Unit Tests
- Valid skill passes validation; unparseable JS is rejected; 50KB boundary enforced; missing app name rejected
- App-level deduplication replaces (not appends) existing skill for same app
- Atomic write-then-rename: previous JSON survives simulated crash
- Local precedence: local skill shadows shared skill for same app

### Integration Tests
- End-to-end: Agent A uploads skill, Agent B receives broadcast and persists it
- Reconnect sync: Agent B disconnects, reconnects, receives skill via list sync
- Concurrent upload: two agents upload for same app simultaneously, server converges to one
- Payload boundary: generate skills until approaching 5MB, verify sync completes

### Manual Checklist
- [ ] Upload a skill via one agent, verify it appears in a second agent's registry
- [ ] Upload a replacement skill for the same app, verify old version is gone
- [ ] Kill bridge server mid-upload, restart, verify `skill-base.json` is not corrupted
- [ ] Start agent with no network, verify it operates on local skills without errors
- [ ] Upload valid-but-broken skill (wrong selectors), verify receiving agents don't crash on receipt

## Related Documentation

- [Intelligence Layer Brief](../briefs/intelligence-layer-brief.md) — full architecture overview, phasing, security, testing strategy
- [Shared Skill Base Brainstorm](../brainstorms/2026-03-08-shared-skill-base-network-learning-brainstorm.md) — problem/vision, 10 key decisions, WebSocket protocol design
- [Shared Skill Base Plan](../plans/2026-03-08-feat-shared-skill-base-network-learning-plan.md) — detailed 8-phase implementation roadmap (implementation followed simplified Phase 1)
- [Bridge Server Deployment](../../connection/solutions/bridge-server-websocket-production-deployment.md) — Fly.io deployment, WebSocket routing, room-based isolation
- [Product Context](../../product-context.md) — 5-layer control system, skill system role in Layer 1
