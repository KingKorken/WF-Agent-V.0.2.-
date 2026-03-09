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
 *   - saveLearnedAction(action)              → persist a successful action (shell/cdp/ax)
 *   - getLearnedActionsForApp(app)            → lookup learned actions per app
 *   - getAllLearnedActions()                   → full list of learned actions
 *   - incrementActionUseCount(app,action)     → bump use count on reuse
 *   - removeLearnedActionsForApp(app)         → forget all actions for an app
 *   - buildLearnedActionsPromptSection()      → format learned actions for system prompt
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DiscoveryResult } from './discovery';
import type { SkillCommand } from '@workflow-agent/shared';

// Re-export so existing consumers keep working
export type { SkillCommand };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/** A successfully executed action the agent learned for an app. */
export interface LearnedAction {
  /** What type of action this is */
  type: 'shell' | 'cdp' | 'accessibility';
  /** The app this action was used with */
  app: string;
  /** What this action does (from agent's thinking) */
  description: string;
  /** When this was learned */
  learnedAt: string;
  /** How many times this action has been reused */
  useCount: number;

  // --- Shell-specific fields ---
  /** The full shell command (only for type === 'shell') */
  command?: string;

  // --- CDP-specific fields ---
  /** The page URL when this action was taken (only for type === 'cdp') */
  url?: string;
  /** The CDP action: navigate, click, type, select (only for type === 'cdp') */
  cdpAction?: string;
  /** The element's label text (durable across sessions, unlike refs) */
  elementLabel?: string;
  /** The element's role: button, input, link, etc. */
  elementRole?: string;
  /** Text that was typed (only for type/action) — NEVER save passwords */
  typedText?: string;

  // --- Accessibility-specific fields ---
  /** The accessibility action: press_button, set_value, menu_click */
  axAction?: string;
  /** Menu path for menu_click actions */
  menuPath?: string[];
  /** Value that was set (only for set_value) */
  setValue?: string;
}

/** @deprecated Use LearnedAction instead */
export type LearnedCommand = LearnedAction;

const MAX_ACTIONS_PER_APP = 50;

interface RegistryFile {
  skills: SkillEntry[];
  discovered?: DiscoveredApp[];
  learnedCommands?: LearnedAction[];  // JSON key unchanged for backward compat
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
let learnedCommands: LearnedAction[] = [];
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const data: RegistryFile = JSON.parse(raw);
    skills = data.skills || [];
    discovered = data.discovered || [];
    learnedCommands = data.learnedCommands || [];
  } catch {
    skills = [];
    discovered = [];
    learnedCommands = [];
  }
  loaded = true;
}

/** Write registry to disk using write-then-rename for safety. */
function persistRegistry(): void {
  const data: RegistryFile = { skills, discovered, learnedCommands };
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

// ---------------------------------------------------------------------------
// Learned action persistence
// ---------------------------------------------------------------------------

/**
 * Check if two actions match for deduplication purposes.
 * - Shell: same command string
 * - CDP: same url + cdpAction + elementLabel
 * - Accessibility: same app + axAction + elementLabel
 */
function actionsMatch(a: LearnedAction, b: LearnedAction): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'shell':
      return a.command === b.command;
    case 'cdp':
      return a.url === b.url && a.cdpAction === b.cdpAction && a.elementLabel === b.elementLabel;
    case 'accessibility':
      return a.axAction === b.axAction && a.elementLabel === b.elementLabel;
    default:
      return false;
  }
}

/**
 * Enforce the per-app action limit. When exceeding MAX_ACTIONS_PER_APP,
 * drops the oldest actions with the lowest useCount.
 */
function enforceActionLimit(appName: string): void {
  const lower = appName.toLowerCase();
  const appActions = learnedCommands.filter(c => c.app.toLowerCase() === lower);
  if (appActions.length <= MAX_ACTIONS_PER_APP) return;

  // Sort by useCount ascending, then by learnedAt ascending (oldest first)
  const sorted = [...appActions].sort((a, b) => {
    if (a.useCount !== b.useCount) return a.useCount - b.useCount;
    return a.learnedAt.localeCompare(b.learnedAt);
  });

  const toRemove = sorted.slice(0, appActions.length - MAX_ACTIONS_PER_APP);
  const removeSet = new Set(toRemove);
  learnedCommands = learnedCommands.filter(c => !removeSet.has(c));
}

/**
 * Save a learned action for an app. Deduplicates by action identity.
 * If a matching action already exists for that app, updates it instead.
 * Enforces MAX_ACTIONS_PER_APP limit.
 */
export function saveLearnedAction(action: LearnedAction): void {
  ensureLoaded();
  const lower = action.app.toLowerCase();
  const idx = learnedCommands.findIndex(
    c => c.app.toLowerCase() === lower && actionsMatch(c, action)
  );
  if (idx >= 0) {
    learnedCommands[idx].useCount += 1;
    learnedCommands[idx].learnedAt = action.learnedAt;
    if (action.description && action.description !== learnedCommands[idx].description) {
      learnedCommands[idx].description = action.description;
    }
  } else {
    learnedCommands.push(action);
    enforceActionLimit(action.app);
  }
  persistRegistry();
}

/** @deprecated Use saveLearnedAction instead */
export const saveLearnedCommand = saveLearnedAction;

/** Get all learned actions for an app (case-insensitive). */
export function getLearnedActionsForApp(appName: string): LearnedAction[] {
  ensureLoaded();
  const lower = appName.toLowerCase();
  return learnedCommands.filter(c => c.app.toLowerCase() === lower);
}

/** @deprecated Use getLearnedActionsForApp instead */
export const getLearnedCommandsForApp = getLearnedActionsForApp;

/** Get ALL learned actions across all apps. */
export function getAllLearnedActions(): LearnedAction[] {
  ensureLoaded();
  return [...learnedCommands];
}

/** @deprecated Use getAllLearnedActions instead */
export const getAllLearnedCommands = getAllLearnedActions;

/** Increment use count for a matching action. */
export function incrementActionUseCount(appName: string, action: LearnedAction): void {
  ensureLoaded();
  const lower = appName.toLowerCase();
  const entry = learnedCommands.find(
    c => c.app.toLowerCase() === lower && actionsMatch(c, action)
  );
  if (entry) {
    entry.useCount += 1;
    entry.learnedAt = new Date().toISOString();
    persistRegistry();
  }
}

/** @deprecated Use incrementActionUseCount instead */
export function incrementCommandUseCount(appName: string, command: string): void {
  incrementActionUseCount(appName, { type: 'shell', app: appName, command, description: '', learnedAt: '', useCount: 0 });
}

/** Remove all learned actions for an app (e.g. for testing / resetting). */
export function removeLearnedActionsForApp(appName: string): void {
  ensureLoaded();
  const lower = appName.toLowerCase();
  learnedCommands = learnedCommands.filter(c => c.app.toLowerCase() !== lower);
  persistRegistry();
}

/** @deprecated Use removeLearnedActionsForApp instead */
export const removeLearnedCommandsForApp = removeLearnedActionsForApp;

/** Format a single learned action as a prompt hint line. */
function formatActionForPrompt(action: LearnedAction): string {
  const useSuffix = action.useCount > 1 ? ` (used ${action.useCount}x)` : '';
  switch (action.type) {
    case 'shell':
      return `- ${action.description}: \`${action.command}\`${useSuffix}`;
    case 'cdp': {
      let detail = action.cdpAction || 'action';
      if (action.elementLabel) {
        detail += ` "${action.elementLabel}" [${action.elementRole || '?'}]`;
      }
      if (action.typedText) {
        // Never include password values in prompts
        const isSensitive = (action.elementLabel || '').toLowerCase().includes('password');
        detail += ` text="${isSensitive ? '***' : action.typedText}"`;
      }
      return `- ${action.description}: ${detail} on ${action.url || '?'}${useSuffix}`;
    }
    case 'accessibility': {
      let detail = action.axAction || 'action';
      if (action.elementLabel) {
        detail += ` "${action.elementLabel}"`;
      }
      if (action.menuPath && action.menuPath.length > 0) {
        detail += ` menu: ${action.menuPath.join(' > ')}`;
      }
      if (action.setValue) {
        detail += ` value="${action.setValue}"`;
      }
      return `- ${action.description}: ${detail}${useSuffix}`;
    }
    default:
      return `- ${action.description}${useSuffix}`;
  }
}

/**
 * Build the LEARNED ACTIONS section for the system prompt.
 * Lists previously successful actions grouped by app and type.
 */
export function buildLearnedActionsPromptSection(): string {
  ensureLoaded();
  if (learnedCommands.length === 0) return '';

  // Group by app
  const byApp: Record<string, LearnedAction[]> = {};
  for (const action of learnedCommands) {
    if (!byApp[action.app]) byApp[action.app] = [];
    byApp[action.app].push(action);
  }

  let out = `## LEARNED ACTIONS (previously successful — reuse these)

`;

  for (const [app, actions] of Object.entries(byApp)) {
    // Group by type within app
    const shellActions = actions.filter(a => a.type === 'shell');
    const cdpActions = actions.filter(a => a.type === 'cdp');
    const axActions = actions.filter(a => a.type === 'accessibility');

    if (shellActions.length > 0) {
      out += `### ${app} (shell):\n`;
      for (const a of shellActions) out += formatActionForPrompt(a) + '\n';
      out += '\n';
    }
    if (cdpActions.length > 0) {
      // Group CDP actions by domain
      const byDomain: Record<string, LearnedAction[]> = {};
      for (const a of cdpActions) {
        let domain = '?';
        try { domain = new URL(a.url || '').hostname; } catch { /* keep ? */ }
        if (!byDomain[domain]) byDomain[domain] = [];
        byDomain[domain].push(a);
      }
      for (const [domain, domainActions] of Object.entries(byDomain)) {
        out += `### ${app} — ${domain} (browser):\n`;
        for (const a of domainActions) out += formatActionForPrompt(a) + '\n';
        out += '\n';
      }
    }
    if (axActions.length > 0) {
      out += `### ${app} (desktop):\n`;
      for (const a of axActions) out += formatActionForPrompt(a) + '\n';
      out += '\n';
    }
  }

  return out;
}

/** @deprecated Use buildLearnedActionsPromptSection instead */
export const buildLearnedCommandsPromptSection = buildLearnedActionsPromptSection;
