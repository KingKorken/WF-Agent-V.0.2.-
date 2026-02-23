/**
 * LLM Client — Anthropic API wrapper for the agent loop.
 *
 * Maintains conversation history across loop iterations so Claude can
 * see everything that happened before and reason about the full context.
 * Each call to sendMessage() appends the full history; the caller is
 * responsible for pushing assistant replies into the history array.
 */

import Anthropic from '@anthropic-ai/sdk';
import { log, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TextBlock {
  type: 'text';
  text: string;
}

interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png';
    data: string; // base64 WITHOUT the data:image/png;base64, prefix
  };
}

type ContentBlock = TextBlock | ImageBlock;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let client: Anthropic | null = null;

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Initialize the Anthropic client.
 * Must be called before sendMessage(). Throws if API key is missing.
 */
export function initLLMClient(): void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not found. Create a .env file at the repo root with your API key.'
    );
  }
  client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  log(`[llm-client] Initialized. Model: ${model}`);
}

/**
 * Send a message to Claude and return the text response.
 *
 * @param systemPrompt - The system prompt (sent on every call)
 * @param messages     - Full conversation history (caller manages this array)
 */
export async function sendMessage(
  systemPrompt: string,
  messages: ConversationMessage[]
): Promise<string> {
  if (!client) {
    throw new Error('LLM client not initialized. Call initLLMClient() first.');
  }

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  log(`[llm-client] Sending message (model: ${model}, history: ${messages.length} turns)`);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages: messages as Anthropic.MessageParam[],
    });

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    log(`[llm-client] Response received. Tokens: ${inputTokens} in / ${outputTokens} out`);

    // Extract text from the first content block
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text block in Claude response');
    }

    const preview = textBlock.text.substring(0, 100).replace(/\n/g, ' ');
    log(`[llm-client] Response preview: ${preview}...`);

    return textBlock.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[llm-client] API call failed: ${message}`);
    // Return a JSON error string so the response parser can handle it gracefully
    return JSON.stringify({ status: 'error', error: `API call failed: ${message}` });
  }
}

/**
 * Clear the conversation history — call at the start of each new goal.
 * (History is owned by the caller; this is a no-op placeholder kept for
 *  API symmetry. The caller passes its own array to sendMessage().)
 */
export function resetConversation(): void {
  log('[llm-client] Conversation reset (new goal)');
  // The actual history array lives in the runAgentLoop caller.
  // This function exists so the caller can call it as a clear signal
  // of intent without needing to know the implementation detail.
}
