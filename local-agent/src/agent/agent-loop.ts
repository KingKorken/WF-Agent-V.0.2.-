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

import { AgentCommand, AgentResult } from '@workflow-agent/shared';
import { initLLMClient, sendMessage, resetConversation } from './llm-client';
import type { ConversationMessage } from './llm-client';
import { observe } from './observer';
import type { Observation } from './observer';
import { buildSystemPrompt, formatObservation } from './prompt-builder';
import { parseResponse } from './response-parser';
import type { ParsedResponse } from './response-parser';
import { log } from '../utils/logger';
import { getSkillForApp, getDiscoveredApp } from '../skills/registry';
import { discoverAppCapabilities } from '../skills/discovery';
import type { DiscoveryResult } from '../skills/discovery';

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
}

/** Result of the agent loop */
export interface AgentLoopResult {
  /** How the loop ended */
  outcome: 'complete' | 'needs_help' | 'max_iterations' | 'error' | 'skill_generation_needed';

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

/**
 * Run the autonomous agent loop.
 *
 * Observes the screen, sends observations to Claude, executes Claude's decisions.
 * Repeats until the goal is achieved, max iterations reached, or an unrecoverable error.
 */
export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const {
    goal,
    sendAndWait,
    callbacks = {},
    maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS || '25', 10),
    settleDelayMs = 800,
  } = config;

  log(`[agent-loop] Starting. Goal: "${goal.substring(0, 80)}". Max iterations: ${maxIterations}`);

  // Initialize LLM
  try {
    initLLMClient();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Already initialized is fine — rethrow only real errors
    if (!msg.includes('not found')) {
      // initLLMClient only throws on missing API key
    }
  }
  resetConversation();

  const systemPrompt = buildSystemPrompt();
  const conversationHistory: ConversationMessage[] = [];
  let browserActive = false;
  let consecutiveErrors = 0;
  let commandCounter = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  // Track per-app failures on Layer 4/5 for skill discovery
  const appFailures: Record<string, number> = {};
  const discoveredApps = new Set<string>();
  const DISCOVERY_THRESHOLD = 3;

  for (let step = 1; step <= maxIterations; step++) {
    callbacks.onStep?.(step, maxIterations);

    // === OBSERVE ===
    let observation: Observation;
    try {
      observation = await observe(sendAndWait, browserActive);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onError?.(msg, 'observation');
      return { outcome: 'error', summary: `Observation failed: ${msg}`, steps: step };
    }

    callbacks.onObservation?.(observation, step);

    // === BUILD MESSAGE ===
    const userMessage = formatObservation(observation, goal, step);
    conversationHistory.push(userMessage);

    // === DECIDE ===
    callbacks.onThinking?.();
    let responseText: string;
    try {
      responseText = await sendMessage(systemPrompt, conversationHistory);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onError?.(msg, 'llm');
      return { outcome: 'error', summary: `LLM call failed: ${msg}`, steps: step };
    }

    // Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: responseText });

    // === PARSE RESPONSE ===
    commandCounter++;
    const parsed = parseResponse(responseText, commandCounter);
    callbacks.onParsed?.(parsed, step);

    // --- Handle: complete ---
    if (parsed.type === 'complete') {
      callbacks.onComplete?.(parsed.summary, step);
      return { outcome: 'complete', summary: parsed.summary, steps: step };
    }

    // --- Handle: needs_help ---
    if (parsed.type === 'needs_help') {
      callbacks.onNeedsHelp?.(parsed.question);
      return { outcome: 'needs_help', summary: parsed.thinking, steps: step, question: parsed.question };
    }

    // --- Handle: parse error ---
    if (parsed.type === 'error') {
      consecutiveErrors++;
      callbacks.onError?.(parsed.error, `parse (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return {
          outcome: 'error',
          summary: `${MAX_CONSECUTIVE_ERRORS} consecutive parse errors. Last: ${parsed.error}`,
          steps: step,
        };
      }

      conversationHistory.push({
        role: 'user',
        content: 'Your previous response was not valid JSON. Respond with EXACTLY ONE JSON object — no markdown, no backticks, no extra text.',
      });
      continue;
    }

    // --- Handle: action ---
    if (parsed.type === 'action') {
      consecutiveErrors = 0;
      callbacks.onAction?.(parsed.command, parsed.thinking);

      // Track browser state
      if (parsed.command.layer === 'cdp' && parsed.command.action === 'launch') {
        browserActive = true;
      }
      if (parsed.command.layer === 'cdp' && parsed.command.action === 'close') {
        browserActive = false;
      }

      // === ACT ===
      let result: AgentResult;
      try {
        result = await sendAndWait(parsed.command);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        callbacks.onError?.(msg, 'execution');

        // Track per-app failures on accessibility/vision layers
        const failLayer = parsed.command.layer;
        if (failLayer === 'accessibility' || failLayer === 'vision') {
          const failApp = observation.frontmostApp;
          appFailures[failApp] = (appFailures[failApp] || 0) + 1;

          if (appFailures[failApp] >= DISCOVERY_THRESHOLD && !discoveredApps.has(failApp)) {
            discoveredApps.add(failApp);

            // Check registry first — maybe a skill already exists
            const existingSkill = getSkillForApp(failApp);
            if (existingSkill) {
              conversationHistory.push({
                role: 'user',
                content: `SKILL HINT: A Layer 1 skill already exists for "${failApp}". Use shell/exec with the ${existingSkill.runtime} ${existingSkill.file} commands instead of ${failLayer} automation. Available commands: ${existingSkill.commands.map(c => c.name).join(', ')}.`,
              });
            } else {
              // Check if already discovered with no viable interfaces
              const alreadyDiscovered = getDiscoveredApp(failApp);
              if (alreadyDiscovered && !alreadyDiscovered.appleScript && !alreadyDiscovered.cli && !alreadyDiscovered.api) {
                log(`[agent-loop] "${failApp}" was previously discovered with no viable interfaces — continuing with ${failLayer}`);
                conversationHistory.push({
                  role: 'user',
                  content: `"${failApp}" has no known automation interfaces (previously discovered). Continue with ${failLayer}.`,
                });
              } else {
                // Run discovery — this time we PAUSE if viable interfaces are found
                try {
                  const disc = await discoverAppCapabilities(failApp);
                  log(`[agent-loop] Discovery for "${failApp}": ${disc.recommendation}`);

                  const hasViableInterface = disc.appleScript.supported || disc.cli.found || disc.knownApi.hasApi;
                  if (hasViableInterface) {
                    // PAUSE — signal the caller that skill generation is needed
                    log(`[agent-loop] Pausing for skill generation: "${failApp}"`);
                    return {
                      outcome: 'skill_generation_needed',
                      summary: `Cannot reliably control "${failApp}" via ${failLayer}. Skill generation recommended.`,
                      steps: step,
                      app: failApp,
                      discovery: disc,
                    };
                  } else {
                    // No viable interfaces — continue with vision/accessibility
                    conversationHistory.push({
                      role: 'user',
                      content: `SKILL DISCOVERY: ${disc.recommendation} For now, continuing with ${failLayer}.`,
                    });
                  }
                } catch {
                  // Discovery failed — continue without disrupting the loop
                  log(`[agent-loop] Discovery failed for "${failApp}" — continuing`);
                }
              }
            }
          }
        }

        conversationHistory.push({
          role: 'user',
          content: `The action failed with error: ${msg}. What should we try instead?`,
        });
        continue;
      }

      callbacks.onActionResult?.(parsed.command, result);

      // Track successful actions — reset per-app failure count
      const actLayer = parsed.command.layer;
      if ((actLayer === 'accessibility' || actLayer === 'vision') && result.status === 'success') {
        const actApp = observation.frontmostApp;
        appFailures[actApp] = 0;
      }

      // Feed action result back to the LLM
      const resultFeedback = formatActionResult(parsed.command, result);
      if (resultFeedback) {
        conversationHistory.push({ role: 'user', content: resultFeedback });
      }

      // Let the UI settle before the next observation
      await new Promise<void>((resolve) => setTimeout(resolve, settleDelayMs));
    }
  }

  // Max iterations reached
  return { outcome: 'max_iterations', summary: `Reached ${maxIterations} iterations`, steps: maxIterations };
}
