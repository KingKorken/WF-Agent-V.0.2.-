/**
 * Bridge Server — Relays messages between Dashboards and Local Agents.
 *
 * Architecture:
 *   Dashboard (browser WS) → Bridge Server ← Local Agent (Node WS)
 *
 * Room-based multi-tenancy: each tester gets a UUID room token.
 * Their agent and dashboard both connect to the same room via the token.
 * The bridge routes all messages within rooms, never across them.
 *
 * Run with:  npm run dev  (from the server/ directory)
 */

import { WebSocketServer, WebSocket } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as http from 'http';
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
  ServerRequestWorkflow,
  AgentWorkflowData,
  AgentSkillUpload,
  AgentSkillListRequest,
  ServerSkillListResult,
  ServerSkillBroadcast,
  WebSocketMessage,
  WorkflowDefinition,
} from '@workflow-agent/shared';
import { formatWorkflowAsGoal } from './workflow-formatter';
import { loadSkillsFromDisk, uploadSkill, getAllSkills } from './skill-repository';

// Load .env from repo root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.ANTHROPIC_API_KEY) {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}
if (!process.env.ANTHROPIC_API_KEY) {
  dotenv.config(); // cwd fallback
}

// ---------------------------------------------------------------------------
// Agent loop types (mirrored from local-agent to avoid cross-package TS imports)
// ---------------------------------------------------------------------------

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
// Note: formatWorkflowAsGoal is now imported from ./workflow-formatter (local to server package).
let runAgentLoop: ((config: AgentLoopConfig) => Promise<AgentLoopResult>) | null = null;

async function loadAgentModules(): Promise<boolean> {
  const basePath = process.env.AGENT_MODULES_PATH || path.join(__dirname, '../../local-agent/dist');

  try {
    const agentLoopModule = require(path.join(basePath, 'src/agent/agent-loop'));
    runAgentLoop = agentLoopModule.runAgentLoop;

    log('Agent loop modules loaded successfully');
    return true;
  } catch (err) {
    log(`Warning: Could not load agent loop modules from ${basePath}: ${err instanceof Error ? err.message : String(err)}`);
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

function logRoom(roomId: string, message: string): void {
  console.log(`[${timestamp()}] [room:${roomId.slice(0, 8)}] ${message}`);
}

// ---------------------------------------------------------------------------
// Message validation (P1 security fix — thin validation at JSON.parse boundary)
// ---------------------------------------------------------------------------

const KNOWN_MESSAGE_TYPES = new Set([
  'hello', 'dashboard_hello', 'result',
  'dashboard_chat', 'dashboard_workflow_run', 'dashboard_workflow_cancel',
  'dashboard_start_recording', 'dashboard_stop_recording',
  'dashboard_list_workflows', 'dashboard_get_workflow', 'dashboard_delete_workflow',
  'agent_recording_started', 'agent_recording_stopped', 'agent_recording_parsing',
  'agent_workflow_parsed', 'agent_workflow_list', 'agent_workflow_detail',
  'agent_workflow_deleted', 'agent_recording_error',
  'server_request_workflow', 'agent_workflow_data',
  'agent_skill_upload', 'agent_skill_list_request',
]);

function parseMessage(raw: string): WebSocketMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== 'string') return null;
    // Reject prototype pollution keys
    const keys = Object.keys(obj);
    if (keys.includes('__proto__') || keys.includes('constructor') || keys.includes('prototype')) return null;
    if (!KNOWN_MESSAGE_TYPES.has(obj.type)) return null;
    return parsed as WebSocketMessage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Room data structure
// ---------------------------------------------------------------------------

interface PendingCommand {
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** Typed pending request for workflow fetch (P1 fix: no implicit any) */
interface PendingWorkflowRequest {
  resolve: (value: WorkflowDefinition | null) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface AgentInfo {
  name: string;
  version: string;
  platform: string;
  layers: string[];
}

class Room {
  readonly id: string;
  private _agentSocket: WebSocket | null = null;
  private _dashboardSocket: WebSocket | null = null;
  private _agentInfo: AgentInfo | null = null;
  private _agentLoopActive = false;
  private _commandCounter = 0;
  private readonly _pendingCommands = new Map<string, PendingCommand>();
  private readonly _pendingWorkflowRequests = new Map<string, PendingWorkflowRequest>();
  private readonly _chatHistories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

  constructor(id: string) {
    this.id = id;
  }

  get agentSocket(): WebSocket | null { return this._agentSocket; }
  get dashboardSocket(): WebSocket | null { return this._dashboardSocket; }
  get agentInfo(): AgentInfo | null { return this._agentInfo; }
  get isAgentConnected(): boolean { return this._agentSocket !== null && this._agentSocket.readyState === WebSocket.OPEN; }
  get isDashboardConnected(): boolean { return this._dashboardSocket !== null && this._dashboardSocket.readyState === WebSocket.OPEN; }
  get agentLoopActive(): boolean { return this._agentLoopActive; }
  set agentLoopActive(val: boolean) { this._agentLoopActive = val; }
  get chatHistories(): Map<string, Array<{ role: 'user' | 'assistant'; content: string }>> { return this._chatHistories; }

  setAgentSocket(ws: WebSocket | null, info?: AgentInfo): void {
    this._agentSocket = ws;
    this._agentInfo = info ?? null;
  }

  clearAgentIfMatch(ws: WebSocket): boolean {
    if (this._agentSocket === ws) {
      this._agentSocket = null;
      this._agentInfo = null;
      return true;
    }
    return false;
  }

  setDashboardSocket(ws: WebSocket | null): void {
    this._dashboardSocket = ws;
  }

  clearDashboardIfMatch(ws: WebSocket): boolean {
    if (this._dashboardSocket === ws) {
      this._dashboardSocket = null;
      return true;
    }
    return false;
  }

  nextId(): string {
    this._commandCounter++;
    return `cmd_${this.id.slice(0, 8)}_${this._commandCounter}`;
  }

  sendToAgent(message: WebSocketMessage): boolean {
    if (!this._agentSocket || this._agentSocket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this._agentSocket.send(JSON.stringify(message));
    return true;
  }

  sendToDashboard(message: WebSocketMessage): void {
    if (!this._dashboardSocket || this._dashboardSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    this._dashboardSocket.send(JSON.stringify(message));
  }

  /** Send a pre-serialized string to the agent (avoids double-stringify for broadcasts) */
  sendRawToAgent(raw: string): boolean {
    if (!this._agentSocket || this._agentSocket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this._agentSocket.send(raw);
    return true;
  }

  broadcastAgentStatus(): void {
    const status: ServerAgentStatus = {
      type: 'server_agent_status',
      agentConnected: this.isAgentConnected,
      agentName: this._agentInfo?.name,
      supportedLayers: this._agentInfo?.layers as ServerAgentStatus['supportedLayers'],
    };
    this.sendToDashboard(status);
  }

  rejectAllPending(reason: string): void {
    for (const [id, pending] of this._pendingCommands) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    this._pendingCommands.clear();

    for (const [id, pending] of this._pendingWorkflowRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
    }
    this._pendingWorkflowRequests.clear();
  }

  sendCommandAndWait(command: AgentCommand, timeoutMs = 30000): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._pendingCommands.delete(command.id);
        reject(new Error(`Command ${command.id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingCommands.set(command.id, {
        resolve: (result: AgentResult) => {
          clearTimeout(timeoutId);
          this._pendingCommands.delete(command.id);
          resolve(result);
        },
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          this._pendingCommands.delete(command.id);
          reject(err);
        },
        timeoutId,
      });

      const sent = this.sendToAgent(command);
      if (!sent) {
        clearTimeout(timeoutId);
        this._pendingCommands.delete(command.id);
        reject(new Error('Failed to send command — agent not connected'));
      }
    });
  }

  handleCommandResult(result: AgentResult): void {
    const pending = this._pendingCommands.get(result.id);
    if (pending) {
      pending.resolve(result);
    }
  }

  /**
   * Request a workflow definition from the connected agent.
   * Uses requestId correlation with timeout for reliable request-response.
   */
  requestWorkflowFromAgent(workflowId: string, timeoutMs = 10000): Promise<WorkflowDefinition | null> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();

      const timeoutId = setTimeout(() => {
        this._pendingWorkflowRequests.delete(requestId);
        resolve(null); // Timeout → fall back to text-based goal
      }, timeoutMs);

      this._pendingWorkflowRequests.set(requestId, {
        resolve: (value: WorkflowDefinition | null) => {
          clearTimeout(timeoutId);
          this._pendingWorkflowRequests.delete(requestId);
          resolve(value);
        },
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          this._pendingWorkflowRequests.delete(requestId);
          reject(err);
        },
        timeoutId,
      });

      const request: ServerRequestWorkflow = {
        type: 'server_request_workflow',
        requestId,
        workflowId,
      };

      const sent = this.sendToAgent(request);
      if (!sent) {
        clearTimeout(timeoutId);
        this._pendingWorkflowRequests.delete(requestId);
        resolve(null); // Agent not connected → fall back
      }
    });
  }

  /**
   * Handle an agent_workflow_data response, resolving the matching pending request.
   */
  handleWorkflowDataResponse(msg: AgentWorkflowData): void {
    const pending = this._pendingWorkflowRequests.get(msg.requestId);
    if (!pending) return; // Already timed out or duplicate
    if (msg.found) {
      pending.resolve(msg.workflow);
    } else {
      pending.resolve(null);
    }
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const rooms = new Map<string, Room>();
let agentModulesLoaded = false;

/** Find which room a socket belongs to */
function findRoomBySocket(ws: WebSocket): Room | undefined {
  for (const room of rooms.values()) {
    if (room.agentSocket === ws || room.dashboardSocket === ws) {
      return room;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rate limiting — single global counter (sufficient for 5 testers)
// ---------------------------------------------------------------------------

let globalChatCount = 0;
const GLOBAL_CHAT_LIMIT = 60; // 60 messages per minute across all rooms

setInterval(() => { globalChatCount = 0; }, 60_000);

// ---------------------------------------------------------------------------
// Origin validation
// ---------------------------------------------------------------------------

const ALLOWED_ORIGIN_EXACT = new Set([
  'https://wfa-v2.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
]);

/** Vercel generates unique preview URLs per deployment (e.g. wfa-v2-abc123-user.vercel.app) */
function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGIN_EXACT.has(origin)) return true;
  try {
    const url = new URL(origin);
    // Allow any *.vercel.app subdomain (covers preview + production deployments)
    if (url.hostname.endsWith('.vercel.app')) return true;
  } catch {
    // Malformed origin — reject
  }
  return false;
}

// ---------------------------------------------------------------------------
// Simple Claude Chat
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

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

/** Strip base64 image data from content before storing in chat history */
function stripBase64(content: string): string {
  // Replace base64 data URIs and raw base64 blocks (>100 chars of base64 chars)
  return content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, '[screenshot omitted]');
}

/** Simple text chat with Claude — no vision, no screenshots, no agent loop */
async function simpleChatWithClaude(room: Room, conversationId: string, userMessage: string): Promise<string> {
  const client = getAnthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const histories = room.chatHistories;
  if (!histories.has(conversationId)) {
    histories.set(conversationId, []);
  }
  const history = histories.get(conversationId)!;

  // Strip base64 and cap message size before storing
  const cleaned = stripBase64(userMessage).slice(0, 10_000);
  history.push({ role: 'user', content: cleaned });

  // Keep last 50 messages to bound memory
  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: CHAT_SYSTEM_PROMPT,
    messages: history,
  });

  const assistantText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  history.push({ role: 'assistant', content: assistantText });

  return assistantText;
}

// ---------------------------------------------------------------------------
// Direct command parser (/shell, /browser, /ax, /vision)
// ---------------------------------------------------------------------------

function parseDirectCommand(room: Room, content: string): AgentCommand | null {
  const trimmed = content.trim();

  if (trimmed.startsWith('/shell ')) {
    return {
      type: 'command',
      id: room.nextId(),
      layer: 'shell',
      action: 'exec',
      params: { command: trimmed.slice(7).trim() },
    };
  }

  if (trimmed.startsWith('/browser ')) {
    const parts = trimmed.slice(9).trim().split(/\s+/);
    const action = parts[0] || 'snapshot';
    const params: Record<string, unknown> = {};
    switch (action) {
      case 'navigate': params.url = parts.slice(1).join(' '); break;
      case 'click': params.ref = parts[1]; break;
      case 'type': params.ref = parts[1]; params.text = parts.slice(2).join(' '); break;
      case 'select': params.ref = parts[1]; params.value = parts.slice(2).join(' '); break;
    }
    return { type: 'command', id: room.nextId(), layer: 'cdp', action, params };
  }

  if (trimmed.startsWith('/ax ')) {
    const parts = trimmed.slice(4).trim().split(/\s+/);
    const action = parts[0] || 'snapshot';
    const params: Record<string, unknown> = {};
    switch (action) {
      case 'tree': case 'snapshot': case 'windows':
        params.app = parts.slice(1).join(' '); break;
      case 'click': case 'press_button': case 'focus': case 'getvalue':
        params.ref = parts[1]; break;
      case 'setvalue':
        params.ref = parts[1]; params.value = parts.slice(2).join(' '); break;
    }
    return {
      type: 'command', id: room.nextId(),
      layer: 'accessibility', action: action === 'click' ? 'press_button' : action, params,
    };
  }

  if (trimmed.startsWith('/vision ')) {
    const parts = trimmed.slice(8).trim().split(/\s+/);
    const action = parts[0] || 'screenshot';
    const params: Record<string, unknown> = {};
    switch (action) {
      case 'click': params.x = parseInt(parts[1], 10); params.y = parseInt(parts[2], 10); break;
      case 'type': params.text = parts.slice(1).join(' '); break;
      case 'key': params.keys = parts.slice(1); break;
    }
    return {
      type: 'command', id: room.nextId(),
      layer: 'vision', action: action === 'key' ? 'key_combo' : action, params,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Chat message handler (room-scoped)
// ---------------------------------------------------------------------------

async function handleChatMessage(room: Room, msg: DashboardChatMessage): Promise<void> {
  const { id, conversationId, content, isDirect } = msg;

  // Rate limit check
  if (globalChatCount >= GLOBAL_CHAT_LIMIT) {
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: {
        id: `resp_${id}`,
        role: 'system',
        type: 'error',
        content: 'Rate limit reached. Please wait a moment before sending more messages.',
      },
    });
    return;
  }
  globalChatCount++;

  // Direct command mode (/shell, /browser, /ax, /vision)
  if (isDirect) {
    if (!room.isAgentConnected) {
      room.sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: { id: `resp_${id}`, role: 'system', type: 'error', content: 'Agent is not connected. Start the local agent and try again.' },
      });
      return;
    }

    const command = parseDirectCommand(room, content);
    if (!command) {
      room.sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: { id: `resp_${id}`, role: 'system', type: 'error', content: 'Unknown direct command. Supported: /shell, /browser, /ax, /vision' },
      });
      return;
    }

    try {
      const result = await room.sendCommandAndWait(command);
      room.sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: {
          id: `resp_${id}`, role: 'agent', type: 'text',
          content: result.status === 'success'
            ? `\`\`\`\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
            : `Error: ${JSON.stringify(result.data)}`,
        },
      });
    } catch (err) {
      room.sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: { id: `resp_${id}`, role: 'system', type: 'error', content: `Command failed: ${err instanceof Error ? err.message : String(err)}` },
      });
    }
    return;
  }

  // Normal chat — simple text conversation with Claude
  if (!process.env.ANTHROPIC_API_KEY) {
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_${id}`, role: 'system', type: 'error', content: 'ANTHROPIC_API_KEY not configured.' },
    });
    return;
  }

  logRoom(room.id, `Chat: "${content.substring(0, 80)}"`);

  try {
    const reply = await simpleChatWithClaude(room, conversationId, content);
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_${id}`, role: 'agent', type: 'text', content: reply },
    });
  } catch (err) {
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_${id}`, role: 'system', type: 'error', content: `Chat error: ${err instanceof Error ? err.message : String(err)}` },
    });
  }
}

// ---------------------------------------------------------------------------
// Workflow execution handler (room-scoped)
// ---------------------------------------------------------------------------

async function handleWorkflowRun(room: Room, msg: DashboardWorkflowRun): Promise<void> {
  const { workflowId, workflowName } = msg;

  if (!agentModulesLoaded || !process.env.ANTHROPIC_API_KEY) {
    room.sendToDashboard({
      type: 'server_workflow_progress', workflowId,
      step: 0, totalSteps: 0, currentStepName: 'Error', status: 'error',
      summary: 'Agent loop modules not available or API key missing.',
    });
    return;
  }

  if (!room.isAgentConnected) {
    room.sendToDashboard({
      type: 'server_workflow_progress', workflowId,
      step: 0, totalSteps: 0, currentStepName: 'Error', status: 'error',
      summary: 'Agent is not connected.',
    });
    return;
  }

  if (room.agentLoopActive) {
    room.sendToDashboard({
      type: 'server_workflow_progress', workflowId,
      step: 0, totalSteps: 0, currentStepName: 'Error', status: 'error',
      summary: 'Another task is already running.',
    });
    return;
  }

  room.agentLoopActive = true;
  logRoom(room.id, `Running workflow: ${workflowName} (${workflowId})`);

  // Request structured workflow definition from the agent
  let goal: string;
  try {
    logRoom(room.id, `Requesting workflow data from agent: ${workflowId}`);
    const workflow = await room.requestWorkflowFromAgent(workflowId);

    if (workflow) {
      goal = formatWorkflowAsGoal(workflow);
      logRoom(room.id, `Using structured goal (${workflow.steps.length} steps, ${workflow.applications.length} apps)`);
    } else {
      // Fallback: agent didn't return workflow data (timeout, not found, or agent disconnected)
      goal = `Execute the workflow "${workflowName}". Follow standard operating procedures for this type of task.`;
      logRoom(room.id, `Workflow data unavailable — using text-based goal`);
    }
  } catch (err) {
    // Agent disconnected during request — use fallback
    goal = `Execute the workflow "${workflowName}". Follow standard operating procedures for this type of task.`;
    logRoom(room.id, `Workflow fetch error: ${err instanceof Error ? err.message : String(err)} — using text-based goal`);
  }

  try {
    const maxIter = parseInt(process.env.AGENT_MAX_ITERATIONS || '10', 10);
    const result = await runAgentLoop!({
      goal,
      sendAndWait: (cmd) => room.sendCommandAndWait(cmd),
      maxIterations: maxIter,
      callbacks: {
        onStep: (step: number, maxIterations: number) => {
          room.sendToDashboard({
            type: 'server_workflow_progress', workflowId,
            step, totalSteps: maxIterations, currentStepName: `Step ${step}`, status: 'running',
          });
        },
        onAction: (_command: AgentCommand, thinking: string) => {
          room.sendToDashboard({
            type: 'server_workflow_progress', workflowId,
            step: 0, totalSteps: 0, currentStepName: thinking.substring(0, 100), status: 'running',
          });
        },
      },
    });

    room.sendToDashboard({
      type: 'server_workflow_progress', workflowId,
      step: result.steps, totalSteps: result.steps, currentStepName: 'Complete',
      status: result.outcome === 'complete' ? 'complete' : 'error',
      summary: result.summary,
    });
  } catch (err) {
    room.sendToDashboard({
      type: 'server_workflow_progress', workflowId,
      step: 0, totalSteps: 0, currentStepName: 'Error', status: 'error',
      summary: `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    room.agentLoopActive = false;
  }
}

// ---------------------------------------------------------------------------
// Room validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasRoomId<T extends { roomId?: string }>(msg: T): msg is T & { roomId: string } {
  return typeof msg.roomId === 'string' && msg.roomId.length > 0;
}

function initializeRooms(): void {
  const roomsEnv = process.env.VALID_ROOMS;
  if (!roomsEnv) {
    // Local dev mode — no rooms pre-configured, allow any room ID
    log('No VALID_ROOMS set — running in local dev mode (single room, no auth)');
    return;
  }

  const tokens = roomsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) {
    log('VALID_ROOMS is empty — running in local dev mode');
    return;
  }

  for (const token of tokens) {
    if (!UUID_RE.test(token)) {
      console.error(`VALID_ROOMS contains invalid UUID: ${token}`);
      process.exit(1);
    }
    rooms.set(token, new Room(token));
  }

  log(`Loaded ${rooms.size} valid rooms`);
}

/** In local dev mode (no VALID_ROOMS), create rooms on demand */
function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    // Only allow dynamic room creation in local dev (no VALID_ROOMS set)
    if (process.env.VALID_ROOMS) {
      throw new Error('Unknown room ID');
    }
    room = new Room(roomId);
    rooms.set(roomId, room);
  }
  return room;
}

// ---------------------------------------------------------------------------
// WebSocket Server with HTTP health endpoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  agentModulesLoaded = await loadAgentModules();
  initializeRooms();
  loadSkillsFromDisk();

  const port = Number(process.env.PORT) || DEFAULT_WS_PORT;

  // HTTP server for health checks
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // WebSocket server with noServer for Origin validation
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 5 * 1024 * 1024, // 5MB — screenshots are 100-500KB base64 (P1 fix: was 64KB)
  });

  // Origin validation on HTTP upgrade
  httpServer.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      log(`Rejected connection from origin: ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // No origin = allow (Electron agent has no browser origin)
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Ping/pong heartbeat — prevents zombie connections
  const aliveClients = new Set<WebSocket>();

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!aliveClients.has(ws)) {
        ws.terminate();
        return;
      }
      aliveClients.delete(ws);
      ws.ping();
    });
  }, 45_000); // 45s interval — gives event loop headroom

  // ---------------------------------------------------------------------------
  // Connection handler
  // ---------------------------------------------------------------------------

  wss.on('connection', (ws: WebSocket) => {
    log('New WebSocket connection');
    aliveClients.add(ws);
    ws.on('pong', () => { aliveClients.add(ws); });

    ws.on('message', (data: Buffer) => {
      const raw = data.toString();
      const msg = parseMessage(raw);
      if (!msg) {
        log('Received invalid message, ignoring');
        return;
      }

      switch (msg.type) {
        // ----- Local Agent connected -----
        case 'hello': {
          const hello = msg as AgentHello;

          // Room validation
          const roomId = hello.roomId;
          if (!roomId && process.env.VALID_ROOMS) {
            ws.close(1008, 'Room ID required');
            return;
          }

          // Local dev fallback — use 'default' room
          const effectiveRoomId = roomId || 'default';

          let room: Room;
          try {
            room = getOrCreateRoom(effectiveRoomId);
          } catch {
            ws.close(1008, 'Unknown room ID');
            return;
          }

          // Replace old agent connection (close old, accept new — better UX for restarts)
          if (room.agentSocket && room.agentSocket !== ws && room.agentSocket.readyState === WebSocket.OPEN) {
            logRoom(effectiveRoomId, 'Replacing existing agent connection');
            room.rejectAllPending('Agent replaced by new connection');
            room.agentSocket.close(1008, 'Replaced by new agent connection');
          }

          room.setAgentSocket(ws, {
            name: hello.agentName,
            version: hello.version,
            platform: hello.platform,
            layers: hello.supportedLayers,
          });

          logRoom(effectiveRoomId, `Agent connected: ${hello.agentName} v${hello.version} (${hello.platform})`);
          room.broadcastAgentStatus();
          break;
        }

        // ----- Dashboard connected -----
        case 'dashboard_hello': {
          const dhello = msg as DashboardHello;

          const roomId = dhello.roomId;
          if (!roomId && process.env.VALID_ROOMS) {
            ws.close(1008, 'Room ID required');
            return;
          }

          const effectiveRoomId = roomId || 'default';

          let room: Room;
          try {
            room = getOrCreateRoom(effectiveRoomId);
          } catch {
            ws.close(1008, 'Unknown room ID');
            return;
          }

          // Replace old dashboard connection
          if (room.dashboardSocket && room.dashboardSocket !== ws && room.dashboardSocket.readyState === WebSocket.OPEN) {
            logRoom(effectiveRoomId, 'Replacing existing dashboard connection');
            room.dashboardSocket.close(1008, 'Replaced by new dashboard connection');
          }

          room.setDashboardSocket(ws);
          logRoom(effectiveRoomId, `Dashboard connected: ${dhello.dashboardId} v${dhello.version}`);
          // Immediately broadcast agent status so dashboard gets initial state
          room.broadcastAgentStatus();
          break;
        }

        // ----- Agent command result -----
        case 'result': {
          const result = msg as AgentResult;
          const room = findRoomBySocket(ws);
          if (room) {
            room.handleCommandResult(result);
          }
          break;
        }

        // ----- Dashboard chat message -----
        case 'dashboard_chat': {
          const room = findRoomBySocket(ws);
          if (room) {
            handleChatMessage(room, msg as DashboardChatMessage).catch((err) => {
              logRoom(room.id, `Chat handler error: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          break;
        }

        // ----- Dashboard workflow run -----
        case 'dashboard_workflow_run': {
          const room = findRoomBySocket(ws);
          if (room) {
            handleWorkflowRun(room, msg as DashboardWorkflowRun).catch((err) => {
              logRoom(room.id, `Workflow handler error: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          break;
        }

        // ----- Dashboard workflow cancel -----
        case 'dashboard_workflow_cancel': {
          const room = findRoomBySocket(ws);
          if (room) {
            logRoom(room.id, `Workflow cancel requested: ${(msg as DashboardWorkflowCancel).workflowId}`);
          }
          break;
        }

        // ----- Dashboard → Agent relay (recording & workflow CRUD) -----
        case 'dashboard_start_recording':
        case 'dashboard_stop_recording':
        case 'dashboard_list_workflows':
        case 'dashboard_get_workflow':
        case 'dashboard_delete_workflow': {
          const room = findRoomBySocket(ws);
          if (room) {
            logRoom(room.id, `Relaying ${msg.type} to agent`);
            if (!room.sendToAgent(msg)) {
              room.sendToDashboard({
                type: 'agent_recording_error',
                error: 'Agent is not connected.',
              } as WebSocketMessage);
            }
          }
          break;
        }

        // ----- Agent workflow data response (for structured workflow execution) -----
        case 'agent_workflow_data': {
          const room = findRoomBySocket(ws);
          if (room) {
            room.handleWorkflowDataResponse(msg as AgentWorkflowData);
          }
          break;
        }

        // ----- Agent → Dashboard relay (recording & workflow responses) -----
        case 'agent_recording_started':
        case 'agent_recording_stopped':
        case 'agent_recording_parsing':
        case 'agent_workflow_parsed':
        case 'agent_workflow_list':
        case 'agent_workflow_detail':
        case 'agent_workflow_deleted':
        case 'agent_recording_error': {
          const room = findRoomBySocket(ws);
          if (room) {
            logRoom(room.id, `Relaying ${msg.type} to dashboard`);
            room.sendToDashboard(msg);
          }
          break;
        }

        // ----- Agent uploads a skill to the shared skill base -----
        case 'agent_skill_upload': {
          const upload = msg as AgentSkillUpload;
          const result = uploadSkill(upload.skill);
          if (result.ok) {
            log(`Skill uploaded: ${upload.skill.app} (${upload.skill.id})`);
            // Broadcast to all OTHER connected agents
            const broadcast: ServerSkillBroadcast = {
              type: 'server_skill_broadcast',
              skill: result.skill,
            };
            const serialized = JSON.stringify(broadcast);
            for (const room of rooms.values()) {
              if (room.agentSocket !== ws) {
                room.sendRawToAgent(serialized);
              }
            }
          } else {
            log(`Skill upload rejected: ${result.error}`);
          }
          break;
        }

        // ----- Agent requests list of all shared skills -----
        case 'agent_skill_list_request': {
          const room = findRoomBySocket(ws);
          if (room) {
            const response: ServerSkillListResult = {
              type: 'server_skill_list_result',
              skills: getAllSkills(),
            };
            room.sendToAgent(response);
            logRoom(room.id, `Sent ${response.skills.length} shared skills to agent`);
          }
          break;
        }

        default:
          log(`Unknown message type: ${(msg as unknown as Record<string, unknown>).type}`);
      }
    });

    ws.on('close', () => {
      aliveClients.delete(ws);
      for (const room of rooms.values()) {
        if (room.clearAgentIfMatch(ws)) {
          logRoom(room.id, 'Agent disconnected');
          room.rejectAllPending('Agent disconnected');
          room.agentLoopActive = false;
          room.broadcastAgentStatus();
          return;
        }
        if (room.clearDashboardIfMatch(ws)) {
          logRoom(room.id, 'Dashboard disconnected');
          return;
        }
      }
      log('Unknown client disconnected');
    });

    ws.on('error', (err) => {
      log(`WebSocket error: ${err.message}`);
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  function shutdown(signal: string): void {
    log(`${signal} received, shutting down...`);
    clearInterval(heartbeatInterval);
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    wss.close(() => process.exit(0));
    // Force exit after 5 seconds if graceful close stalls
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start listening
  httpServer.listen(port, '0.0.0.0', () => {
    log(`Bridge server started on 0.0.0.0:${port}`);
    log(`Health check: http://localhost:${port}/health`);
    log('Waiting for connections from dashboard and/or local agent...');
  });
}

// Global error handlers — prevent crashes from orphaned connections
process.on('uncaughtException', (err: Error) => {
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
