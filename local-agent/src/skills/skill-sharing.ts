/**
 * Skill Sharing — Upload, receive, and merge shared skills from the network.
 *
 * This module handles the agent side of the shared skill base:
 *   - Upload newly generated skills to the server (fire-and-forget)
 *   - Request all shared skills on startup (sync)
 *   - Handle broadcasts of new skills from other agents
 *   - Merge shared skills into the local registry
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  SharedSkillEntry,
  AgentSkillUpload,
  AgentSkillListRequest,
  ServerSkillListResult,
  ServerSkillBroadcast,
} from '@workflow-agent/shared';
import type { SkillEntry } from './registry';
import {
  getSkillForApp,
  registerSkill,
  SKILLS_DIR,
  SKILLS_DIST_DIR,
} from './registry';
import { log, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Send function provided by the WebSocket client */
let sendFn: ((msg: string) => void) | null = null;

/** Agent identifier for uploads */
let agentId: string = 'unknown';

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize skill sharing with a send function and agent identity.
 * Called once from websocket-client after connection is established.
 */
export function initSkillSharing(send: (msg: string) => void, agentName: string): void {
  sendFn = send;
  agentId = agentName;
  log('[skill-sharing] Initialized');
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload a newly generated skill to the shared skill base.
 * Called fire-and-forget after registerSkill() in generator.ts.
 */
export function uploadSkillToShared(
  entry: SkillEntry,
  sourceCode: string,
  compiledCode: string,
): void {
  if (!sendFn) {
    log('[skill-sharing] Cannot upload — not connected');
    return;
  }

  const sharedSkill: SharedSkillEntry = {
    id: crypto.randomUUID(),
    app: entry.app,
    aliases: entry.aliases,
    file: entry.file,
    runtime: entry.runtime,
    skillsDir: entry.skillsDir,
    commands: entry.commands,
    notes: entry.notes,
    compiledCode,
    sourceCode,
    uploadedAt: new Date().toISOString(),
    uploadedBy: agentId,
  };

  const msg: AgentSkillUpload = {
    type: 'agent_skill_upload',
    skill: sharedSkill,
  };

  sendFn(JSON.stringify(msg));
  log(`[skill-sharing] Uploaded skill for "${entry.app}" (${sharedSkill.id})`);
}

// ---------------------------------------------------------------------------
// Request all skills (startup sync)
// ---------------------------------------------------------------------------

/** Request the full shared skill list from the server */
export function requestAllSharedSkills(): void {
  if (!sendFn) {
    log('[skill-sharing] Cannot request skills — not connected');
    return;
  }

  const msg: AgentSkillListRequest = {
    type: 'agent_skill_list_request',
  };

  sendFn(JSON.stringify(msg));
  log('[skill-sharing] Requested shared skill list');
}

// ---------------------------------------------------------------------------
// Incoming message handlers
// ---------------------------------------------------------------------------

/** Handle a full skill list response from the server (startup sync) */
export function handleSkillListResult(msg: ServerSkillListResult): void {
  log(`[skill-sharing] Received ${msg.skills.length} shared skills`);

  let merged = 0;
  for (const shared of msg.skills) {
    if (mergeSharedSkill(shared)) {
      merged++;
    }
  }

  log(`[skill-sharing] Merged ${merged} new skills from shared base`);
}

/** Handle a broadcast of a single new skill from another agent */
export function handleSkillBroadcast(msg: ServerSkillBroadcast): void {
  log(`[skill-sharing] Broadcast received: "${msg.skill.app}" from ${msg.skill.uploadedBy}`);

  if (mergeSharedSkill(msg.skill)) {
    log(`[skill-sharing] Merged broadcast skill for "${msg.skill.app}"`);
  } else {
    log(`[skill-sharing] Skipped broadcast skill for "${msg.skill.app}" (already have local skill)`);
  }
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Merge a shared skill into the local registry.
 * Returns true if the skill was merged, false if skipped (local skill exists).
 *
 * Strategy: local skills always take precedence. If the agent already has a
 * skill for this app (whether locally generated or previously shared), skip.
 */
function mergeSharedSkill(shared: SharedSkillEntry): boolean {
  const existing = getSkillForApp(shared.app);
  if (existing) {
    return false;
  }

  try {
    // Write compiled JS to dist directory
    const distDir = SKILLS_DIST_DIR;
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    const distFile = path.join(distDir, shared.file.replace(/\.ts$/, '.js'));
    fs.writeFileSync(distFile, shared.compiledCode, 'utf-8');

    // Write TS source to skills directory (for debugging/re-generation)
    const srcDir = SKILLS_DIR;
    if (!fs.existsSync(srcDir)) {
      fs.mkdirSync(srcDir, { recursive: true });
    }
    const srcFile = path.join(srcDir, shared.file);
    fs.writeFileSync(srcFile, shared.sourceCode, 'utf-8');

    // Register in the local skill registry
    const entry: SkillEntry = {
      app: shared.app,
      aliases: shared.aliases,
      file: shared.file,
      runtime: shared.runtime,
      skillsDir: 'dist',
      commands: shared.commands,
      notes: `[shared] ${shared.notes}`,
      generated: true,
    };

    registerSkill(entry);
    return true;
  } catch (err) {
    logError(`[skill-sharing] Failed to merge skill for "${shared.app}": ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
