/**
 * Bridge Server — Relays messages between the Dashboard and the Local Agent.
 *
 * Architecture:
 *   Dashboard (browser WS) → Bridge Server ← Local Agent (Node WS)
 *
 * The bridge server:
 *   1. Accepts WebSocket connections from both the dashboard and the local agent
 *   2. Hosts the agent loop (Claude-powered observe-decide-act)
 *   3. Routes commands to the agent and responses back to the dashboard
 *
 * Run with:  npm run dev  (from the server/ directory)
 */

import { WebSocketServer, WebSocket } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  DEFAULT_WS_PORT,
  AgentCommand,
  AgentResult,
  AgentHello,
  DashboardHello,
  DashboardChatMessage,
  DashboardWorkflowRun,
  DashboardWorkflowCancel,
  ServerChatResponse,
  ServerAgentProgress,
  ServerAgentStatus,
  ServerWorkflowProgress,
  WebSocketMessage,
} from '@workflow-agent/shared';

// Load .env from repo root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.ANTHROPIC_API_KEY) {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}
if (!process.env.ANTHROPIC_API_KEY) {
  dotenv.config(); // cwd fallback
}

// Agent loop types (mirrored from local-agent to avoid cross-package TS imports)
interface AgentLoopCallbacks {
  onStep?: (step: number, maxIterations: number) => void;
  onObservation?: (obs: unknown, step: number) => void;
  onThinking?: () => void;
  onParsed?: (parsed: unknown, step: number) => void;
  onAction?: (command: AgentCommand, thinking: string) => void;
  onComplete?: (summary: string) => void;
  onNeedsHelp?: (question: string) => void;
  onError?: (error: string, context: string) => void;
}

interface AgentLoopConfig {
  goal: string;
  sendAndWait: (cmd: AgentCommand) => Promise<AgentResult>;
  callbacks?: AgentLoopCallbacks;
  maxIterations?: number;
}

interface AgentLoopResult {
  outcome: string;
  summary: string;
  steps: number;
  question?: string;
  app?: string;
  discovery?: unknown;
}

// Agent loop imports (from local-agent package)
// Loaded dynamically at runtime from local-agent/dist/ to avoid cross-package TS issues.
let runAgentLoop: ((config: AgentLoopConfig) => Promise<AgentLoopResult>) | null = null;
let formatWorkflowAsGoal: ((workflow: unknown) => string) | null = null;

async function loadAgentModules(): Promise<boolean> {
  try {
    const agentLoopModule = require('../../local-agent/dist/src/agent/agent-loop');
    runAgentLoop = agentLoopModule.runAgentLoop;

    const workflowModule = require('../../local-agent/dist/src/agent/workflow-executor');
    formatWorkflowAsGoal = workflowModule.formatWorkflowAsGoal;

    log('Agent loop modules loaded successfully');
    return true;
  } catch (err) {
    log(`Warning: Could not load agent loop modules: ${err instanceof Error ? err.message : String(err)}`);
    log('Agent loop features will be unavailable. Build local-agent first: cd local-agent && npm run build');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${timestamp()}] [bridge] ${message}`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let agentSocket: WebSocket | null = null;
let dashboardSocket: WebSocket | null = null;
let commandCounter = 0;
let agentLoopActive = false;
let agentModulesLoaded = false;

/** Agent info from hello message */
let agentInfo: { name: string; version: string; platform: string; layers: string[] } | null = null;

/** Pending command responses (same pattern as test-server) */
const pendingCommands: Map<string, (result: AgentResult) => void> = new Map();

// ---------------------------------------------------------------------------
// Simple Claude Chat (NOT the vision agent loop — just text conversation)
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

/** Per-conversation chat history for simple text chat with Claude */
const chatHistories: Map<string, Array<{ role: 'user' | 'assistant'; content: string }>> = new Map();

const CHAT_SYSTEM_PROMPT = `You are the assistant embedded in a B2B workflow automation platform. The platform helps companies automate repetitive tasks across HR, accounting, procurement, and operations.

You help users with:
- Understanding and managing their automated workflows
- Answering questions about workflow status, scheduling, and configuration
- General questions and conversation

Rules you must always follow:
- Never use emojis. Not a single one.
- Write in a calm, professional, concise tone. No filler words, no exclamation marks.
- Keep responses short and direct. Use plain text, not markdown headers or bullet-heavy formatting.
- You do not have access to the user's screen or computer. You are text-only.
- If the user asks you to perform a desktop action, explain they need to start a recorded workflow or use a direct command (/shell, /browser, /ax, /vision).
- Do not invent information about the user's workflows or data. If you do not know, say so.`;

function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/** Simple text chat with Claude — no vision, no screenshots, no agent loop */
async function simpleChatWithClaude(conversationId: string, userMessage: string): Promise<string> {
  const client = getAnthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  // Get or create conversation history
  if (!chatHistories.has(conversationId)) {
    chatHistories.set(conversationId, []);
  }
  const history = chatHistories.get(conversationId)!;

  // Add user message
  history.push({ role: 'user', content: userMessage });

  // Keep last 20 messages to avoid token bloat
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: CHAT_SYSTEM_PROMPT,
    messages: history,
  });

  // Extract text response
  const assistantText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  // Add to history
  history.push({ role: 'assistant', content: assistantText });

  return assistantText;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextId(): string {
  commandCounter++;
  return `cmd_${commandCounter}`;
}

/** Send a message to the local agent */
function sendToAgent(message: Record<string, unknown>): boolean {
  if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
    return false;
  }
  agentSocket.send(JSON.stringify(message));
  return true;
}

/** Send a message to the dashboard */
function sendToDashboard(message: WebSocketMessage): void {
  if (!dashboardSocket || dashboardSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  dashboardSocket.send(JSON.stringify(message));
}

/** Send agent status to dashboard */
function broadcastAgentStatus(): void {
  const status: ServerAgentStatus = {
    type: 'server_agent_status',
    agentConnected: agentSocket !== null && agentSocket.readyState === WebSocket.OPEN,
    agentName: agentInfo?.name,
    supportedLayers: agentInfo?.layers as ServerAgentStatus['supportedLayers'],
  };
  sendToDashboard(status);
}

/**
 * Send a command to the agent and wait for the result.
 * Same pattern as test-server's sendCommandAndWait (lines 314-334).
 */
function sendCommandAndWait(command: AgentCommand, timeoutMs: number = 30000): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(command.id);
      reject(new Error(`Command ${command.id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCommands.set(command.id, (result: AgentResult) => {
      clearTimeout(timer);
      pendingCommands.delete(command.id);
      resolve(result);
    });

    const sent = sendToAgent(command as unknown as Record<string, unknown>);
    if (!sent) {
      clearTimeout(timer);
      pendingCommands.delete(command.id);
      reject(new Error('Failed to send command — agent not connected'));
    }
  });
}

// ---------------------------------------------------------------------------
// Direct command parser (/shell, /browser, /ax, /vision)
// ---------------------------------------------------------------------------

function parseDirectCommand(content: string): AgentCommand | null {
  const trimmed = content.trim();

  // /shell <command>
  if (trimmed.startsWith('/shell ')) {
    const shellCmd = trimmed.slice(7).trim();
    return {
      type: 'command',
      id: nextId(),
      layer: 'shell',
      action: 'exec',
      params: { command: shellCmd },
    };
  }

  // /browser <action> [args...]
  if (trimmed.startsWith('/browser ')) {
    const parts = trimmed.slice(9).trim().split(/\s+/);
    const action = parts[0] || 'snapshot';
    const params: Record<string, unknown> = {};

    switch (action) {
      case 'navigate':
        params.url = parts.slice(1).join(' ');
        break;
      case 'click':
        params.ref = parts[1];
        break;
      case 'type':
        params.ref = parts[1];
        params.text = parts.slice(2).join(' ');
        break;
      case 'select':
        params.ref = parts[1];
        params.value = parts.slice(2).join(' ');
        break;
    }

    return {
      type: 'command',
      id: nextId(),
      layer: 'cdp',
      action,
      params,
    };
  }

  // /ax <action> [args...]
  if (trimmed.startsWith('/ax ')) {
    const parts = trimmed.slice(4).trim().split(/\s+/);
    const action = parts[0] || 'snapshot';
    const params: Record<string, unknown> = {};

    switch (action) {
      case 'tree':
      case 'snapshot':
      case 'windows':
        params.app = parts.slice(1).join(' ');
        break;
      case 'click':
      case 'press_button':
      case 'focus':
      case 'getvalue':
        params.ref = parts[1];
        break;
      case 'setvalue':
        params.ref = parts[1];
        params.value = parts.slice(2).join(' ');
        break;
    }

    return {
      type: 'command',
      id: nextId(),
      layer: 'accessibility',
      action: action === 'click' ? 'press_button' : action,
      params,
    };
  }

  // /vision <action> [args...]
  if (trimmed.startsWith('/vision ')) {
    const parts = trimmed.slice(8).trim().split(/\s+/);
    const action = parts[0] || 'screenshot';
    const params: Record<string, unknown> = {};

    switch (action) {
      case 'click':
        params.x = parseInt(parts[1], 10);
        params.y = parseInt(parts[2], 10);
        break;
      case 'type':
        params.text = parts.slice(1).join(' ');
        break;
      case 'key':
        params.keys = parts.slice(1);
        break;
    }

    return {
      type: 'command',
      id: nextId(),
      layer: 'vision',
      action: action === 'key' ? 'key_combo' : action,
      params,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Chat message handler
// ---------------------------------------------------------------------------

async function handleChatMessage(msg: DashboardChatMessage): Promise<void> {
  const { id, conversationId, content, isDirect } = msg;

  // Direct command mode (/shell, /browser, /ax, /vision) — requires agent connection
  if (isDirect) {
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
      sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: {
          id: `resp_${id}`,
          role: 'system',
          type: 'error',
          content: 'Agent is not connected. Start the local agent and try again.',
        },
      });
      return;
    }

    const command = parseDirectCommand(content);
    if (!command) {
      sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: {
          id: `resp_${id}`,
          role: 'system',
          type: 'error',
          content: `Unknown direct command. Supported: /shell, /browser, /ax, /vision`,
        },
      });
      return;
    }

    try {
      const result = await sendCommandAndWait(command);
      sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: {
          id: `resp_${id}`,
          role: 'agent',
          type: 'text',
          content: result.status === 'success'
            ? `\`\`\`\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
            : `Error: ${JSON.stringify(result.data)}`,
        },
      });
    } catch (err) {
      sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: {
          id: `resp_${id}`,
          role: 'system',
          type: 'error',
          content: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
    return;
  }

  // Normal chat — simple text conversation with Claude (NO vision, NO screenshots)
  // This is cheap (~500-2000 tokens per exchange, NOT 15K+ per agent loop step)
  if (!process.env.ANTHROPIC_API_KEY) {
    sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: {
        id: `resp_${id}`,
        role: 'system',
        type: 'error',
        content: 'ANTHROPIC_API_KEY not configured. Add it to .env at the repo root.',
      },
    });
    return;
  }

  log(`Chat message: "${content.substring(0, 80)}"`);

  try {
    const reply = await simpleChatWithClaude(conversationId, content);
    sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: {
        id: `resp_${id}`,
        role: 'agent',
        type: 'text',
        content: reply,
      },
    });
  } catch (err) {
    sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: {
        id: `resp_${id}`,
        role: 'system',
        type: 'error',
        content: `Chat error: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Workflow execution handler
// ---------------------------------------------------------------------------

async function handleWorkflowRun(msg: DashboardWorkflowRun): Promise<void> {
  const { workflowId, workflowName } = msg;

  if (!agentModulesLoaded || !process.env.ANTHROPIC_API_KEY) {
    sendToDashboard({
      type: 'server_workflow_progress',
      workflowId,
      step: 0,
      totalSteps: 0,
      currentStepName: 'Error',
      status: 'error',
      summary: 'Agent loop modules not available or API key missing.',
    });
    return;
  }

  if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
    sendToDashboard({
      type: 'server_workflow_progress',
      workflowId,
      step: 0,
      totalSteps: 0,
      currentStepName: 'Error',
      status: 'error',
      summary: 'Agent is not connected.',
    });
    return;
  }

  if (agentLoopActive) {
    sendToDashboard({
      type: 'server_workflow_progress',
      workflowId,
      step: 0,
      totalSteps: 0,
      currentStepName: 'Error',
      status: 'error',
      summary: 'Another task is already running.',
    });
    return;
  }

  agentLoopActive = true;
  log(`Running workflow: ${workflowName} (${workflowId})`);

  // For now, use the workflow name as the goal directly
  // In the future, load the actual workflow JSON and call formatWorkflowAsGoal()
  const goal = `Execute the workflow "${workflowName}". Follow standard operating procedures for this type of task.`;

  try {
    const maxIter = parseInt(process.env.AGENT_MAX_ITERATIONS || '10', 10);
    const result = await runAgentLoop!({
      goal,
      sendAndWait: sendCommandAndWait,
      maxIterations: maxIter,
      callbacks: {
        onStep: (step: number, maxIterations: number) => {
          sendToDashboard({
            type: 'server_workflow_progress',
            workflowId,
            step,
            totalSteps: maxIterations,
            currentStepName: `Step ${step}`,
            status: 'running',
          });
        },
        onAction: (command: AgentCommand, thinking: string) => {
          sendToDashboard({
            type: 'server_workflow_progress',
            workflowId,
            step: 0,
            totalSteps: 0,
            currentStepName: thinking.substring(0, 100),
            status: 'running',
          });
        },
      },
    });

    sendToDashboard({
      type: 'server_workflow_progress',
      workflowId,
      step: result.steps,
      totalSteps: result.steps,
      currentStepName: 'Complete',
      status: result.outcome === 'complete' ? 'complete' : 'error',
      summary: result.summary,
    });
  } catch (err) {
    sendToDashboard({
      type: 'server_workflow_progress',
      workflowId,
      step: 0,
      totalSteps: 0,
      currentStepName: 'Error',
      status: 'error',
      summary: `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    agentLoopActive = false;
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Try to load agent modules
  agentModulesLoaded = await loadAgentModules();

  const wss = new WebSocketServer({ port: DEFAULT_WS_PORT });
  log(`WebSocket server started on ws://localhost:${DEFAULT_WS_PORT}`);
  log('Waiting for connections from dashboard and/or local agent...');

  wss.on('connection', (ws: WebSocket) => {
    log('New WebSocket connection');

    ws.on('message', (data: Buffer) => {
      const raw = data.toString();

      let msg: WebSocketMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        log('Received malformed message, ignoring');
        return;
      }

      switch (msg.type) {
        // Local Agent connected
        case 'hello': {
          const hello = msg as AgentHello;
          agentSocket = ws;
          agentInfo = {
            name: hello.agentName,
            version: hello.version,
            platform: hello.platform,
            layers: hello.supportedLayers,
          };
          log(`Agent connected: ${hello.agentName} v${hello.version} (${hello.platform})`);
          log(`Supported layers: ${hello.supportedLayers.join(', ')}`);
          broadcastAgentStatus();
          break;
        }

        // Dashboard connected
        case 'dashboard_hello': {
          const dhello = msg as DashboardHello;
          dashboardSocket = ws;
          log(`Dashboard connected: ${dhello.dashboardId} v${dhello.version}`);
          broadcastAgentStatus();
          break;
        }

        // Agent command result
        case 'result': {
          const result = msg as AgentResult;
          const handler = pendingCommands.get(result.id);
          if (handler) {
            handler(result);
          }
          break;
        }

        // Dashboard chat message
        case 'dashboard_chat': {
          handleChatMessage(msg as DashboardChatMessage).catch((err) => {
            log(`Chat handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
          break;
        }

        // Dashboard workflow run
        case 'dashboard_workflow_run': {
          handleWorkflowRun(msg as DashboardWorkflowRun).catch((err) => {
            log(`Workflow handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
          break;
        }

        // Dashboard workflow cancel
        case 'dashboard_workflow_cancel': {
          // TODO: Implement agent loop cancellation
          log(`Workflow cancel requested: ${(msg as DashboardWorkflowCancel).workflowId}`);
          break;
        }

        default:
          log(`Unknown message type: ${(msg as unknown as Record<string, unknown>).type}`);
      }
    });

    ws.on('close', () => {
      if (ws === agentSocket) {
        log('Agent disconnected');
        agentSocket = null;
        agentInfo = null;
        broadcastAgentStatus();
      } else if (ws === dashboardSocket) {
        log('Dashboard disconnected');
        dashboardSocket = null;
      } else {
        log('Unknown client disconnected');
      }
    });

    ws.on('error', (err) => {
      log(`WebSocket error: ${err.message}`);
    });
  });

  // Handle process signals
  process.on('SIGINT', () => {
    log('Shutting down...');
    wss.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Shutting down...');
    wss.close();
    process.exit(0);
  });
}

// Global error handlers — prevent crashes from orphaned connections
process.on('uncaughtException', (err: Error) => {
  // EIO / EPIPE errors are non-fatal (broken pipe when client disconnects)
  if (err.message && (err.message.includes('EIO') || err.message.includes('EPIPE'))) {
    return;
  }
  log(`Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`Unhandled rejection: ${msg}`);
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
