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
const MAX_RETRIES = 3;
const RETRY_DELAYS_SEC = [5, 10, 20];
const RECENT_TURNS_TO_KEEP = 10; // keep last 5 pairs (user+assistant) with full images

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isApiError(err: unknown): err is { status: number; message: string } {
  return typeof err === 'object' && err !== null && 'status' in err && typeof (err as Record<string, unknown>).status === 'number';
}

/**
 * Prune older messages to keep token usage flat:
 *  - Images: replaced with a short text placeholder
 *  - Text in user observations: compressed to a 1-line summary
 *  - Text in assistant responses: compressed to action taken
 * Keeps the most recent RECENT_TURNS_TO_KEEP messages with full content.
 * Returns a new array — does NOT modify the original.
 */
function pruneOldMessages(messages: ConversationMessage[]): ConversationMessage[] {
  if (messages.length <= RECENT_TURNS_TO_KEEP) return messages;

  const cutoff = messages.length - RECENT_TURNS_TO_KEEP;
  return messages.map((msg, i) => {
    if (i >= cutoff) return msg; // recent — keep as-is

    // --- Prune assistant messages (plain text JSON) ---
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      return { ...msg, content: summarizeAssistantMessage(msg.content) };
    }

    // --- Prune user messages with content blocks ---
    if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
      const prunedContent = msg.content.map((block) => {
        if (block.type === 'image') {
          return { type: 'text' as const, text: '[Screenshot removed]' };
        }
        if (block.type === 'text') {
          return { type: 'text' as const, text: summarizeObservationText(block.text) };
        }
        return block;
      });
      return { ...msg, content: prunedContent };
    }

    // --- Prune plain-text user messages (error corrections, result feedback) ---
    if (msg.role === 'user' && typeof msg.content === 'string') {
      if (msg.content.length > 500) {
        return { ...msg, content: msg.content.substring(0, 300) + '... [truncated]' };
      }
    }

    return msg;
  });
}

/**
 * Compress a user observation text block into a 1-line summary.
 * Extracts: app name, step number, element count — drops the full element list.
 */
function summarizeObservationText(text: string): string {
  const stepMatch = text.match(/STEP (\d+)/);
  const appMatch = text.match(/Frontmost App: (.+)/);
  const titleMatch = text.match(/Window Title: (.+)/);
  const browserElMatch = text.match(/BROWSER ELEMENTS \((\d+)/);
  const desktopElMatch = text.match(/DESKTOP ELEMENTS \((\d+)/);
  const shellMatch = text.match(/SHELL COMMAND RESULT[^:]*:\n([\s\S]{0,200})/);

  const step = stepMatch ? stepMatch[1] : '?';
  const app = appMatch ? appMatch[1].trim() : 'unknown';
  const title = titleMatch ? titleMatch[1].trim().substring(0, 40) : '';
  const elCount = browserElMatch ? `${browserElMatch[1]} browser els` :
    desktopElMatch ? `${desktopElMatch[1]} desktop els` : 'no elements';

  let summary = `[Step ${step}: ${app}${title ? ` — "${title}"` : ''}, ${elCount}]`;

  if (shellMatch) {
    summary += ` Shell output: ${shellMatch[1].trim().substring(0, 100)}`;
  }

  return summary;
}

/**
 * Compress an assistant JSON response into the action that was taken.
 */
function summarizeAssistantMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.action && typeof parsed.action === 'object') {
      const action = parsed.action as Record<string, unknown>;
      const params = action.params as Record<string, unknown> || {};
      const paramKeys = Object.keys(params).filter(k => {
        const v = params[k];
        return typeof v === 'string' && v.length < 100;
      });
      const paramSummary = paramKeys.slice(0, 3).map(k => `${k}=${params[k]}`).join(', ');
      return `[Action: ${action.layer}/${action.action}${paramSummary ? ` (${paramSummary})` : ''}]`;
    }
    if (parsed.status === 'complete') {
      return `[Complete: ${String(parsed.summary || '').substring(0, 100)}]`;
    }
    if (parsed.status === 'needs_help') {
      return `[Needs help: ${String(parsed.question || '').substring(0, 100)}]`;
    }
  } catch {
    // Not JSON — just truncate
  }
  if (text.length > 200) {
    return text.substring(0, 150) + '... [truncated]';
  }
  return text;
}

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

  // Prune old messages to keep token usage flat (images removed, text compressed)
  const prunedMessages = pruneOldMessages(messages);
  if (messages.length > RECENT_TURNS_TO_KEEP) {
    const prunedCount = messages.length - RECENT_TURNS_TO_KEEP;
    log(`[llm-client] Pruned ${prunedCount} older message(s) (images removed, text compressed)`);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages: prunedMessages as Anthropic.MessageParam[],
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
      const statusCode = isApiError(err) ? err.status : 0;
      const isRetryable = statusCode === 429 || statusCode === 529;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_SEC[attempt];
        const label = statusCode === 429 ? 'Rate limited' : 'API overloaded';
        log(`[llm-client] ${label} (${statusCode}) — retrying in ${delay}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay * 1000);
        continue;
      }

      const message = err instanceof Error ? err.message : String(err);
      logError(`[llm-client] API call failed: ${message}`);
      // Return a JSON error string so the response parser can handle it gracefully
      return JSON.stringify({ status: 'error', error: `API call failed: ${message}` });
    }
  }

  // Should never reach here, but satisfy TypeScript
  return JSON.stringify({ status: 'error', error: 'Unexpected: exhausted retry loop' });
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
