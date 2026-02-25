/**
 * Workflow Parser — Converts a recording manifest into a structured WorkflowDefinition.
 *
 * Uses Claude to analyze the recorded events, narration, and frame references,
 * then produces an executable workflow plan with steps, variables, loops, and rules.
 *
 * This is a single-shot LLM call (not multi-turn). If the first response is
 * invalid JSON, retries once with a correction prompt. Saves the result to
 * both the session directory and local-agent/workflows/<id>.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log, error as logError } from '../utils/logger';
import { initLLMClient, sendMessage, resetConversation } from './llm-client';
import type { ConversationMessage } from './llm-client';
import type { WorkflowDefinition } from './workflow-types';
import type { SessionManifest, ManifestEntry } from '../recorder/manifest-builder';
import type { RecordedEvent } from '../recorder/event-logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Compiled JS at local-agent/dist/src/agent/workflow-parser.js
// Workflows dir at local-agent/workflows/
const WORKFLOWS_DIR = path.join(__dirname, '../../../workflows');

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse a recording session into a structured WorkflowDefinition.
 *
 * @param sessionDir - Absolute path to the session directory (contains manifest.json, events.json)
 * @returns The parsed WorkflowDefinition
 */
export async function parseRecordingToWorkflow(sessionDir: string): Promise<WorkflowDefinition> {
  // 1. Load the manifest
  const manifestPath = path.join(sessionDir, 'manifest.json');
  const eventsPath = path.join(sessionDir, 'events.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${sessionDir}`);
  }

  const manifest: SessionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const events: RecordedEvent[] = fs.existsSync(eventsPath)
    ? JSON.parse(fs.readFileSync(eventsPath, 'utf8'))
    : [];

  log(`[workflow-parser] Loaded manifest: ${manifest.id} (${events.length} events, ${manifest.entries.length} entries)`);

  // 2. Ensure LLM client is ready
  try {
    initLLMClient();
  } catch {
    // Already initialized — that's fine
  }
  resetConversation();

  // 3. Build the prompt
  const systemPrompt = buildParserSystemPrompt();
  const userPrompt = buildParserUserPrompt(manifest, events);

  // 4. Send to Claude
  log('[workflow-parser] Sending to Claude for analysis...');
  const messages: ConversationMessage[] = [
    { role: 'user', content: userPrompt },
  ];

  let responseText = await sendMessage(systemPrompt, messages);
  let workflow = tryParseWorkflow(responseText, manifest);

  // 5. Retry once if invalid
  if (!workflow) {
    log('[workflow-parser] First response was invalid JSON — retrying with correction...');
    messages.push({ role: 'assistant', content: responseText });
    messages.push({
      role: 'user',
      content: 'Your previous response was not valid JSON matching the WorkflowDefinition schema. '
        + 'Please return ONLY a valid JSON object with these required fields: '
        + 'id, name, description, createdFrom, createdAt, applications, variables, steps. '
        + 'No markdown fences, no explanation — just the JSON object.',
    });

    responseText = await sendMessage(systemPrompt, messages);
    workflow = tryParseWorkflow(responseText, manifest);

    if (!workflow) {
      throw new Error(
        `Failed to parse workflow after retry. Raw response:\n${responseText.substring(0, 500)}`
      );
    }
  }

  // 6. Save workflow
  // Save to session directory
  const sessionWorkflowPath = path.join(sessionDir, 'workflow.json');
  fs.writeFileSync(sessionWorkflowPath, JSON.stringify(workflow, null, 2), 'utf8');
  log(`[workflow-parser] Saved to ${sessionWorkflowPath}`);

  // Save to workflows directory
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const globalWorkflowPath = path.join(WORKFLOWS_DIR, `${workflow.id}.json`);
  fs.writeFileSync(globalWorkflowPath, JSON.stringify(workflow, null, 2), 'utf8');
  log(`[workflow-parser] Saved to ${globalWorkflowPath}`);

  return workflow;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildParserSystemPrompt(): string {
  return `You are a workflow analysis expert. You analyze recorded user interactions and produce structured workflow definitions.

Your task: Given a sequence of recorded events (clicks, typing, app switches, hotkeys, scrolling) with optional narration (from voice), produce a WorkflowDefinition JSON object.

Rules:
1. Group raw events into logical steps. Many clicks and keystrokes may be ONE logical step like "fill in the salary field" or "navigate to the employees page".
2. Identify which applications are used and assign the optimal control layer for each:
   - "shell" for launching/closing apps, file operations
   - "cdp" for web applications in a browser (best for structured web pages)
   - "accessibility" for native desktop apps (Excel, TextEdit, system dialogs)
   - "vision" as a last resort when elements can't be accessed programmatically
3. Detect variables — data that would change between executions (e.g., employee names, amounts, dates). Use {{variableName}} syntax in step params.
4. Detect loops — repetitive patterns over a set of items (e.g., processing each row in a spreadsheet).
5. Extract business rules from narration (e.g., "overtime is 1.5x after 40 hours").
6. Add verification descriptions for important steps (how to confirm the step succeeded).
7. Return ONLY valid JSON. No markdown fences. No explanation. Just the JSON object.

The JSON must match this schema:
{
  "id": "string (UUID)",
  "name": "string (short human-readable name)",
  "description": "string (what this workflow does)",
  "createdFrom": "string (sessionId)",
  "createdAt": "string (ISO timestamp)",
  "applications": [{ "name": "string", "type": "desktop|browser|system", "preferredLayer": "shell|cdp|accessibility|vision", "url?": "string" }],
  "variables": [{ "name": "string", "description": "string", "source": "string", "type": "string|number|date|boolean" }],
  "steps": [{ "id": "number", "description": "string", "application": "string", "layer": "shell|cdp|accessibility|vision", "action": "string", "params": {}, "output?": "string", "verification?": "string", "fallbackLayer?": "string" }],
  "loops?": { "over": "string", "source": "string", "variable": "string", "stepsInLoop": [number] },
  "rules?": [{ "condition": "string", "action": "string", "source": "string" }]
}`;
}

function buildParserUserPrompt(manifest: SessionManifest, events: RecordedEvent[]): string {
  const parts: string[] = [];

  // Header
  parts.push(`Analyze this recorded workflow session and produce a WorkflowDefinition JSON.`);
  parts.push('');

  // Session info
  parts.push(`Session ID: ${manifest.id}`);
  parts.push(`Description: ${manifest.description}`);
  parts.push(`Duration: ${Math.round(manifest.durationMs / 1000)}s`);
  parts.push(`Start: ${manifest.startTime}`);
  parts.push(`End: ${manifest.endTime}`);
  parts.push(`Total events: ${manifest.eventCount}`);
  parts.push(`Total frames: ${manifest.frameCount}`);
  parts.push('');

  // Event sequence
  parts.push('--- EVENT SEQUENCE ---');
  for (const ev of events) {
    parts.push(formatEvent(ev));
  }
  parts.push('');

  // Manifest entries with narration
  const narrated = manifest.entries.filter((e: ManifestEntry) => e.narration);
  if (narrated.length > 0) {
    parts.push('--- NARRATION (voice transcript aligned to events) ---');
    for (const entry of narrated) {
      const ev = entry.event;
      const timeStr = `t=${ev.relativeMs}ms`;
      parts.push(`[${timeStr}] "${entry.narration}" (during ${ev.type} event)`);
    }
    parts.push('');
  }

  // Frame references (not sending images, just noting what frames exist)
  if (manifest.frameCount > 0) {
    parts.push('--- FRAMES (screenshots captured at these timestamps) ---');
    const frameTimes: string[] = [];
    for (const entry of manifest.entries) {
      if (entry.frame) {
        frameTimes.push(`${entry.event.relativeMs}ms: ${entry.frame}`);
      }
    }
    // Deduplicate
    const unique = [...new Set(frameTimes)];
    for (const ft of unique.slice(0, 50)) { // cap at 50 to avoid huge prompts
      parts.push(ft);
    }
    if (unique.length > 50) {
      parts.push(`... and ${unique.length - 50} more frames`);
    }
    parts.push('');
  }

  parts.push('--- END OF RECORDING DATA ---');
  parts.push('');
  parts.push('Now produce the WorkflowDefinition JSON. Remember: ONLY valid JSON, no markdown fences.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

function formatEvent(ev: RecordedEvent): string {
  const t = `t=${ev.relativeMs}ms`;
  switch (ev.type) {
    case 'click':
      return `[${t}] CLICK ${ev.button} at (${ev.x}, ${ev.y})`;
    case 'doubleclick':
      return `[${t}] DOUBLE-CLICK at (${ev.x}, ${ev.y})`;
    case 'typing':
      return `[${t}] TYPED "${ev.text}" (${ev.keyCount} keys, ${ev.endTime - ev.startTime}ms burst)`;
    case 'hotkey':
      return `[${t}] HOTKEY ${ev.keys.join('+')}`;
    case 'scroll':
      return `[${t}] SCROLL at (${ev.x}, ${ev.y}) deltaY=${ev.deltaY}`;
    case 'app_switch':
      return `[${t}] APP_SWITCH "${ev.fromApp}" → "${ev.toApp}"`;
    case 'window_focus':
      return `[${t}] WINDOW_FOCUS "${ev.app}" — "${ev.title}"`;
    default:
      return `[${t}] UNKNOWN EVENT`;
  }
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * Try to parse Claude's response as a WorkflowDefinition.
 * Returns the workflow on success, null on failure.
 */
function tryParseWorkflow(
  responseText: string,
  manifest: SessionManifest
): WorkflowDefinition | null {
  // Strip markdown fences if present
  let text = responseText.trim();
  if (text.startsWith('```')) {
    const firstNewline = text.indexOf('\n');
    text = text.substring(firstNewline + 1);
    const lastFence = text.lastIndexOf('```');
    if (lastFence >= 0) {
      text = text.substring(0, lastFence);
    }
    text = text.trim();
  }

  try {
    const parsed = JSON.parse(text) as WorkflowDefinition;

    // Validate required fields
    if (!parsed.name || !parsed.steps || !Array.isArray(parsed.steps)) {
      log('[workflow-parser] Response missing required fields (name, steps)');
      return null;
    }

    // Ensure ID and metadata
    if (!parsed.id) {
      parsed.id = crypto.randomUUID();
    }
    if (!parsed.createdFrom) {
      parsed.createdFrom = manifest.id;
    }
    if (!parsed.createdAt) {
      parsed.createdAt = new Date().toISOString();
    }
    if (!parsed.description) {
      parsed.description = manifest.description || 'Parsed workflow';
    }
    if (!parsed.applications) {
      parsed.applications = [];
    }
    if (!parsed.variables) {
      parsed.variables = [];
    }

    return parsed;
  } catch (err) {
    log(`[workflow-parser] JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
