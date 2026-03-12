/**
 * Agent Loop — The core observe-decide-act cycle.
 *
 * Extracted from test-server.ts so it can be used by both the CLI test server
 * and the production Electron app. The loop is decoupled from I/O:
 *
 *   - Command execution is injected via SendAndWait (caller provides the transport)
 *   - Progress is reported via AgentLoopCallbacks (caller decides how to display)
 *   - Returns a structured AgentLoopResult when done
 *
 * Usage:
 *   const result = await runAgentLoop({
 *     goal: "Do my payroll",
 *     sendAndWait: myCommandExecutor,
 *     callbacks: { onStep, onAction, onComplete, ... }
 *   });
 */

import { execFile } from 'child_process';
import { AgentCommand, AgentResult } from '@workflow-agent/shared';
import { initLLMClient, sendMessage, resetConversation } from './llm-client';
import type { ConversationMessage } from './llm-client';
import { observe } from './observer';
import type { Observation, ObserveOptions } from './observer';
import { buildSystemPrompt, formatObservation } from './prompt-builder';
import { parseResponse } from './response-parser';
import type { ParsedResponse } from './response-parser';
import { log } from '../utils/logger';
import {
  getSkillForApp,
  getDiscoveredApp,
  getLearnedActionsForApp,
  saveLearnedAction,
  incrementActionUseCount,
} from '../skills/registry';
import type { LearnedAction } from '../skills/registry';
import { discoverAppCapabilities } from '../skills/discovery';
import type { DiscoveryResult } from '../skills/discovery';
import { decomposeTask } from './task-decomposer';
import type { SubGoal, SubGoalResult, SubGoalOutcome, SkillCommandRef } from './task-decomposer';

// ---------------------------------------------------------------------------
// Learned action helpers
// ---------------------------------------------------------------------------

/** Patterns that indicate a generic shell command (NOT app-specific). */
const GENERIC_COMMAND_PATTERNS = [
  /^\s*(find|ls|cat|head|tail|echo|mkdir|rmdir|rm|cp|mv|chmod|grep|awk|sed|wc|sort|uniq|curl|wget)\s/,
  /^\s*open\s/,
  /^\s*python3?\s+.*\/(excel-skill|word-skill)\.py\b/,
  /^\s*node\s+.*\/(outlook-skill|.*-skill)\.js\b/,
];

/**
 * Check if a shell command is app-specific (worth saving) vs generic.
 * Returns true for osascript commands and known CLI tool invocations.
 */
function isAppSpecificCommand(command: string): boolean {
  if (/osascript\s+-e\s+['"]tell\s+(application|app)\s/i.test(command)) return true;
  for (const pattern of GENERIC_COMMAND_PATTERNS) {
    if (pattern.test(command)) return false;
  }
  if (/^\/[\w/]+-/.test(command.trim())) return true;
  return false;
}

/**
 * Extract a short description from the agent's thinking text.
 * Takes the first sentence, max 100 chars.
 */
function extractDescription(thinking: string): string {
  if (!thinking) return 'Learned action';
  const firstSentence = thinking.split(/[.!?\n]/)[0].trim();
  if (firstSentence.length <= 100) return firstSentence;
  return firstSentence.substring(0, 97) + '...';
}

/** Format a learned action as a hint string for conversation injection. */
function formatActionHint(action: LearnedAction): string {
  switch (action.type) {
    case 'shell':
      return `shell/exec → ${action.command}`;
    case 'cdp':
      return `browser: ${action.cdpAction} ${action.elementLabel ? `"${action.elementLabel}"` : ''} on ${action.url}`;
    case 'accessibility':
      return `desktop: ${action.axAction} ${action.elementLabel ? `"${action.elementLabel}"` : ''}`;
    default:
      return action.description;
  }
}

/**
 * Capture a successful action as a learned action (shell, CDP, accessibility, or vision).
 * Only captures actions worth remembering across sessions.
 * Stores semantic descriptions, not raw pixel coordinates.
 */
function captureLearnedAction(
  parsed: ParsedResponse & { type: 'action' },
  observation: Observation,
  result: AgentResult
): void {
  const cmd = parsed.command;

  // --- Shell/exec: only app-specific commands ---
  if (cmd.layer === 'shell' && cmd.action === 'exec') {
    const command = cmd.params.command as string;
    if (!command || !isAppSpecificCommand(command)) return;
    if (result.data?.exitCode !== 0) return;

    const appName = observation.frontmostApp;
    const existing = getLearnedActionsForApp(appName)
      .find(a => a.type === 'shell' && a.command === command);
    if (existing) {
      incrementActionUseCount(appName, existing);
    } else {
      saveLearnedAction({
        type: 'shell',
        app: appName,
        command,
        description: extractDescription(parsed.thinking),
        learnedAt: new Date().toISOString(),
        useCount: 1,
      });
      log(`[agent-loop] Learned shell action for "${appName}": ${command.substring(0, 80)}`);
    }
    return;
  }

  // --- Shell/launch_app, shell/switch_app ---
  if (cmd.layer === 'shell' && (cmd.action === 'launch_app' || cmd.action === 'switch_app')) {
    const appName = (cmd.params.appName as string) || (cmd.params.app as string) || '';
    if (!appName) return;

    saveLearnedAction({
      type: 'shell',
      app: appName,
      command: cmd.action === 'launch_app' ? `open -a "${appName}"` : `osascript -e 'tell application "${appName}" to activate'`,
      description: cmd.action === 'launch_app' ? `Launch ${appName}` : `Switch to ${appName}`,
      learnedAt: new Date().toISOString(),
      useCount: 1,
    });
    log(`[agent-loop] Learned ${cmd.action} for "${appName}"`);
    return;
  }

  // --- CDP: save navigate, click, type, select ---
  if (cmd.layer === 'cdp' && ['click', 'type', 'select', 'navigate'].includes(cmd.action)) {
    const url = observation.browserPage?.url || '';

    // Resolve element label from ref
    let elementLabel = '';
    let elementRole = '';
    const ref = cmd.params.ref as string;
    if (ref && observation.browserElements) {
      const el = observation.browserElements.find(e => e.ref === ref);
      if (el) {
        elementLabel = el.label;
        elementRole = el.role;
      }
    }

    // Don't save if we couldn't resolve the element (except for navigate)
    if (cmd.action !== 'navigate' && !elementLabel) return;

    // NEVER save passwords
    let typedText = cmd.params.text as string | undefined;
    if (typedText && elementLabel.toLowerCase().includes('password')) {
      typedText = undefined;
    }

    saveLearnedAction({
      type: 'cdp',
      app: observation.frontmostApp,
      url,
      cdpAction: cmd.action,
      elementLabel: cmd.action === 'navigate' ? (cmd.params.url as string) : elementLabel,
      elementRole,
      typedText,
      description: extractDescription(parsed.thinking),
      learnedAt: new Date().toISOString(),
      useCount: 1,
    });
    return;
  }

  // --- Accessibility: save press_button, set_value, menu_click ---
  if (cmd.layer === 'accessibility' && ['press_button', 'set_value', 'menu_click'].includes(cmd.action)) {
    let elementLabel = '';
    const ref = cmd.params.ref as string;
    if (ref && observation.desktopElements) {
      const el = observation.desktopElements.find(e => e.ref === ref);
      if (el) {
        elementLabel = el.label;
      }
    }

    saveLearnedAction({
      type: 'accessibility',
      app: observation.frontmostApp,
      axAction: cmd.action,
      elementLabel: elementLabel || cmd.params.label as string || '',
      menuPath: cmd.params.menuPath as string[] | undefined,
      setValue: cmd.action === 'set_value' ? cmd.params.value as string : undefined,
      description: extractDescription(parsed.thinking),
      learnedAt: new Date().toISOString(),
      useCount: 1,
    });
    return;
  }

  // --- Vision: save click_coordinates, type_text, key_combo ---
  // Stores semantic descriptions only — NOT raw pixel coordinates (fragile across sessions)
  if (cmd.layer === 'vision' && ['click_coordinates', 'type_text', 'key_combo'].includes(cmd.action)) {
    const appName = observation.frontmostApp;
    const winTitle = observation.windowTitle || '';

    saveLearnedAction({
      type: 'vision',
      app: appName,
      visionAction: cmd.action,
      windowTitle: winTitle,
      keys: cmd.action === 'key_combo' ? (cmd.params.keys as string) : undefined,
      description: extractDescription(parsed.thinking),
      learnedAt: new Date().toISOString(),
      useCount: 1,
    });
    log(`[agent-loop] Learned vision/${cmd.action} for "${appName}": ${extractDescription(parsed.thinking).substring(0, 60)}`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Stuck detection helpers
// ---------------------------------------------------------------------------

interface ActionRecord {
  layer: string;
  action: string;
  keyParam: string;
  app: string;
  windowTitle: string;
}

const MAX_ACTION_HISTORY = 10;
const STUCK_THRESHOLD = 3;
const UNRELIABLE_THRESHOLD = 5;

/** Extract a simplified key parameter for action comparison. */
function extractKeyParam(cmd: AgentCommand): string {
  if (cmd.layer === 'shell' && cmd.action === 'exec') {
    return (cmd.params.command as string || '').substring(0, 100);
  }
  if (cmd.params.ref) return cmd.params.ref as string;
  if (cmd.params.url) return cmd.params.url as string;
  if (cmd.params.x && cmd.params.y) return `${cmd.params.x},${cmd.params.y}`;
  return JSON.stringify(cmd.params).substring(0, 50);
}

/**
 * Detect if the agent is stuck. Returns a description of the stuck pattern,
 * or null if not stuck.
 *
 * Two checks:
 * (C) Same action repeated — identical layer+action+keyParam 3+ times
 * (B) Same screen state — app + windowTitle unchanged for 3+ interactive actions
 */
function detectStuck(history: ActionRecord[], currentObs: Observation): string | null {
  if (history.length < 3) return null;

  const recent = history.slice(-3);

  // Check (C): Same action repeated 3 times
  const allSameAction = recent.every(r =>
    r.layer === recent[0].layer &&
    r.action === recent[0].action &&
    r.keyParam === recent[0].keyParam
  );
  if (allSameAction) {
    return `repeated ${recent[0].layer}/${recent[0].action} 3 times`;
  }

  // Check (B): Same screen state for 3 actions (app + window title unchanged)
  const allSameScreen = recent.every(r =>
    r.app === currentObs.frontmostApp &&
    r.windowTitle === (currentObs.windowTitle || '')
  );
  if (allSameScreen && !allSameAction) {
    const allInteractive = recent.every(r =>
      r.action !== 'screenshot' && r.action !== 'snapshot' && r.action !== 'collect_context'
    );
    if (allInteractive) {
      return `3 different actions on "${currentObs.frontmostApp}" with no screen change`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function that sends a command and waits for the result — injected by the caller */
export type SendAndWait = (command: AgentCommand) => Promise<AgentResult>;

/** Callbacks for reporting loop progress — all optional */
export interface AgentLoopCallbacks {
  /** Called at the start of each step with the step number and max iterations */
  onStep?: (step: number, maxIterations: number) => void;

  /** Called after observation is collected */
  onObservation?: (obs: Observation, step: number) => void;

  /** Called when the LLM is thinking */
  onThinking?: () => void;

  /** Called when the LLM returns a parsed response */
  onParsed?: (parsed: ParsedResponse, step: number) => void;

  /** Called when an action is about to be executed */
  onAction?: (command: AgentCommand, thinking: string) => void;

  /** Called after an action executes with its result */
  onActionResult?: (command: AgentCommand, result: AgentResult) => void;

  /** Called when the goal is achieved */
  onComplete?: (summary: string, steps: number) => void;

  /** Called when the agent needs help */
  onNeedsHelp?: (question: string) => void;

  /** Called on errors (observation, LLM, execution) */
  onError?: (error: string, context: string) => void;

  /** Called when task decomposition completes */
  onDecomposition?: (subGoals: SubGoal[]) => void;

  /** Called when a sub-goal begins execution */
  onSubGoalStart?: (subGoal: SubGoal, index: number, total: number) => void;

  /** Called when a sub-goal finishes (any outcome) */
  onSubGoalComplete?: (subGoal: SubGoal, index: number, total: number, outcome: SubGoalOutcome) => void;
}

/** Configuration for the agent loop */
export interface AgentLoopConfig {
  /** The goal to achieve */
  goal: string;

  /** Function to execute commands on the local agent */
  sendAndWait: SendAndWait;

  /** Optional callbacks for progress reporting */
  callbacks?: AgentLoopCallbacks;

  /** Max iterations before stopping (default: from env or 25) */
  maxIterations?: number;

  /** Delay between action and next observation in ms (default: 800) */
  settleDelayMs?: number;

  /** Whether to decompose the goal into sub-goals (default: false) */
  decompose?: boolean;

  /** Abort signal — check at top of each iteration to support cancel */
  signal?: { aborted: boolean };
}

/** Result of the agent loop */
export interface AgentLoopResult {
  /** How the loop ended */
  outcome: 'complete' | 'partial_complete' | 'needs_help' | 'max_iterations' | 'error' | 'cancelled' | 'skill_generation_needed';

  /** Summary (from LLM on complete, or error description) */
  summary: string;

  /** How many steps were taken */
  steps: number;

  /** The question asked (only for needs_help) */
  question?: string;

  /** The app that needs a skill (only for skill_generation_needed) */
  app?: string;

  /** Discovery results for the app (only for skill_generation_needed) */
  discovery?: DiscoveryResult;

  /** Per-sub-goal outcomes (only present when decomposition was used) */
  subGoalResults?: SubGoalResult[];
}

// ---------------------------------------------------------------------------
// Shell output formatting (needed for conversation feedback)
// ---------------------------------------------------------------------------

/**
 * Format shell output for inclusion in conversation history.
 * Keeps full text up to a limit; truncates with head+tail if too large.
 */
export function formatShellOutput(output: string): string {
  const MAX_SHELL_OUTPUT = 4000;
  if (!output || output.length === 0) return '(empty output)';
  if (output.length <= MAX_SHELL_OUTPUT) return output;
  const half = MAX_SHELL_OUTPUT / 2;
  const head = output.substring(0, half);
  const tail = output.substring(output.length - half);
  return `${head}\n\n... [${output.length - MAX_SHELL_OUTPUT} chars truncated] ...\n\n${tail}`;
}

/**
 * Create a text feedback message from an action result so the LLM can see
 * what happened — especially critical for shell exec output.
 * Returns null for actions where the next screenshot observation is sufficient.
 */
export function formatActionResult(command: AgentCommand, result: AgentResult): string | null {
  // Shell exec: the output IS the important result
  if (command.layer === 'shell' && command.action === 'exec') {
    const output = result.data.output as string || '';
    const error = result.data.error as string || '';
    const exitCode = result.data.exitCode as number;
    let text = `SHELL COMMAND RESULT (exit code ${exitCode}):\n`;
    if (output) {
      text += formatShellOutput(output);
    }
    if (error) {
      text += `\nSTDERR: ${formatShellOutput(error)}`;
    }
    if (!output && !error) {
      text += '(no output)';
    }
    return text;
  }

  // Shell app management: brief status is useful
  if (command.layer === 'shell') {
    const msg = result.data.message as string || result.data.error as string || result.status;
    return `ACTION RESULT (${command.action}): ${msg}`;
  }

  // For other layers (vision, cdp, accessibility), the next observation
  // (screenshot + element data) provides the feedback. No text needed.
  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Skill execution helper
// ---------------------------------------------------------------------------

const SKILL_TIMEOUT_MS = 30_000;

/**
 * Execute a skill command directly via execFile.
 * Returns { success, output, error } — no observe-decide-act loop.
 */
function executeSkillCommand(
  cmd: SkillCommandRef,
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const args = [cmd.skillPath, cmd.command, ...cmd.args];
    log(`[agent-loop] Executing skill: ${cmd.runtime} ${args.join(' ')}`);

    execFile(cmd.runtime, args, { timeout: SKILL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = stderr || err.message;
        log(`[agent-loop] Skill execution failed: ${errMsg}`);
        resolve({ success: false, output: stdout || '', error: errMsg });
      } else {
        log(`[agent-loop] Skill execution succeeded: ${(stdout || '').substring(0, 100)}`);
        resolve({ success: true, output: stdout || '' });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Sub-goal iteration budget & global ceiling
// ---------------------------------------------------------------------------

const GLOBAL_ITERATION_CEILING = 100;
const SUB_GOAL_NUDGE_THRESHOLD = 10;

/**
 * Run one sub-goal through the observe-decide-act loop.
 * Returns the outcome plus how many global steps were consumed.
 *
 * This is the inner loop extracted so both flat-mode and sub-goal-mode
 * can share the same iteration logic.
 */
async function runSubGoalLoop(
  subGoalDescription: string,
  subGoalLabel: string,
  goalState: {
    conversationHistory: ConversationMessage[];
    browserActive: boolean;
    commandCounter: number;
    discoveredApps: Set<string>;
    appFailures: Record<string, number>;
    axFailedApps: Set<string>;
    knowledgeInjectedApps: Set<string>;
  },
  sendAndWait: SendAndWait,
  callbacks: AgentLoopCallbacks,
  settleDelayMs: number,
  globalStep: number,
  maxGlobalSteps: number,
  signal?: { aborted: boolean },
): Promise<{ outcome: 'complete' | 'needs_help' | 'stuck' | 'max_iterations' | 'error' | 'cancelled' | 'skill_generation_needed'; summary: string; stepsUsed: number; question?: string; app?: string; discovery?: DiscoveryResult }> {
  const MAX_CONSECUTIVE_ERRORS = 3;
  const MAX_CONSECUTIVE_API_RETRIES = 5;
  const DISCOVERY_THRESHOLD = 3;

  // Per-sub-goal state (resets for each sub-goal)
  const actionHistory: ActionRecord[] = [];
  const stuckSignals: Record<string, number> = {};
  let consecutiveErrors = 0;
  let consecutiveApiRetries = 0;
  let subGoalSteps = 0;
  let lastObservation: Observation | undefined;
  let reuseScreenshot = false;
  let actionAttemptCount = 0;
  let successfulActionCount = 0;

  // Rebuild system prompt at sub-goal start (picks up newly discovered skills)
  const systemPrompt = buildSystemPrompt();

  // Inject sub-goal context into conversation
  goalState.conversationHistory.push({
    role: 'user',
    content: `SUB-GOAL: ${subGoalLabel}\n${subGoalDescription}\n\nFocus on completing this specific sub-goal. When it is done, respond with status "complete" and a brief summary.`,
  });

  while (globalStep + subGoalSteps < maxGlobalSteps) {
    const step = globalStep + subGoalSteps + 1;
    subGoalSteps++;

    // Check cancel signal
    if (signal?.aborted) {
      return { outcome: 'cancelled', summary: 'Cancelled by user', stepsUsed: subGoalSteps };
    }

    callbacks.onStep?.(step, maxGlobalSteps);

    // === OBSERVE ===
    let observation: Observation;
    const observeOpts: ObserveOptions = {
      axFailedApps: goalState.axFailedApps,
      previousObservation: lastObservation,
      reuseScreenshot,
    };
    try {
      observation = await observe(sendAndWait, goalState.browserActive, observeOpts);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onError?.(msg, 'observation');
      return { outcome: 'error', summary: `Observation failed: ${msg}`, stepsUsed: subGoalSteps };
    }
    lastObservation = observation;
    reuseScreenshot = false; // Reset — only reuse once after a pre-execution failure

    // Check cancel after observe
    if (signal?.aborted) {
      return { outcome: 'cancelled', summary: 'Cancelled by user', stepsUsed: subGoalSteps };
    }

    callbacks.onObservation?.(observation, step);

    // === BUILD MESSAGE ===
    const stepsRemaining = maxGlobalSteps - step;
    const userMessage = formatObservation(observation, subGoalDescription, step, {
      maxSteps: maxGlobalSteps,
      remaining: stepsRemaining,
    });
    goalState.conversationHistory.push(userMessage);

    // === KNOWLEDGE INJECTION (skills + learned actions) ===
    const currentApp = observation.frontmostApp;
    if (currentApp && !goalState.knowledgeInjectedApps.has(currentApp)) {
      goalState.knowledgeInjectedApps.add(currentApp);
      const safeName = currentApp.replace(/[^a-zA-Z0-9 ]/g, '');

      // Inject registered skill if available
      const appSkill = getSkillForApp(currentApp);
      if (appSkill) {
        const cmds = appSkill.commands.map(c => c.name).join(', ');
        goalState.conversationHistory.push({
          role: 'user',
          content: `SKILL AVAILABLE: The app "${safeName}" has a registered skill. Use the ${safeName} skill commands (${cmds}) instead of vision/accessibility for this app.`,
        });
        log(`[agent-loop] Injected skill reminder for "${safeName}" (commands: ${cmds})`);
      }

      // Inject learned actions for this app (proactive — not just when stuck)
      const learnedActions = getLearnedActionsForApp(currentApp);
      if (learnedActions.length > 0) {
        const actionSummaries = learnedActions
          .sort((a, b) => b.useCount - a.useCount)
          .slice(0, 10)
          .map(a => {
            const useSuffix = a.useCount > 1 ? ` (used ${a.useCount}x)` : '';
            return `- ${a.type}/${a.visionAction || a.cdpAction || a.axAction || a.command?.substring(0, 60) || 'action'}: ${a.description}${useSuffix}`;
          })
          .join('\n');
        goalState.conversationHistory.push({
          role: 'user',
          content: `LEARNED ACTIONS for "${safeName}" (previously successful — reuse these):\n${actionSummaries}`,
        });
        log(`[agent-loop] Injected ${learnedActions.length} learned actions for "${safeName}"`);
      }
    }

    // === DECIDE ===
    callbacks.onThinking?.();
    let responseText: string;
    try {
      responseText = await sendMessage(systemPrompt, goalState.conversationHistory);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onError?.(msg, 'llm');
      return { outcome: 'error', summary: `LLM call failed: ${msg}`, stepsUsed: subGoalSteps };
    }

    // --- Handle: API error (overloaded/rate-limited) ---
    // Detect API errors BEFORE adding to conversation history, so we can
    // retry cleanly without polluting the context with error JSON.
    try {
      const maybeError = JSON.parse(responseText);
      if (maybeError?.apiError === true) {
        consecutiveApiRetries++;
        if (consecutiveApiRetries >= MAX_CONSECUTIVE_API_RETRIES) {
          log(`[agent-loop] API error persisted for ${consecutiveApiRetries} retries — giving up`);
          callbacks.onError?.(maybeError.error, `api_exhausted (${consecutiveApiRetries} retries)`);
          return {
            outcome: 'error',
            summary: `API unavailable after ${consecutiveApiRetries} retries: ${maybeError.error}`,
            stepsUsed: subGoalSteps,
          };
        }
        const isOverloaded = maybeError.overloaded === true;
        const waitSec = isOverloaded ? 30 : 15;
        log(`[agent-loop] API ${isOverloaded ? 'overloaded' : 'error'} — waiting ${waitSec}s before retry ${consecutiveApiRetries}/${MAX_CONSECUTIVE_API_RETRIES} (does NOT count as parse error)`);
        callbacks.onError?.(maybeError.error, `api_retry ${consecutiveApiRetries}/${MAX_CONSECUTIVE_API_RETRIES} (waiting ${waitSec}s)`);
        await new Promise<void>((resolve) => setTimeout(resolve, waitSec * 1000));
        // Do NOT push this into conversation history — retry from the same state
        // Do NOT increment consecutiveErrors — this is an infra issue, not a model issue
        continue;
      }
    } catch {
      // Not JSON at all — that's fine, will be handled by parseResponse below
    }
    // API succeeded — reset the API retry counter
    consecutiveApiRetries = 0;

    goalState.conversationHistory.push({ role: 'assistant', content: responseText });

    // Check cancel after Claude API call
    if (signal?.aborted) {
      return { outcome: 'cancelled', summary: 'Cancelled by user', stepsUsed: subGoalSteps };
    }

    // === PARSE RESPONSE ===
    goalState.commandCounter++;
    const parsed = parseResponse(responseText, goalState.commandCounter);
    callbacks.onParsed?.(parsed, step);

    // --- Handle: complete ---
    if (parsed.type === 'complete') {
      // False success validation: reject if actions were attempted but none succeeded
      if (actionAttemptCount > 0 && successfulActionCount === 0) {
        log(`[agent-loop] Rejecting false completion: ${actionAttemptCount} actions attempted, 0 succeeded`);
        goalState.conversationHistory.push({
          role: 'user',
          content: `Your previous actions all failed. You cannot report "complete" when no actions succeeded. Try a different approach.`,
        });
        continue;
      }
      callbacks.onComplete?.(parsed.summary, step);
      return { outcome: 'complete', summary: parsed.summary, stepsUsed: subGoalSteps };
    }

    // --- Handle: needs_help ---
    if (parsed.type === 'needs_help') {
      callbacks.onNeedsHelp?.(parsed.question);
      return { outcome: 'needs_help', summary: parsed.thinking, stepsUsed: subGoalSteps, question: parsed.question };
    }

    // --- Handle: parse error ---
    if (parsed.type === 'error') {
      consecutiveErrors++;
      callbacks.onError?.(parsed.error, `parse (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return {
          outcome: 'error',
          summary: `${MAX_CONSECUTIVE_ERRORS} consecutive parse errors. Last: ${parsed.error}`,
          stepsUsed: subGoalSteps,
        };
      }

      goalState.conversationHistory.push({
        role: 'user',
        content: 'Your previous response was not valid JSON. Respond with EXACTLY ONE JSON object — no markdown, no backticks, no extra text.',
      });
      continue;
    }

    // --- Handle: action ---
    if (parsed.type === 'action') {
      consecutiveErrors = 0;
      actionAttemptCount++;
      callbacks.onAction?.(parsed.command, parsed.thinking);

      // Track browser state
      if (parsed.command.layer === 'cdp' && parsed.command.action === 'launch') {
        goalState.browserActive = true;
      }
      if (parsed.command.layer === 'cdp' && parsed.command.action === 'close') {
        goalState.browserActive = false;
      }

      // === ACT ===
      let result: AgentResult;
      try {
        result = await sendAndWait(parsed.command);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        callbacks.onError?.(msg, 'execution');

        // Pre-execution failure (threw before any UI interaction) — safe to reuse screenshot
        const isPreExecution = /command not found|parse error|syntax error|ENOENT|EACCES|not running|not found/i.test(msg);
        reuseScreenshot = isPreExecution;

        // Track per-app failures on accessibility/vision layers
        const failLayer = parsed.command.layer;
        if (failLayer === 'accessibility' || failLayer === 'vision') {
          const failApp = observation.frontmostApp;
          goalState.appFailures[failApp] = (goalState.appFailures[failApp] || 0) + 1;

          if (goalState.appFailures[failApp] >= DISCOVERY_THRESHOLD && !goalState.discoveredApps.has(failApp)) {
            goalState.discoveredApps.add(failApp);

            const existingSkill = getSkillForApp(failApp);
            if (existingSkill) {
              goalState.conversationHistory.push({
                role: 'user',
                content: `SKILL HINT: A Layer 1 skill already exists for "${failApp}". Use shell/exec with the ${existingSkill.runtime} ${existingSkill.file} commands instead of ${failLayer} automation. Available commands: ${existingSkill.commands.map(c => c.name).join(', ')}.`,
              });
            } else {
              const learnedActions = getLearnedActionsForApp(failApp);
              if (learnedActions.length > 0) {
                goalState.conversationHistory.push({
                  role: 'user',
                  content: `LEARNED ACTIONS for "${failApp}": You have previously used these successfully:\n${learnedActions.map((a: LearnedAction) => `- ${a.description}: ${formatActionHint(a)}`).join('\n')}\nTry these instead of ${failLayer}.`,
                });
                goalState.conversationHistory.push({
                  role: 'user',
                  content: `The action failed with error: ${msg}. What should we try instead?`,
                });
                continue;
              }

              const alreadyDiscovered = getDiscoveredApp(failApp);
              if (alreadyDiscovered && !alreadyDiscovered.appleScript && !alreadyDiscovered.cli && !alreadyDiscovered.api) {
                log(`[agent-loop] "${failApp}" was previously discovered with no viable interfaces — continuing with ${failLayer}`);
                goalState.conversationHistory.push({
                  role: 'user',
                  content: `"${failApp}" has no known automation interfaces (previously discovered). Continue with ${failLayer}.`,
                });
              } else {
                try {
                  const disc = await discoverAppCapabilities(failApp);
                  log(`[agent-loop] Discovery for "${failApp}": ${disc.recommendation}`);

                  const hasViableInterface = disc.appleScript.supported || disc.cli.found || disc.knownApi.hasApi;
                  if (hasViableInterface) {
                    log(`[agent-loop] Pausing for skill generation: "${failApp}"`);
                    return {
                      outcome: 'skill_generation_needed',
                      summary: `Cannot reliably control "${failApp}" via ${failLayer}. Skill generation recommended.`,
                      stepsUsed: subGoalSteps,
                      app: failApp,
                      discovery: disc,
                    };
                  } else {
                    goalState.conversationHistory.push({
                      role: 'user',
                      content: `SKILL DISCOVERY: ${disc.recommendation} For now, continuing with ${failLayer}.`,
                    });
                  }
                } catch {
                  log(`[agent-loop] Discovery failed for "${failApp}" — continuing`);
                }
              }
            }
          }
        }

        goalState.conversationHistory.push({
          role: 'user',
          content: `The action failed with error: ${msg}. What should we try instead?`,
        });
        continue;
      }

      // Check cancel after action execution
      if (signal?.aborted) {
        return { outcome: 'cancelled', summary: 'Cancelled by user', stepsUsed: subGoalSteps };
      }

      callbacks.onActionResult?.(parsed.command, result);

      // Track successful actions — reset per-app failure count
      const actLayer = parsed.command.layer;
      if ((actLayer === 'accessibility' || actLayer === 'vision') && result.status === 'success') {
        const actApp = observation.frontmostApp;
        goalState.appFailures[actApp] = 0;
      }

      // Capture successful actions for learning
      if (result.status === 'success') {
        successfulActionCount++;
        captureLearnedAction(parsed, observation, result);
      }

      // --- Stuck detection ---
      if (result.status === 'success') {
        const keyParam = extractKeyParam(parsed.command);
        const record: ActionRecord = {
          layer: parsed.command.layer,
          action: parsed.command.action,
          keyParam,
          app: observation.frontmostApp,
          windowTitle: observation.windowTitle || '',
        };
        actionHistory.push(record);
        if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();

        const prevRecord = actionHistory.length >= 2 ? actionHistory[actionHistory.length - 2] : null;
        if (prevRecord && (prevRecord.app !== observation.frontmostApp || prevRecord.windowTitle !== observation.windowTitle)) {
          stuckSignals[observation.frontmostApp] = 0;
        }

        const stuckType = detectStuck(actionHistory, observation);
        if (stuckType) {
          const stuckApp = observation.frontmostApp;
          stuckSignals[stuckApp] = (stuckSignals[stuckApp] || 0) + 1;
          log(`[agent-loop] Stuck detected for "${stuckApp}": ${stuckType} (${stuckSignals[stuckApp]} signals)`);

          if (stuckSignals[stuckApp] >= STUCK_THRESHOLD) {
            const stuckActions = getLearnedActionsForApp(stuckApp);
            if (stuckActions.length > 0) {
              goalState.conversationHistory.push({
                role: 'user',
                content: `STUCK DETECTION: You seem to be stuck on "${stuckApp}" — repeating similar actions without progress. Here are actions that previously worked for this app:\n${stuckActions.map((a: LearnedAction) => `- ${a.description}: ${formatActionHint(a)}`).join('\n')}\nTry a different approach.`,
              });
            } else {
              goalState.conversationHistory.push({
                role: 'user',
                content: `STUCK DETECTION: You seem to be stuck on "${stuckApp}" — repeating actions without progress. Try a completely different approach:\n- Use a different layer (shell command instead of clicking)\n- Try osascript to control the app via AppleScript\n- Look for keyboard shortcuts instead of clicking buttons`,
              });
            }
          }

          if (stuckSignals[stuckApp] >= UNRELIABLE_THRESHOLD && !goalState.discoveredApps.has(stuckApp)) {
            goalState.discoveredApps.add(stuckApp);
            const existingSkill = getSkillForApp(stuckApp);
            if (existingSkill) {
              goalState.conversationHistory.push({
                role: 'user',
                content: `SKILL HINT: A Layer 1 skill exists for "${stuckApp}". Use it instead.`,
              });
            } else {
              try {
                const disc = await discoverAppCapabilities(stuckApp);
                const hasViable = disc.appleScript.supported || disc.cli.found || disc.knownApi.hasApi;
                if (hasViable) {
                  return {
                    outcome: 'skill_generation_needed',
                    summary: `Vision unreliable for "${stuckApp}". Skill generation recommended.`,
                    stepsUsed: subGoalSteps,
                    app: stuckApp,
                    discovery: disc,
                  };
                }
              } catch {
                log(`[agent-loop] Discovery failed for "${stuckApp}" during stuck detection`);
              }
            }
          }

          // If we've been stuck long enough, bail out of this sub-goal
          if (stuckSignals[stuckApp] >= UNRELIABLE_THRESHOLD) {
            return { outcome: 'stuck', summary: `Stuck on "${stuckApp}": ${stuckType}`, stepsUsed: subGoalSteps };
          }
        }
      }

      // Feed action result back to the LLM
      const resultFeedback = formatActionResult(parsed.command, result);
      if (resultFeedback) {
        goalState.conversationHistory.push({ role: 'user', content: resultFeedback });
      }

      // --- Sub-goal iteration nudge ---
      if (subGoalSteps > 0 && subGoalSteps % SUB_GOAL_NUDGE_THRESHOLD === 0) {
        goalState.conversationHistory.push({
          role: 'user',
          content: `You have spent ${subGoalSteps} iterations on this sub-goal ("${subGoalLabel}"). If you believe this sub-goal is complete, respond with status "complete". If you are stuck, report status: needs_help.`,
        });
        log(`[agent-loop] Nudge injected at ${subGoalSteps} iterations for sub-goal "${subGoalLabel}"`);
      }

      // Let the UI settle before the next observation
      await new Promise<void>((resolve) => setTimeout(resolve, settleDelayMs));
    }
  }

  return { outcome: 'max_iterations', summary: `Sub-goal "${subGoalLabel}" reached iteration limit`, stepsUsed: subGoalSteps };
}

/**
 * Run the autonomous agent loop.
 *
 * Observes the screen, sends observations to Claude, executes Claude's decisions.
 * Repeats until the goal is achieved, max iterations reached, or an unrecoverable error.
 *
 * When `decompose` is true, the goal is broken into sub-goals first, and the loop
 * iterates over each sub-goal sequentially with shared conversation history.
 */
/** Budget bonus granted per completed sub-goal */
const BUDGET_BONUS_PER_SUBGOAL = 8;

/** Default wall-clock timeout (15 minutes) */
const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;

export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const {
    goal,
    sendAndWait,
    callbacks = {},
    maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS || '25', 10),
    settleDelayMs = 400,
    decompose = false,
    signal,
  } = config;

  // Adaptive budget: starts at maxIterations, grows on sub-goal completion, capped at ceiling
  let budgetRemaining = Math.min(maxIterations, GLOBAL_ITERATION_CEILING);
  const globalMax = GLOBAL_ITERATION_CEILING; // Hard ceiling
  const startTime = Date.now();
  const wallClockMs = DEFAULT_WALL_CLOCK_MS;

  log(`[agent-loop] Starting. Goal: "${goal.substring(0, 80)}". Initial budget: ${budgetRemaining}. Ceiling: ${globalMax}. Decompose: ${decompose}`);

  // Initialize LLM
  try {
    initLLMClient();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[agent-loop] initLLMClient failed: ${msg}`);
    callbacks.onError?.(msg, 'llm_init');
    return { outcome: 'error', summary: `LLM initialization failed: ${msg}`, steps: 0 };
  }
  resetConversation();

  // Goal-level state (carries forward across sub-goals)
  const goalState = {
    conversationHistory: [] as ConversationMessage[],
    browserActive: false,
    commandCounter: 0,
    discoveredApps: new Set<string>(),
    appFailures: {} as Record<string, number>,
    axFailedApps: new Set<string>(),
    knowledgeInjectedApps: new Set<string>(),
  };

  // ---------------------------------------------------------------------------
  // FLAT MODE (no decomposition) — backward-compatible path
  // ---------------------------------------------------------------------------
  if (!decompose) {
    const result = await runSubGoalLoop(
      goal, 'Main goal', goalState, sendAndWait, callbacks,
      settleDelayMs, 0, budgetRemaining, signal,
    );

    // Map inner result to AgentLoopResult
    const outcome = result.outcome === 'stuck' ? 'max_iterations' as const : result.outcome;
    return {
      outcome,
      summary: result.summary,
      steps: result.stepsUsed,
      question: result.question,
      app: result.app,
      discovery: result.discovery,
    };
  }

  // ---------------------------------------------------------------------------
  // DECOMPOSITION MODE — two-level sub-goal loop
  // ---------------------------------------------------------------------------
  log('[agent-loop] Decomposing goal into sub-goals...');
  const decomposition = await decomposeTask(goal);

  if (!decomposition.ok) {
    log(`[agent-loop] Decomposition failed: ${decomposition.error}. Falling back to flat loop.`);
    callbacks.onError?.(decomposition.error, 'decomposition');

    const result = await runSubGoalLoop(
      goal, 'Main goal', goalState, sendAndWait, callbacks,
      settleDelayMs, 0, globalMax, signal,
    );

    const outcome = result.outcome === 'stuck' ? 'max_iterations' as const : result.outcome;
    return {
      outcome,
      summary: result.summary,
      steps: result.stepsUsed,
      question: result.question,
      app: result.app,
      discovery: result.discovery,
    };
  }

  const subGoals = decomposition.subGoals;
  log(`[agent-loop] Decomposed into ${subGoals.length} sub-goals`);
  callbacks.onDecomposition?.(subGoals);

  const subGoalResults: SubGoalResult[] = [];
  let totalSteps = 0;

  for (let i = 0; i < subGoals.length; i++) {
    const sg = subGoals[i];

    // Wall-clock timeout check
    if (Date.now() - startTime > wallClockMs) {
      log(`[agent-loop] Wall-clock timeout: ${wallClockMs}ms elapsed`);
      for (let j = i; j < subGoals.length; j++) {
        subGoalResults.push({ subGoal: subGoals[j], outcome: 'not_started' });
      }
      return {
        outcome: 'max_iterations',
        summary: `Wall-clock timeout (${Math.round(wallClockMs / 60000)} min) reached after ${totalSteps} steps`,
        steps: totalSteps,
        subGoalResults,
      };
    }

    // Check cancel before starting each sub-goal
    if (signal?.aborted) {
      // Mark remaining sub-goals as not started
      for (let j = i; j < subGoals.length; j++) {
        subGoalResults.push({ subGoal: subGoals[j], outcome: 'not_started' });
      }
      callbacks.onComplete?.('Cancelled by user', totalSteps);
      return {
        outcome: 'cancelled',
        summary: `Cancelled after completing ${i} of ${subGoals.length} sub-goals`,
        steps: totalSteps,
        subGoalResults,
      };
    }

    log(`[agent-loop] Starting sub-goal ${i + 1}/${subGoals.length}: "${sg.label}"`);
    callbacks.onSubGoalStart?.(sg, i, subGoals.length);

    // === SKILL COMMAND FAST PATH ===
    // If the sub-goal has a skillCommand, execute it directly — no observe-decide-act loop
    if (sg.skillCommand) {
      log(`[agent-loop] Skill command fast path: ${sg.skillCommand.runtime} ${sg.skillCommand.command}`);
      const skillResult = await executeSkillCommand(sg.skillCommand);
      totalSteps += 1; // Skill counts as 1 step

      if (skillResult.success) {
        subGoalResults.push({ subGoal: sg, outcome: 'complete' });
        callbacks.onSubGoalComplete?.(sg, i, subGoals.length, 'complete');
        log(`[agent-loop] Skill command completed successfully`);
        callbacks.onComplete?.(skillResult.output.substring(0, 200), totalSteps);

        return {
          outcome: 'complete',
          summary: `Skill command completed: ${skillResult.output.substring(0, 200)}`,
          steps: totalSteps,
          subGoalResults,
        };
      }

      // Skill failed — fall back to normal vision decomposition with fresh context
      log(`[agent-loop] Skill command failed: ${skillResult.error}. Falling back to vision loop.`);
      goalState.conversationHistory.push({
        role: 'user',
        content: `Skill "${sg.skillCommand.command}" partially executed but failed: ${skillResult.error}. Assess the current screen state and complete the task using UI automation.`,
      });
      // Continue to normal sub-goal loop below (don't return)
    }

    // Summarize conversation from previous sub-goal at boundary
    if (i > 0 && goalState.conversationHistory.length > 20) {
      const prevSg = subGoals[i - 1];
      const prevOutcome = subGoalResults[i - 1]?.outcome || 'complete';
      goalState.conversationHistory.push({
        role: 'user',
        content: `[Sub-goal "${prevSg.label}" ${prevOutcome}. Moving to next sub-goal: "${sg.label}"]`,
      });
    }

    const effectiveBudget = Math.min(totalSteps + budgetRemaining, globalMax);
    const sgResult = await runSubGoalLoop(
      sg.description, sg.label, goalState, sendAndWait, callbacks,
      settleDelayMs, totalSteps, effectiveBudget, signal,
    );

    totalSteps += sgResult.stepsUsed;
    budgetRemaining -= sgResult.stepsUsed;

    // Map inner outcome to SubGoalOutcome
    let sgOutcome: SubGoalOutcome;
    if (sgResult.outcome === 'complete') {
      sgOutcome = 'complete';
      // Adaptive budget: grant bonus steps on sub-goal completion
      const bonus = Math.min(BUDGET_BONUS_PER_SUBGOAL, globalMax - totalSteps - budgetRemaining);
      if (bonus > 0) {
        budgetRemaining += bonus;
        log(`[agent-loop] Budget bonus: +${bonus} steps (remaining: ${budgetRemaining})`);
      }
    } else if (sgResult.outcome === 'cancelled') {
      sgOutcome = 'cancelled';
    } else {
      sgOutcome = 'stuck';
    }

    subGoalResults.push({ subGoal: sg, outcome: sgOutcome });
    callbacks.onSubGoalComplete?.(sg, i, subGoals.length, sgOutcome);

    log(`[agent-loop] Sub-goal ${i + 1}/${subGoals.length} "${sg.label}" -> ${sgOutcome} (${sgResult.stepsUsed} steps)`);

    // Stop early on terminal outcomes
    if (sgResult.outcome === 'needs_help') {
      for (let j = i + 1; j < subGoals.length; j++) {
        subGoalResults.push({ subGoal: subGoals[j], outcome: 'not_started' });
      }
      return {
        outcome: 'needs_help',
        summary: sgResult.summary,
        steps: totalSteps,
        question: sgResult.question,
        subGoalResults,
      };
    }

    if (sgResult.outcome === 'skill_generation_needed') {
      for (let j = i + 1; j < subGoals.length; j++) {
        subGoalResults.push({ subGoal: subGoals[j], outcome: 'not_started' });
      }
      return {
        outcome: 'skill_generation_needed',
        summary: sgResult.summary,
        steps: totalSteps,
        app: sgResult.app,
        discovery: sgResult.discovery,
        subGoalResults,
      };
    }

    if (sgResult.outcome === 'error') {
      for (let j = i + 1; j < subGoals.length; j++) {
        subGoalResults.push({ subGoal: subGoals[j], outcome: 'not_started' });
      }
      return {
        outcome: 'error',
        summary: sgResult.summary,
        steps: totalSteps,
        subGoalResults,
      };
    }

    if (sgResult.outcome === 'cancelled') {
      for (let j = i + 1; j < subGoals.length; j++) {
        subGoalResults.push({ subGoal: subGoals[j], outcome: 'not_started' });
      }
      return {
        outcome: 'cancelled',
        summary: `Cancelled during sub-goal "${sg.label}"`,
        steps: totalSteps,
        subGoalResults,
      };
    }

    // For 'stuck' or 'max_iterations', continue to next sub-goal
    // (the agent may make progress on the next one)
  }

  // All sub-goals processed
  const completedCount = subGoalResults.filter(r => r.outcome === 'complete').length;
  const allComplete = completedCount === subGoals.length;

  if (allComplete) {
    callbacks.onComplete?.(`All ${subGoals.length} sub-goals completed`, totalSteps);
    return {
      outcome: 'complete',
      summary: `Completed all ${subGoals.length} sub-goals in ${totalSteps} steps`,
      steps: totalSteps,
      subGoalResults,
    };
  }

  return {
    outcome: 'partial_complete',
    summary: `Completed ${completedCount} of ${subGoals.length} sub-goals in ${totalSteps} steps`,
    steps: totalSteps,
    subGoalResults,
  };
}
