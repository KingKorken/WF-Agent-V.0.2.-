/**
 * Command Handler — Parses incoming WebSocket messages and dispatches them.
 *
 * When a message arrives from the cloud over the WebSocket connection:
 *   1. Parse the raw JSON string into an object
 *   2. Validate that it looks like a valid AgentCommand
 *   3. Pass it to the layer-router for execution
 *   4. Return the result (to be sent back over the WebSocket)
 *
 * This module is the bridge between the network layer and the execution layer.
 */

import { AgentCommand, AgentResult } from '@workflow-agent/shared';
import { routeCommand } from '../executor/layer-router';
import { log, error as logError } from '../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Handle a raw WebSocket message string.
 * Parses it, validates it, routes it to the correct executor,
 * and returns the result as a JSON string ready to send back.
 *
 * @param rawMessage - The raw JSON string received from the WebSocket
 * @returns The JSON string result to send back, or null if the message was not a command
 */
export async function handleIncomingMessage(rawMessage: string): Promise<string | null> {
  let parsed: unknown;

  // Step 1: Parse the raw JSON
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    logError(`[${timestamp()}] [command-handler] Failed to parse message as JSON: ${rawMessage}`);
    return JSON.stringify({
      type: 'result',
      id: 'unknown',
      status: 'error',
      data: { error: 'Invalid JSON received' },
    });
  }

  // Step 2: Check if it's a command we should handle
  const msg = parsed as Record<string, unknown>;

  if (msg.type !== 'command') {
    // Not a command — could be an ack or other message type, ignore it
    log(`[${timestamp()}] [command-handler] Ignoring non-command message (type: ${msg.type})`);
    return null;
  }

  // Step 3: Validate required fields
  if (!msg.id || !msg.layer || !msg.action) {
    logError(`[${timestamp()}] [command-handler] Invalid command — missing id, layer, or action`);
    return JSON.stringify({
      type: 'result',
      id: msg.id || 'unknown',
      status: 'error',
      data: { error: 'Invalid command: missing required fields (id, layer, action)' },
    });
  }

  // Step 4: Build the typed command object
  const command: AgentCommand = {
    type: 'command',
    id: msg.id as string,
    layer: msg.layer as AgentCommand['layer'],
    action: msg.action as string,
    params: (msg.params as Record<string, unknown>) || {},
  };

  log(`[${timestamp()}] [command-handler] Processing command: ${command.id} (${command.layer}/${command.action})`);

  // Step 5: Route to the correct executor and get the result
  const result: AgentResult = await routeCommand(command);

  log(`[${timestamp()}] [command-handler] Command ${command.id} → ${result.status}`);

  return JSON.stringify(result);
}
