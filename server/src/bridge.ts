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
  ServerActionPreview,
  DashboardActionConfirm,
  DashboardActionCancel,
  DashboardCancelTask,
  ServerCancelAck,
  ServerSubGoalProgress,
  ServerDebugLog,
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

interface SubGoal {
  id: string;
  label: string;
  description: string;
  app: string;
}

type SubGoalOutcome = 'complete' | 'stuck' | 'cancelled' | 'not_started';

interface SubGoalResult {
  subGoal: SubGoal;
  outcome: SubGoalOutcome;
}

interface AgentLoopCallbacks {
  onStep?: (step: number, maxIterations: number) => void;
  onObservation?: (obs: unknown, step: number) => void;
  onThinking?: () => void;
  onParsed?: (parsed: unknown, step: number) => void;
  onAction?: (command: AgentCommand, thinking: string) => void;
  onActionResult?: (command: AgentCommand, result: AgentResult) => void;
  onComplete?: (summary: string) => void;
  onNeedsHelp?: (question: string) => void;
  onError?: (error: string, context: string) => void;
  onDecomposition?: (subGoals: SubGoal[]) => void;
  onSubGoalStart?: (subGoal: SubGoal, index: number, total: number) => void;
  onSubGoalComplete?: (subGoal: SubGoal, index: number, total: number, outcome: SubGoalOutcome) => void;
}

interface AgentLoopConfig {
  goal: string;
  sendAndWait: (cmd: AgentCommand) => Promise<AgentResult>;
  callbacks?: AgentLoopCallbacks;
  maxIterations?: number;
  decompose?: boolean;
  signal?: { aborted: boolean };
}

interface AgentLoopResult {
  outcome: string;
  summary: string;
  steps: number;
  question?: string;
  app?: string;
  discovery?: unknown;
  subGoalResults?: SubGoalResult[];
}

// Agent loop imports (from local-agent package)
// Loaded dynamically at runtime from local-agent/dist/ to avoid cross-package TS issues.
// Note: formatWorkflowAsGoal is now imported from ./workflow-formatter (local to server package).
let runAgentLoop: ((config: AgentLoopConfig) => Promise<AgentLoopResult>) | null = null;

async function loadAgentModules(): Promise<boolean> {
  const basePath = process.env.AGENT_MODULES_PATH || path.join(__dirname, '../../local-agent/dist');
  const fullPath = path.join(basePath, 'src/agent/agent-loop');

  log(`[loadAgentModules] AGENT_MODULES_PATH env: ${process.env.AGENT_MODULES_PATH || '(not set, using default)'}`);
  log(`[loadAgentModules] Resolved base: ${basePath}`);
  log(`[loadAgentModules] Loading from: ${fullPath}`);

  try {
    const agentLoopModule = require(fullPath);
    runAgentLoop = agentLoopModule.runAgentLoop;

    if (!runAgentLoop) {
      log('CRITICAL: agent-loop module loaded but runAgentLoop export is missing');
      return false;
    }

    log('Agent loop modules loaded successfully');
    return true;
  } catch (err) {
    log(`CRITICAL: Could not load agent loop modules from ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      log(`Stack: ${err.stack}`);
    }
    log('Agent loop features will be unavailable. Task execution will fail.');
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

/** Send a debug log entry to the dashboard AND to fly logs */
function sendDebugLog(
  room: Room,
  level: ServerDebugLog['level'],
  source: string,
  message: string,
  detail?: string,
): void {
  const debugLog: ServerDebugLog = {
    type: 'server_debug_log',
    level,
    source,
    message,
    detail,
    timestamp: new Date().toISOString(),
  };
  room.sendToDashboard(debugLog);
  logRoom(room.id, `[debug:${level}] ${source}: ${message}${detail ? ` | ${detail}` : ''}`);
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
  'server_action_preview', 'dashboard_action_confirm', 'dashboard_action_cancel',
  'dashboard_cancel_task', 'server_cancel_ack',
  'server_debug_log',
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

interface PendingActionPreview {
  previewId: string;
  conversationId: string;
  originalMessage: string;
  plan: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
  complexity: 'simple' | 'multi-step';
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
  private _pendingPreview: PendingActionPreview | null = null;
  private _agentAbortSignal: { aborted: boolean } = { aborted: false };
  private _loopPromise: Promise<AgentLoopResult> | null = null;
  private _completedSubGoals: string[] = [];

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
  get pendingPreview(): PendingActionPreview | null { return this._pendingPreview; }
  set pendingPreview(val: PendingActionPreview | null) { this._pendingPreview = val; }
  get agentAbortSignal(): { aborted: boolean } { return this._agentAbortSignal; }
  resetAbortSignal(): void { this._agentAbortSignal = { aborted: false }; }
  abortAgent(): void { this._agentAbortSignal.aborted = true; }
  get loopPromise(): Promise<AgentLoopResult> | null { return this._loopPromise; }
  set loopPromise(val: Promise<AgentLoopResult> | null) { this._loopPromise = val; }
  get completedSubGoals(): string[] { return this._completedSubGoals; }
  set completedSubGoals(val: string[]) { this._completedSubGoals = val; }

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

const CHAT_SYSTEM_PROMPT = `You are an AI agent embedded in a desktop workflow automation platform. You are NOT just a text assistant — you are a fully capable agent that can control the user's desktop applications (email, browser, calendar, etc.) when given actionable instructions.

The platform helps knowledge workers automate repetitive tasks across HR, accounting, procurement, and operations by controlling desktop applications on the user's Mac.

You help users with:
- Executing desktop automation tasks (sending emails, scheduling meetings, filling forms, navigating applications)
- Understanding and managing their automated workflows
- Answering questions about workflow status, scheduling, and configuration
- General questions and conversation

Rules you must always follow:
- You ARE an AI agent, not just an assistant. If asked, confirm you can perform actions on the user's computer.
- Never say you cannot perform desktop actions, send emails, or interact with applications. You can.
- Never suggest the user needs to "set up a workflow" or "configure an automation" to perform a simple task. You can do it directly.
- Never pretend to have completed an action you did not actually perform. If an action was not executed through the agent loop, do not claim it was.
- Never use emojis. Not a single one.
- Write in a calm, professional, concise tone. No filler words, no exclamation marks.
- Keep responses short and direct. Use plain text, not markdown headers or bullet-heavy formatting.
- If the user asks you to perform a desktop action and you are in conversation mode, let them know they can rephrase their request as a direct instruction (e.g., "Send an email to Tim") and you will handle it.
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
// Message classification (action vs conversation)
// ---------------------------------------------------------------------------

interface ClassificationResult {
  intent: 'action' | 'conversation';
  plan: string;
  confidence: number;
  complexity: 'simple' | 'multi-step';
}

const CLASSIFICATION_PROMPT = `You are a message classifier for a workflow automation agent. Your job is to determine whether a user's message is an actionable task request or a conversational message.

ACTIONABLE: The user wants the agent to DO something on their computer — open an app, send an email, schedule a meeting, fill out a form, click buttons, navigate software, etc. These are imperative commands that require the agent to interact with desktop applications.

CONVERSATIONAL: The user is asking a question, making conversation, asking about capabilities, requesting information, or anything that can be answered with text alone.

Rules:
- Imperative commands ("Send an email to Tim", "Open Outlook", "Schedule a meeting") = action
- Questions about capabilities ("Can you send emails?", "What can you do?") = conversation
- Information requests ("What time is it?", "What's on my calendar?") = conversation
- Ambiguous statements ("I need to send Tim an email") = conversation (low confidence — let user rephrase)
- Contextual references ("Send that to Tim", "Do it again") = action if context supports it

Respond with ONLY a JSON object, no other text:
{"intent": "action" | "conversation", "plan": "short description of what the agent will do (only for action intent, empty string for conversation)", "confidence": 0.0-1.0, "complexity": "simple" | "multi-step"}

Complexity rules:
- "simple": single-app, 1-3 steps (e.g. "open Chrome", "take a screenshot")
- "multi-step": crosses apps, involves forms, requires multiple sequential actions (e.g. "send an email to Tim about the meeting", "schedule a meeting and email the agenda")`;

async function classifyMessage(
  userMessage: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  agentConnected: boolean,
  supportedLayers: string[],
): Promise<ClassificationResult> {
  const client = getAnthropicClient();
  if (!client) {
    return { intent: 'conversation', plan: '', confidence: 1.0, complexity: 'simple' };
  }

  // Build context from recent conversation history (last 10 messages)
  const recentHistory = conversationHistory.slice(-10);
  const historyContext = recentHistory.length > 0
    ? `\n\nRecent conversation (for resolving references like "send that to Tim"):\n${recentHistory.map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}`
    : '';

  const agentContext = agentConnected
    ? `\nThe local agent is connected and supports these layers: ${supportedLayers.join(', ')}.`
    : '\nThe local agent is NOT connected.';

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: CLASSIFICATION_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${agentContext}${historyContext}\n\nClassify this message: "${userMessage}"`,
      },
    ],
  });

  let text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  // Strip markdown code fences if Haiku wraps JSON in ```json ... ```
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }

  const parsed = JSON.parse(text) as ClassificationResult;

  // Validate the parsed result
  if (parsed.intent !== 'action' && parsed.intent !== 'conversation') {
    return { intent: 'conversation', plan: '', confidence: 1.0, complexity: 'simple' };
  }
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
    parsed.confidence = 0.5;
  }
  if (parsed.complexity !== 'simple' && parsed.complexity !== 'multi-step') {
    parsed.complexity = 'multi-step'; // default to decomposing when uncertain
  }

  return parsed;
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

  sendDebugLog(room, 'info', 'handleChatMessage', `Received: "${content.substring(0, 60)}"`, isDirect ? 'direct command' : undefined);

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

  // Normal chat — classify intent, then route accordingly
  if (!process.env.ANTHROPIC_API_KEY) {
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_${id}`, role: 'system', type: 'error', content: 'ANTHROPIC_API_KEY not configured.' },
    });
    return;
  }

  logRoom(room.id, `Chat: "${content.substring(0, 80)}"`);

  // Classify message intent (action vs conversation)
  let classification: ClassificationResult | null = null;
  try {
    sendDebugLog(room, 'info', 'classifyMessage', 'Classifying intent...');
    const histories = room.chatHistories;
    const history = histories.get(conversationId) ?? [];
    classification = await classifyMessage(
      content,
      history,
      room.isAgentConnected,
      room.agentInfo?.layers ?? [],
    );
    sendDebugLog(room, 'info', 'classifyMessage', `Result: intent=${classification.intent}, confidence=${classification.confidence}`, classification.plan || undefined);
  } catch (err) {
    // Classification failed — fall through to conversation (safe default)
    const errMsg = err instanceof Error ? err.message : String(err);
    sendDebugLog(room, 'error', 'classifyMessage', `Failed: ${errMsg}`);
  }

  // Route based on classification
  if (classification && classification.intent === 'action' && classification.confidence >= 0.7) {
    // Action intent — check prerequisites, then send preview
    if (!room.isAgentConnected) {
      sendDebugLog(room, 'warn', 'handleChatMessage', 'Agent not connected, cannot execute action');
      room.sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: { id: `resp_${id}`, role: 'system', type: 'error', content: 'Your WF-Agent app needs to be running to perform this task. Please open it and try again.' },
      });
      return;
    }

    if (room.agentLoopActive) {
      sendDebugLog(room, 'warn', 'handleChatMessage', 'Agent loop already active');
      room.sendToDashboard({
        type: 'server_chat_response',
        conversationId,
        message: { id: `resp_${id}`, role: 'system', type: 'error', content: 'A task is already running. Please wait for it to finish.' },
      });
      return;
    }

    const previewId = crypto.randomUUID();
    const histories = room.chatHistories;
    const history = histories.get(conversationId) ?? [];

    room.pendingPreview = {
      previewId,
      conversationId,
      originalMessage: content,
      plan: classification.plan,
      conversationHistory: [...history],
      createdAt: Date.now(),
      complexity: classification.complexity,
    };

    const preview: ServerActionPreview = {
      type: 'server_action_preview',
      previewId,
      conversationId,
      plan: classification.plan,
      originalMessage: content,
    };
    sendDebugLog(room, 'info', 'handleChatMessage', `Preview card sent: ${previewId}`, classification.plan);
    room.sendToDashboard(preview);
    return;
  }

  // Conversation intent (or low-confidence classification) — standard chat
  try {
    const reply = await simpleChatWithClaude(room, conversationId, content);
    sendDebugLog(room, 'info', 'handleChatMessage', 'Conversation response sent');
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_${id}`, role: 'agent', type: 'text', content: reply },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sendDebugLog(room, 'error', 'handleChatMessage', `Chat error: ${errMsg}`);
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
    const maxIter = parseInt(process.env.AGENT_MAX_ITERATIONS || '25', 10);
    const commandTimeoutMs = parseInt(process.env.AGENT_COMMAND_TIMEOUT || '60000', 10);
    const result = await runAgentLoop!({
      goal,
      sendAndWait: (cmd) => room.sendCommandAndWait(cmd, commandTimeoutMs),
      maxIterations: maxIter,
      callbacks: {
        onStep: (step: number, maxIterations: number) => {
          logRoom(room.id, `[workflow] Step ${step}/${maxIterations}`);
          room.sendToDashboard({
            type: 'server_workflow_progress', workflowId,
            step, totalSteps: maxIterations, currentStepName: `Step ${step}`, status: 'running',
          });
        },
        onObservation: (obs: unknown) => {
          const observation = obs as Record<string, unknown>;
          logRoom(room.id, `[workflow] Observing: ${observation.frontmostApp || 'unknown'}`);
        },
        onThinking: () => {
          logRoom(room.id, `[workflow] Sending to Claude...`);
        },
        onAction: (_command: AgentCommand, thinking: string) => {
          logRoom(room.id, `[workflow] Executing: ${_command.layer}/${_command.action}`);
          room.sendToDashboard({
            type: 'server_workflow_progress', workflowId,
            step: 0, totalSteps: 0, currentStepName: thinking.substring(0, 100), status: 'running',
          });
        },
        onActionResult: (_command: AgentCommand, result: AgentResult) => {
          logRoom(room.id, `[workflow] Result: ${result.status} for ${_command.layer}/${_command.action}`);
        },
        onError: (error: string, context: string) => {
          logRoom(room.id, `[workflow] Error: ${error} (${context})`);
        },
        onComplete: (summary: string) => {
          logRoom(room.id, `[workflow] Complete: ${summary.substring(0, 100)}`);
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
// Action confirm/cancel handlers (room-scoped)
// ---------------------------------------------------------------------------

async function handleActionConfirm(room: Room, msg: DashboardActionConfirm): Promise<void> {
  const { previewId, conversationId } = msg;
  const pending = room.pendingPreview;

  sendDebugLog(room, 'info', 'handleActionConfirm', `Confirmed: ${previewId}`);

  // Validate previewId matches
  if (!pending || pending.previewId !== previewId) {
    sendDebugLog(room, 'warn', 'handleActionConfirm', 'Preview expired or invalid');
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_confirm_${previewId}`, role: 'system', type: 'error', content: 'This action preview has expired or is invalid.' },
    });
    return;
  }

  // Stale confirmation guard — recheck agent connection
  if (!room.isAgentConnected) {
    sendDebugLog(room, 'warn', 'handleActionConfirm', 'Agent disconnected before execution');
    room.pendingPreview = null;
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_confirm_${previewId}`, role: 'system', type: 'error', content: 'Your WF-Agent app needs to be running to perform this task. Please open it and try again.' },
    });
    return;
  }

  // Guard against race — another task started between preview and confirm
  if (room.agentLoopActive) {
    room.pendingPreview = null;
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_confirm_${previewId}`, role: 'system', type: 'error', content: 'A task is already running. Please wait for it to finish.' },
    });
    return;
  }

  if (!agentModulesLoaded || !runAgentLoop) {
    room.pendingPreview = null;
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: { id: `resp_confirm_${previewId}`, role: 'system', type: 'error', content: 'Agent loop modules are not available. The server needs to be restarted with agent support.' },
    });
    return;
  }

  // Clear pending preview and start execution
  const { plan, originalMessage, conversationHistory, complexity } = pending;
  room.pendingPreview = null;
  room.agentLoopActive = true;
  room.resetAbortSignal();

  // Construct goal from plan + original message + conversation context
  const contextSummary = conversationHistory.length > 0
    ? `\n\nConversation context:\n${conversationHistory.slice(-5).map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}`
    : '';
  const goal = `${plan}\n\nOriginal user request: "${originalMessage}"${contextSummary}`;

  sendDebugLog(room, 'info', 'handleActionConfirm', 'Starting agent loop', `Goal: ${plan.substring(0, 100)}`);

  // Helper to send progress events to the dashboard
  let currentStep = 0;
  let currentMaxSteps = 0;
  function sendProgress(
    phase: ServerAgentProgress['phase'],
    message: string,
    detail?: string,
    layer?: AgentCommand['layer'],
  ): void {
    const progress: ServerAgentProgress = {
      type: 'server_agent_progress',
      conversationId,
      phase,
      step: currentStep,
      maxSteps: currentMaxSteps,
      message,
      detail,
      layer,
      timestamp: new Date().toISOString(),
    };
    room.sendToDashboard(progress);
    logRoom(room.id, `[agent] ${phase}: ${message}${detail ? ` | ${detail}` : ''}`);
  }

  // Configurable timeout for remote command execution (default 60s for network latency)
  const commandTimeoutMs = parseInt(process.env.AGENT_COMMAND_TIMEOUT || '60000', 10);

  try {
    const maxIter = parseInt(process.env.AGENT_MAX_ITERATIONS || '25', 10);

    sendProgress('step', 'Starting agent loop...', `Goal: ${plan.substring(0, 100)}`);

    const shouldDecompose = complexity === 'multi-step';
    if (shouldDecompose) {
      sendProgress('step', 'Decomposing task into sub-goals...', `Goal: ${plan.substring(0, 100)}`);
    }

    const loopPromise = runAgentLoop({
      goal,
      sendAndWait: (cmd) => room.sendCommandAndWait(cmd, commandTimeoutMs),
      maxIterations: maxIter,
      decompose: shouldDecompose,
      signal: room.agentAbortSignal,
      callbacks: {
        onStep: (step: number, maxIterations: number) => {
          currentStep = step;
          currentMaxSteps = maxIterations;
          sendProgress('step', `Step ${step} of ${maxIterations}`);
        },
        onObservation: (obs: unknown, step: number) => {
          const observation = obs as Record<string, unknown>;
          const app = (observation.frontmostApp as string) || 'unknown';
          const title = (observation.windowTitle as string) || '';
          sendProgress('observing', `Observing: ${app}`, title ? `Window: ${title}` : undefined);
        },
        onThinking: () => {
          sendProgress('thinking', 'Sending to Claude...');
        },
        onParsed: (parsed: unknown, step: number) => {
          const p = parsed as Record<string, unknown>;
          const type = p.type as string;
          if (type === 'action') {
            const cmd = p.command as Record<string, unknown>;
            sendProgress('parsed', `Claude decided: ${cmd?.action || 'action'}`, (p.thinking as string)?.substring(0, 150), cmd?.layer as AgentCommand['layer']);
          } else if (type === 'complete') {
            sendProgress('parsed', 'Claude says: goal complete');
          } else if (type === 'needs_help') {
            sendProgress('parsed', `Claude asks: ${(p.question as string)?.substring(0, 150)}`);
          } else {
            sendProgress('parsed', `Claude response: ${type}`);
          }
        },
        onAction: (command: AgentCommand, thinking: string) => {
          sendProgress('executing', `Executing: ${command.layer}/${command.action}`, thinking.substring(0, 150), command.layer);
        },
        onActionResult: (command: AgentCommand, result: AgentResult) => {
          const status = result.status === 'success' ? 'Success' : 'Failed';
          sendProgress('action_result', `${status}: ${command.layer}/${command.action}`, undefined, command.layer);
        },
        onComplete: (summary: string) => {
          sendProgress('complete', summary || 'Task completed.');
        },
        onNeedsHelp: (question: string) => {
          sendProgress('needs_help', question);
        },
        onError: (error: string, context: string) => {
          sendProgress('error', error, `Context: ${context}`);
        },
        onDecomposition: (subGoals: SubGoal[]) => {
          sendDebugLog(room, 'info', 'agent-loop', `Decomposed into ${subGoals.length} sub-goals`, subGoals.map(sg => sg.label).join(', '));
          // Send initial pending status for all sub-goals
          for (let idx = 0; idx < subGoals.length; idx++) {
            const sgProgress: ServerSubGoalProgress = {
              type: 'server_subgoal_progress',
              conversationId,
              subGoal: { id: subGoals[idx].id, label: subGoals[idx].label },
              index: idx,
              total: subGoals.length,
              status: 'pending',
            };
            room.sendToDashboard(sgProgress);
          }
        },
        onSubGoalStart: (subGoal: SubGoal, index: number, total: number) => {
          sendDebugLog(room, 'info', 'agent-loop', `Sub-goal ${index + 1}/${total}: "${subGoal.label}" started`);
          const sgProgress: ServerSubGoalProgress = {
            type: 'server_subgoal_progress',
            conversationId,
            subGoal: { id: subGoal.id, label: subGoal.label },
            index,
            total,
            status: 'active',
          };
          room.sendToDashboard(sgProgress);
        },
        onSubGoalComplete: (subGoal: SubGoal, index: number, total: number, outcome: SubGoalOutcome) => {
          sendDebugLog(room, 'info', 'agent-loop', `Sub-goal ${index + 1}/${total}: "${subGoal.label}" -> ${outcome}`);
          const status = outcome === 'complete' ? 'completed' as const : outcome === 'stuck' ? 'failed' as const : 'skipped' as const;
          const sgProgress: ServerSubGoalProgress = {
            type: 'server_subgoal_progress',
            conversationId,
            subGoal: { id: subGoal.id, label: subGoal.label },
            index,
            total,
            status,
          };
          room.sendToDashboard(sgProgress);
          // Track completed sub-goals for cancel ack
          if (outcome === 'complete') {
            room.completedSubGoals.push(subGoal.label);
          }
        },
      },
    });

    // Track loop promise for cancel coordination
    room.loopPromise = loopPromise;
    room.completedSubGoals = [];
    const result = await loopPromise;
    room.loopPromise = null;

    // Send completion summary as a chat message
    sendDebugLog(room, 'info', 'handleActionConfirm', `Agent loop complete: ${result.outcome}`, result.summary?.substring(0, 150));
    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: {
        id: `resp_complete_${previewId}`,
        role: 'agent',
        type: 'text',
        content: result.summary || 'Task completed.',
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendDebugLog(room, 'error', 'handleActionConfirm', `Agent loop failed: ${errorMsg}`);
    sendProgress('error', `Task failed: ${errorMsg}`, 'Unhandled exception in agent loop');

    room.sendToDashboard({
      type: 'server_chat_response',
      conversationId,
      message: {
        id: `resp_error_${previewId}`,
        role: 'system',
        type: 'error',
        content: `Task failed: ${errorMsg}`,
      },
    });
  } finally {
    room.agentLoopActive = false;
  }
}

function handleActionCancel(room: Room, msg: DashboardActionCancel): void {
  const { previewId, conversationId } = msg;
  const pending = room.pendingPreview;

  // Validate previewId matches
  if (!pending || pending.previewId !== previewId) {
    return; // Already cancelled or expired — no-op
  }

  room.pendingPreview = null;

  room.sendToDashboard({
    type: 'server_chat_response',
    conversationId,
    message: { id: `resp_cancel_${previewId}`, role: 'agent', type: 'text', content: 'Cancelled.' },
  });
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
            room.abortAgent();
          }
          break;
        }

        // ----- Dashboard task cancel (stop agent loop) -----
        case 'dashboard_cancel_task': {
          const room = findRoomBySocket(ws);
          if (room) {
            const cancelMsg = msg as DashboardCancelTask;
            logRoom(room.id, `Task cancel requested: ${cancelMsg.conversationId}`);
            room.abortAgent();

            // Wait for the loop to finish, then send ack
            if (room.loopPromise) {
              room.loopPromise
                .then(() => {
                  const ack: ServerCancelAck = {
                    type: 'server_cancel_ack',
                    conversationId: cancelMsg.conversationId,
                    completedSubGoals: room.completedSubGoals,
                  };
                  room.sendToDashboard(ack);
                  room.loopPromise = null;
                  room.agentLoopActive = false;
                  logRoom(room.id, `Task cancelled. Completed sub-goals: ${room.completedSubGoals.join(', ') || 'none'}`);
                })
                .catch(() => {
                  room.loopPromise = null;
                  room.agentLoopActive = false;
                });
            } else {
              // No loop running — ack immediately
              room.sendToDashboard({
                type: 'server_cancel_ack',
                conversationId: cancelMsg.conversationId,
                completedSubGoals: [],
              } as ServerCancelAck);
            }
          }
          break;
        }

        // ----- Dashboard action confirm (smart chat routing) -----
        case 'dashboard_action_confirm': {
          const room = findRoomBySocket(ws);
          if (room) {
            handleActionConfirm(room, msg as DashboardActionConfirm).catch((err) => {
              logRoom(room.id, `Action confirm error: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          break;
        }

        // ----- Dashboard action cancel (smart chat routing) -----
        case 'dashboard_action_cancel': {
          const room = findRoomBySocket(ws);
          if (room) {
            handleActionCancel(room, msg as DashboardActionCancel);
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
