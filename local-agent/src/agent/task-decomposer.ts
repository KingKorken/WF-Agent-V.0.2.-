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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubGoal {
  /** Unique ID (e.g. "sg_1", "sg_2") */
  id: string;
  /** Human-readable label shown in dashboard progress */
  label: string;
  /** Detailed instruction for the agent loop */
  description: string;
  /** Target application (e.g. "Microsoft Outlook", "Google Chrome") */
  app: string;
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
// Main export
// ---------------------------------------------------------------------------

/**
 * Decompose a goal into ordered sub-goals using LLM.
 *
 * @param goal - The full user goal (plan + original message + context)
 * @param conversationContext - Optional recent conversation for context
 */
export async function decomposeTask(
  goal: string,
  conversationContext?: string,
): Promise<TaskDecompositionResult> {
  log(`[task-decomposer] Decomposing goal: "${goal.substring(0, 100)}..."`);

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
