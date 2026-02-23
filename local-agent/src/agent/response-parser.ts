/**
 * Response Parser — Parse Claude's JSON response into an executable command.
 *
 * Claude is instructed to respond with exactly one JSON object. This module
 * cleans up any accidental markdown wrapping, parses the JSON, and returns
 * a discriminated union so the agent loop can handle each case cleanly.
 */

import { AgentCommand } from '@workflow-agent/shared';
import { log, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claude chose an action to take */
interface AgentAction {
  type: 'action';
  thinking: string;
  command: AgentCommand;
}

/** Claude declares the goal is complete */
interface AgentComplete {
  type: 'complete';
  thinking: string;
  summary: string;
}

/** Claude needs human input to continue */
interface AgentNeedsHelp {
  type: 'needs_help';
  thinking: string;
  question: string;
}

/** Claude returned something we couldn't parse */
interface AgentError {
  type: 'error';
  error: string;
  rawResponse: string;
}

export type ParsedResponse = AgentAction | AgentComplete | AgentNeedsHelp | AgentError;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse Claude's response text into a structured ParsedResponse.
 *
 * @param responseText      - Raw text from the LLM
 * @param commandIdCounter  - Incremented counter for unique command IDs
 */
export function parseResponse(responseText: string, commandIdCounter: number): ParsedResponse {
  log(`[response-parser] Parsing response (${responseText.length} chars)`);

  // Strip markdown code fences if present (e.g. ```json ... ```)
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[response-parser] JSON parse failed: ${msg}`);
    logError(`[response-parser] Raw (first 300): ${responseText.substring(0, 300)}`);
    return {
      type: 'error',
      error: `JSON parse failed: ${msg}`,
      rawResponse: responseText,
    };
  }

  // Handle status: 'complete'
  if (parsed.status === 'complete') {
    return {
      type: 'complete',
      thinking: String(parsed.thinking || ''),
      summary: String(parsed.summary || 'Goal achieved'),
    };
  }

  // Handle status: 'needs_help'
  if (parsed.status === 'needs_help') {
    return {
      type: 'needs_help',
      thinking: String(parsed.thinking || ''),
      question: String(parsed.question || 'Agent needs guidance'),
    };
  }

  // Handle status: 'error' (returned by llm-client on API failure)
  if (parsed.status === 'error') {
    return {
      type: 'error',
      error: String(parsed.error || 'Unknown LLM error'),
      rawResponse: responseText,
    };
  }

  // Handle action response
  if (parsed.action && typeof parsed.action === 'object') {
    const actionObj = parsed.action as Record<string, unknown>;

    if (!actionObj.layer || typeof actionObj.layer !== 'string') {
      return {
        type: 'error',
        error: 'Action missing required "layer" field',
        rawResponse: responseText,
      };
    }

    if (!actionObj.action || typeof actionObj.action !== 'string') {
      return {
        type: 'error',
        error: 'Action missing required "action" field',
        rawResponse: responseText,
      };
    }

    const command: AgentCommand = {
      type: 'command',
      id: `agent_${commandIdCounter}`,
      layer: actionObj.layer as AgentCommand['layer'],
      action: actionObj.action as string,
      params: (actionObj.params as Record<string, unknown>) || {},
    };

    log(`[response-parser] Action: ${command.layer}/${command.action} (id: ${command.id})`);

    return {
      type: 'action',
      thinking: String(parsed.thinking || ''),
      command,
    };
  }

  // Nothing matched
  logError(`[response-parser] Unrecognized response shape: ${cleaned.substring(0, 200)}`);
  return {
    type: 'error',
    error: 'Response has neither "action" nor "status" field',
    rawResponse: responseText,
  };
}
