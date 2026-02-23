/**
 * Action History — Circular buffer tracking recent vision actions.
 *
 * Provides context to the LLM about what just happened, enabling
 * smarter decisions. The last 10 actions are kept in memory.
 */

import { log } from '../../utils/logger';

interface ActionRecord {
  action: string;
  result: string;
  timestamp: string;
}

/** In-memory circular buffer — last 10 actions */
const history: ActionRecord[] = [];
const MAX_HISTORY = 10;

/**
 * Record a completed action in the history buffer.
 * Called by vision-actions.ts after every action.
 */
export function recordAction(action: string, result: string): void {
  const record: ActionRecord = {
    action,
    result,
    timestamp: new Date().toISOString(),
  };
  history.push(record);
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
  log(`[action-history] Recorded: ${action} → ${result} (${history.length} in buffer)`);
}

/**
 * Get the most recent actions (default: last 5).
 * Used by context-collector.ts to include in VisionContext.
 */
export function getRecentActions(count: number = 5): ActionRecord[] {
  return history.slice(-count);
}

/**
 * Clear all action history. Useful for testing.
 */
export function clearHistory(): void {
  history.length = 0;
  log('[action-history] History cleared');
}
