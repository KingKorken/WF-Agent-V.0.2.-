/**
 * Skill Repository — Persistent global store for shared skills.
 *
 * Stores skills in an in-memory Map keyed by ID, with JSON file persistence
 * on the Fly.io persistent volume. Uses debounced writes and atomic
 * write-then-rename to avoid corruption.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SharedSkillEntry } from '@workflow-agent/shared';

/** Directory for persistent data (Fly.io volume mount or local fallback) */
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');

/** Path to the JSON persistence file */
const SKILL_FILE = path.join(DATA_DIR, 'skill-base.json');

/** Maximum skill code size: 50 KB */
const MAX_SKILL_SIZE = 50 * 1024;

/** Debounce interval for disk writes (ms) */
const PERSIST_DEBOUNCE_MS = 2000;

/** In-memory skill store: id → SharedSkillEntry */
const skills = new Map<string, SharedSkillEntry>();

/** Pending debounce timer for persistence */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/** Load skills from disk on startup. Creates the data directory if needed. */
export function loadSkillsFromDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(SKILL_FILE)) {
      console.log('[skill-repo] No existing skill-base.json — starting fresh');
      return;
    }

    const raw = fs.readFileSync(SKILL_FILE, 'utf-8');
    const entries: SharedSkillEntry[] = JSON.parse(raw);

    for (const entry of entries) {
      skills.set(entry.id, entry);
    }

    console.log(`[skill-repo] Loaded ${skills.size} skills from disk`);
  } catch (err) {
    console.error(`[skill-repo] Failed to load skills: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Upload (or replace) a skill in the repository.
 * Validates the skill before storing. Returns the stored entry on success.
 */
export function uploadSkill(skill: SharedSkillEntry): { ok: true; skill: SharedSkillEntry } | { ok: false; error: string } {
  const validationError = validateSkill(skill);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  // Check for existing skill for the same app — replace it
  for (const [existingId, existing] of skills) {
    if (existing.app.toLowerCase() === skill.app.toLowerCase() && existingId !== skill.id) {
      skills.delete(existingId);
      console.log(`[skill-repo] Replacing existing skill for "${skill.app}" (${existingId} → ${skill.id})`);
      break;
    }
  }

  skills.set(skill.id, skill);
  console.log(`[skill-repo] Stored skill: ${skill.id} (${skill.app})`);
  schedulePersist();

  return { ok: true, skill };
}

/** Get all skills as an array */
export function getAllSkills(): SharedSkillEntry[] {
  return Array.from(skills.values());
}

/** Get a single skill by ID */
export function getSkillById(id: string): SharedSkillEntry | undefined {
  return skills.get(id);
}

/** Get current skill count */
export function getSkillCount(): number {
  return skills.size;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns an error message if the skill is invalid, or null if valid */
function validateSkill(skill: SharedSkillEntry): string | null {
  if (!skill.id || typeof skill.id !== 'string') {
    return 'Missing or invalid skill ID';
  }
  if (!skill.app || typeof skill.app !== 'string') {
    return 'Missing or invalid app name';
  }
  if (!skill.compiledCode || typeof skill.compiledCode !== 'string') {
    return 'Missing compiled code';
  }
  if (skill.compiledCode.length > MAX_SKILL_SIZE) {
    return `Compiled code exceeds ${MAX_SKILL_SIZE} bytes`;
  }
  if (skill.sourceCode && skill.sourceCode.length > MAX_SKILL_SIZE) {
    return `Source code exceeds ${MAX_SKILL_SIZE} bytes`;
  }

  // Basic sanity: code should be parseable JavaScript
  try {
    new Function(skill.compiledCode);
  } catch {
    return 'Compiled code is not valid JavaScript';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Persistence (debounced, atomic write-then-rename)
// ---------------------------------------------------------------------------

function schedulePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistToDisk();
  }, PERSIST_DEBOUNCE_MS);
}

function persistToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const data = JSON.stringify(getAllSkills(), null, 2);
    const tmpFile = SKILL_FILE + '.tmp';

    fs.writeFileSync(tmpFile, data, 'utf-8');
    fs.renameSync(tmpFile, SKILL_FILE);

    console.log(`[skill-repo] Persisted ${skills.size} skills to disk`);
  } catch (err) {
    console.error(`[skill-repo] Failed to persist: ${err instanceof Error ? err.message : String(err)}`);
  }
}
