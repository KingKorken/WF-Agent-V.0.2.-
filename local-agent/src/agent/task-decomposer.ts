/**
 * Task Decomposer — Break a user goal into ordered sub-goals.
 *
 * Called by the agent loop after the classifier flags a task as multi-step.
 * Uses Sonnet to decompose a free-form goal into a sequence of SubGoal
 * objects that the two-level loop can iterate over.
 *
 * Design notes (from technical review):
 *   - SubGoal IDs are plain strings with "sg_" prefix (no branded type)
 *   - No fallbackGoal — caller has the original goal and degrades to flat loop
 *   - Result is a discriminated union { ok: true } | { ok: false }
 *   - This is a callable module: the agent can re-decompose mid-execution
 */

import { initLLMClient, sendMessageWithMeta } from './llm-client';
import type { ConversationMessage } from './llm-client';
import { log, error as logError } from '../utils/logger';
import { getSkillForApp, resolveSkillPath } from '../skills/registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillCommandRef {
  /** Skill runtime (e.g. "node", "python3") */
  runtime: string;
  /** Full path to the skill file */
  skillPath: string;
  /** Command name (e.g. "send-email") */
  command: string;
  /** Extracted arguments (e.g. ["--to", "foo@bar.com", "--subject", "Hello"]) */
  args: string[];
}

export interface SubGoal {
  /** Unique ID (e.g. "sg_1", "sg_2") */
  id: string;
  /** Human-readable label shown in dashboard progress */
  label: string;
  /** Detailed instruction for the agent loop */
  description: string;
  /** Target application (e.g. "Microsoft Outlook", "Google Chrome") */
  app: string;
  /** If set, this sub-goal should be executed as a direct skill command */
  skillCommand?: SkillCommandRef;
}

export type TaskDecompositionResult =
  | { ok: true; subGoals: SubGoal[] }
  | { ok: false; error: string };

/** Sub-goal outcome tracked in the agent loop result */
export type SubGoalOutcome = 'complete' | 'stuck' | 'cancelled' | 'not_started';

export interface SubGoalResult {
  subGoal: SubGoal;
  outcome: SubGoalOutcome;
}

// ---------------------------------------------------------------------------
// Decomposition prompt
// ---------------------------------------------------------------------------

const DECOMPOSITION_PROMPT = `You are a task decomposition engine for a desktop automation agent. Given a user's goal, break it into a sequence of ordered sub-goals.

Each sub-goal should be:
- A SINGLE logical milestone (e.g. "Open Outlook", "Compose new email", "Fill in recipients")
- Verifiable — the agent can tell when it's done
- Scoped to ONE application at a time

Rules:
- Keep sub-goals high-level (3-8 sub-goals for most tasks)
- Each sub-goal should take 1-5 agent iterations to complete
- Include the target application name for each sub-goal
- Order matters — sub-goals execute sequentially
- The first sub-goal should handle getting to the right app/context
- The last sub-goal should verify the task completed

Respond with ONLY a JSON array, no other text:
[
  { "label": "Short dashboard label", "description": "Detailed instruction for the agent", "app": "App Name" },
  ...
]`;

// ---------------------------------------------------------------------------
// Skill pre-check — bypass Claude decomposition if a skill matches
// ---------------------------------------------------------------------------

/** Map of goal keywords to app names for skill lookup. */
const APP_KEYWORDS: Record<string, string> = {
  'email': 'Microsoft Outlook',
  'e-mail': 'Microsoft Outlook',
  'outlook': 'Microsoft Outlook',
  'inbox': 'Microsoft Outlook',
  'mail': 'Microsoft Outlook',
  'spreadsheet': 'Microsoft Excel',
  'excel': 'Microsoft Excel',
  'xlsx': 'Microsoft Excel',
  'csv': 'Microsoft Excel',
  'document': 'Microsoft Word',
  'word': 'Microsoft Word',
  'docx': 'Microsoft Word',
};

/** Map of goal patterns to skill command names. */
const COMMAND_PATTERNS: Array<{ pattern: RegExp; command: string }> = [
  { pattern: /send\s+(?:an?\s+)?(?:email|e-mail|mail)/i, command: 'send-email' },
  { pattern: /read\s+(?:my\s+)?(?:inbox|emails?|mail)/i, command: 'read-inbox' },
  { pattern: /search\s+(?:my\s+)?(?:emails?|mail|inbox)/i, command: 'search-emails' },
  { pattern: /list\s+(?:mail\s+)?folders/i, command: 'list-folders' },
];

/**
 * Extract arguments from goal text using simple regex patterns.
 * Returns an array of CLI-style arguments (e.g. ["--to", "foo@bar.com"]).
 */
function extractArgsFromGoal(goal: string, command: string): string[] {
  const args: string[] = [];

  if (command === 'send-email') {
    const toMatch = goal.match(/(?:to|recipient)\s+(\S+@\S+)/i);
    if (toMatch) { args.push('--to', toMatch[1]); }

    const subjectMatch = goal.match(/(?:subject|about|re:?)\s+"([^"]+)"/i);
    if (subjectMatch) { args.push('--subject', subjectMatch[1]); }

    const bodyMatch = goal.match(/(?:body|saying|message|text)\s+"([^"]+)"/i);
    if (bodyMatch) { args.push('--body', bodyMatch[1]); }
  }

  if (command === 'search-emails') {
    const queryMatch = goal.match(/(?:search|find|look for)\s+(?:emails?\s+)?(?:about|for|with|containing)\s+"?([^"]+)"?/i);
    if (queryMatch) { args.push('--query', queryMatch[1].trim()); }
  }

  return args;
}

/**
 * Try to match the goal to a registered skill command.
 * Returns a single-sub-goal decomposition if matched, null otherwise.
 */
function trySkillMatch(goal: string): TaskDecompositionResult | null {
  const lowerGoal = goal.toLowerCase();

  // Find target app from keywords
  let targetApp: string | null = null;
  for (const [keyword, app] of Object.entries(APP_KEYWORDS)) {
    if (lowerGoal.includes(keyword)) {
      targetApp = app;
      break;
    }
  }
  if (!targetApp) return null;

  // Look up skill for this app
  const skill = getSkillForApp(targetApp);
  if (!skill) return null;

  // Try to match a specific command
  for (const { pattern, command } of COMMAND_PATTERNS) {
    if (!pattern.test(goal)) continue;

    // Verify this skill actually has this command
    const skillCmd = skill.commands.find(c => c.name === command);
    if (!skillCmd) continue;

    const extractedArgs = extractArgsFromGoal(goal, command);

    // For send-email, require at least --to to be extracted
    if (command === 'send-email' && !extractedArgs.includes('--to')) {
      log('[task-decomposer] Skill match for send-email but could not extract --to. Falling back to Claude decomposition.');
      return null;
    }

    const skillPath = resolveSkillPath(skill);

    log(`[task-decomposer] Skill match: ${targetApp}/${command} (args: ${extractedArgs.join(' ')})`);

    return {
      ok: true,
      subGoals: [{
        id: 'sg_skill',
        label: skillCmd.description,
        description: goal,
        app: targetApp,
        skillCommand: {
          runtime: skill.runtime,
          skillPath,
          command,
          args: extractedArgs,
        },
      }],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Decompose a goal into ordered sub-goals using LLM.
 * Tries skill pre-check first — if a registered skill matches, skips Claude entirely.
 *
 * @param goal - The full user goal (plan + original message + context)
 * @param conversationContext - Optional recent conversation for context
 */
export async function decomposeTask(
  goal: string,
  conversationContext?: string,
): Promise<TaskDecompositionResult> {
  log(`[task-decomposer] Decomposing goal: "${goal.substring(0, 100)}..."`);

  // Pre-check: if a skill matches the goal, skip Claude decomposition entirely
  const skillMatch = trySkillMatch(goal);
  if (skillMatch) {
    log('[task-decomposer] Skill pre-check matched — skipping Claude decomposition');
    return skillMatch;
  }

  try {
    initLLMClient();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[task-decomposer] LLM init failed: ${msg}`);
    return { ok: false, error: `LLM initialization failed: ${msg}` };
  }

  const userContent = conversationContext
    ? `${conversationContext}\n\nGoal to decompose: ${goal}`
    : `Goal to decompose: ${goal}`;

  const messages: ConversationMessage[] = [
    { role: 'user', content: userContent },
  ];

  try {
    const response = await sendMessageWithMeta(DECOMPOSITION_PROMPT, messages, 2048);

    let text = response.text.trim();
    // Strip markdown code fences if the model wraps JSON in ```json ... ```
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    }

    const parsed = JSON.parse(text) as Array<{ label: string; description: string; app: string }>;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      logError('[task-decomposer] LLM returned empty or non-array');
      return { ok: false, error: 'Decomposition returned empty result' };
    }

    const subGoals: SubGoal[] = parsed.map((item, i) => ({
      id: `sg_${i + 1}`,
      label: item.label || `Step ${i + 1}`,
      description: item.description || item.label || '',
      app: item.app || 'Unknown',
    }));

    log(`[task-decomposer] Decomposed into ${subGoals.length} sub-goals: ${subGoals.map(g => g.label).join(', ')}`);

    return { ok: true, subGoals };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[task-decomposer] Decomposition failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
