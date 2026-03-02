/**
 * Skill Registry — Dynamic catalog of all agent skills.
 *
 * Loads skills from registry.json and provides:
 *   - getSkillForApp(appName)      → lookup by app name or alias
 *   - getAllSkills()                → full list
 *   - buildSkillPromptSection()    → formatted text for the system prompt
 *   - registerSkill(entry)         → add a new skill and persist to disk
 *   - getDiscoveredApp(appName)    → lookup discovered (non-skill) apps
 *   - saveDiscovery(result)        → persist discovery results
 *   - removeDiscovery(appName)     → remove a discovered app (promoted to skill)
 *   - buildDiscoveredAppsPromptSection() → format discovered apps for system prompt
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DiscoveryResult } from './discovery';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillCommand {
  name: string;
  args: string;
  description: string;
}

export interface SkillEntry {
  app: string;
  aliases: string[];
  file: string;
  runtime: string;
  /** "source" → SKILLS_DIR (Python source), "dist" → SKILLS_DIST_DIR (compiled TS) */
  skillsDir: 'source' | 'dist';
  commands: SkillCommand[];
  notes: string;
  generated: boolean;
}

/** A discovered app that doesn't have a full skill yet. */
export interface DiscoveredApp {
  app: string;
  appleScript: boolean;
  cli: boolean;
  cliPath?: string;
  api: boolean;
  apiUrl?: string;
  recommendation: string;
  discoveredAt: string;
}

interface RegistryFile {
  skills: SkillEntry[];
  discovered?: DiscoveredApp[];
}

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

/** Python skills — run from source (local-agent/src/skills/) */
export const SKILLS_DIR = path.resolve(__dirname, '../../../src/skills');

/** Compiled TypeScript skills (local-agent/dist/src/skills/) */
export const SKILLS_DIST_DIR = path.resolve(__dirname, '../../../dist/src/skills');

const REGISTRY_PATH = path.resolve(__dirname, '../../../src/skills/registry.json');

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

let skills: SkillEntry[] = [];
let discovered: DiscoveredApp[] = [];
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const data: RegistryFile = JSON.parse(raw);
    skills = data.skills || [];
    discovered = data.discovered || [];
  } catch {
    skills = [];
    discovered = [];
  }
  loaded = true;
}

/** Write registry to disk using write-then-rename for safety. */
function persistRegistry(): void {
  const data: RegistryFile = { skills, discovered };
  const tmpPath = REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, REGISTRY_PATH);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a skill by app name or alias (case-insensitive). */
export function getSkillForApp(appName: string): SkillEntry | null {
  ensureLoaded();
  const lower = appName.toLowerCase();
  return skills.find(s =>
    s.app.toLowerCase() === lower ||
    s.aliases.some(a => a.toLowerCase() === lower)
  ) || null;
}

/** Return all registered skills. */
export function getAllSkills(): SkillEntry[] {
  ensureLoaded();
  return [...skills];
}

/** Resolve the full filesystem path for a skill's executable. */
function resolveSkillPath(entry: SkillEntry): string {
  const base = entry.skillsDir === 'dist' ? SKILLS_DIST_DIR : SKILLS_DIR;
  return path.join(base, entry.file);
}

/**
 * Build the FILE SKILLS section for the system prompt.
 * Output format matches the original hardcoded prompt exactly.
 */
export function buildSkillPromptSection(): string {
  ensureLoaded();
  if (skills.length === 0) return '';

  let out = `## FILE SKILLS (Layer 1 — highest priority, use these FIRST)

You have file skills that let you interact with applications DIRECTLY without opening them or using UI automation. These are faster, more reliable, and more accurate. ALWAYS prefer these over UI automation when a skill exists.

`;

  for (const skill of skills) {
    const skillPath = resolveSkillPath(skill);
    out += `### ${skill.app} Skill:\n`;

    for (const cmd of skill.commands) {
      const args = cmd.args ? ` ${cmd.args}` : '';
      out += `- ${cmd.description}: shell/exec → ${skill.runtime} ${skillPath} ${cmd.name}${args}\n`;
    }

    out += `\n${skill.notes}\n\n`;
  }

  return out;
}

/**
 * Add a new skill to the registry and persist to disk.
 * If a skill for the same app already exists, it is replaced.
 * If the app was in the discovered list, it is removed (promoted to full skill).
 */
export function registerSkill(entry: SkillEntry): void {
  ensureLoaded();

  // Replace existing skill for the same app, or append
  const idx = skills.findIndex(s => s.app.toLowerCase() === entry.app.toLowerCase());
  if (idx >= 0) {
    skills[idx] = entry;
  } else {
    skills.push(entry);
  }

  // Remove from discovered (promoted to full skill)
  removeDiscovery(entry.app);

  persistRegistry();
}

// ---------------------------------------------------------------------------
// Discovery persistence
// ---------------------------------------------------------------------------

/** Look up a previously discovered app (case-insensitive). */
export function getDiscoveredApp(appName: string): DiscoveredApp | null {
  ensureLoaded();
  const lower = appName.toLowerCase();
  return discovered.find(d => d.app.toLowerCase() === lower) || null;
}

/** Return all discovered apps. */
export function getAllDiscovered(): DiscoveredApp[] {
  ensureLoaded();
  return [...discovered];
}

/**
 * Save a discovery result to the registry.
 * Converts from DiscoveryResult to the persisted DiscoveredApp format.
 * If this app was already discovered, it is replaced with fresh data.
 */
export function saveDiscovery(result: DiscoveryResult): void {
  ensureLoaded();

  const entry: DiscoveredApp = {
    app: result.app,
    appleScript: result.appleScript.supported,
    cli: result.cli.found,
    cliPath: result.cli.path,
    api: result.knownApi.hasApi,
    apiUrl: result.knownApi.docsUrl,
    recommendation: result.recommendation,
    discoveredAt: new Date().toISOString(),
  };

  const idx = discovered.findIndex(d => d.app.toLowerCase() === entry.app.toLowerCase());
  if (idx >= 0) {
    discovered[idx] = entry;
  } else {
    discovered.push(entry);
  }

  persistRegistry();
}

/** Remove a discovered app (e.g. when promoted to a full skill). */
export function removeDiscovery(appName: string): void {
  ensureLoaded();
  const lower = appName.toLowerCase();
  discovered = discovered.filter(d => d.app.toLowerCase() !== lower);
  // Note: persistRegistry() is NOT called here — caller is responsible
  // (registerSkill calls it after removing + adding the skill)
}

/**
 * Build the DISCOVERED APPS section for the system prompt.
 * Tells the agent about apps that were probed but don't have full skills yet.
 */
export function buildDiscoveredAppsPromptSection(): string {
  ensureLoaded();
  if (discovered.length === 0) return '';

  let out = `## DISCOVERED APPS (no skill yet — use vision/accessibility or request skill generation)

`;

  for (const d of discovered) {
    const interfaces: string[] = [];
    if (d.appleScript) interfaces.push('AppleScript');
    if (d.cli) interfaces.push(`CLI (${d.cliPath})`);
    if (d.api) interfaces.push(`API (${d.apiUrl})`);

    if (interfaces.length > 0) {
      out += `- ${d.app}: has ${interfaces.join(', ')} — a skill could be generated\n`;
    } else {
      out += `- ${d.app}: no automation interfaces found — vision/accessibility only\n`;
    }
  }

  out += '\n';
  return out;
}
