/**
 * Test Server — Simple WebSocket server for testing the Local Agent.
 *
 * This is a development tool, NOT part of the production system.
 * It starts a WebSocket server on port 8765 and provides an interactive
 * CLI where you can type commands to send to the Local Agent.
 *
 * Available commands:
 *   launch <appname>           — Launch an application (e.g. "launch Google Chrome")
 *   switch <appname>           — Bring an application to the front
 *   close <appname>            — Quit an application
 *   minimize [appname]         — Minimize a window (or frontmost if no app given)
 *   list                       — List all running applications
 *   exec <command>             — Run a raw shell command (e.g. "exec ls -la")
 *   browser launch             — Launch the isolated Chromium browser
 *   browser close              — Close the browser
 *   browser navigate <url>     — Navigate to a URL
 *   browser snapshot           — Get interactive elements with reference IDs
 *   browser click <ref>        — Click element by reference (e.g. "browser click e5")
 *   browser type <ref> <text>  — Type into element (e.g. "browser type e3 Hello")
 *   browser select <ref> <val> — Select dropdown option
 *   browser screenshot         — Take a page screenshot
 *   browser info               — Show current page URL and title
 *   browser tabs               — List open tabs
 *   browser newtab [url]       — Open a new tab
 *   browser closetab           — Close the current tab
 *   ax tree <appname>           — Show the accessibility tree of an app
 *   ax snapshot <appname>      — Get interactive elements with ref IDs
 *   ax find <app> <role> <lbl> — Find elements by role/label
 *   ax click <ref>             — Click/press element by ref (e.g. "ax click ax_5")
 *   ax setvalue <ref> <value>  — Set element value (e.g. "ax setvalue ax_12 4200")
 *   ax getvalue <ref>          — Get element value
 *   ax menu <app> <items...>   — Click through menus (e.g. "ax menu TextEdit File Save")
 *   ax focus <ref>             — Focus an element
 *   ax windows <appname>       — Show window info
 *   vision screenshot [app]    — Take a screenshot (fullscreen or specific app window)
 *   vision context [app]       — Collect full hybrid context (screenshot + AX + metadata)
 *   vision click <x> <y> [verify] — Click at screen coordinates
 *   vision doubleclick <x> <y> — Double-click at coordinates
 *   vision rightclick <x> <y>  — Right-click at coordinates
 *   vision type <text>         — Type text into focused element
 *   vision key <key1> <key2>...— Keyboard shortcut (e.g. "vision key cmd s")
 *   vision drag <x1> <y1> <x2> <y2> — Drag between points
 *   vision scroll <x> <y> <dir> <n> — Scroll at position (e.g. "vision scroll 400 300 down 3")
 *   vision region <x> <y> <w> <h>  — Capture a specific screen region
 *   batch <cmd1> | <cmd2> | ...— Run multiple commands sequentially with delay
 *   agent <goal>               — Start the autonomous agent loop with a goal
 *   record start [description] — Start a recording session
 *   record stop                — Stop recording and save manifest
 *   record status              — Show current recording status
 *   record list                — List saved recordings
 *   record view <id>           — View a recording's manifest
 *   record retranscribe <id>  — Re-run Whisper transcription on existing recording
 *   parse <sessionId>          — Parse a recording into a workflow definition
 *   workflow list              — List saved workflows
 *   workflow run <workflowId>  — Run a workflow through the agent loop
 *   help                       — Show available commands
 *   quit                       — Stop the test server
 *
 * How to use:
 *   1. Run this server:    npm run agent:test-server
 *   2. Run the agent:      npm run agent:dev
 *   3. Type commands here and see the agent's responses
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { DEFAULT_WS_PORT, AgentCommand, AgentResult } from '@workflow-agent/shared';

// Load .env — try repo root first (compiled JS is at local-agent/dist/test/test-server.js,
// so ../../../ goes up to the repo root), then fall back to other locations
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
if (!process.env.ANTHROPIC_API_KEY) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}
if (!process.env.ANTHROPIC_API_KEY) {
  dotenv.config(); // cwd fallback
}

console.log('[DEBUG .env] Tried:', path.resolve(__dirname, '../../../.env'));
console.log('[DEBUG .env] CWD:', process.cwd());
console.log('[DEBUG .env] Key found:', !!process.env.ANTHROPIC_API_KEY);

// Agent loop modules (imported after dotenv so env vars are available)
import { initLLMClient, sendMessage, resetConversation } from '../src/agent/llm-client';
import type { ConversationMessage } from '../src/agent/llm-client';
import { observe } from '../src/agent/observer';
import type { Observation } from '../src/agent/observer';
import { buildSystemPrompt, formatObservation } from '../src/agent/prompt-builder';
import { parseResponse } from '../src/agent/response-parser';
import { startSession, stopSession, getStatus, listSessions, getSessionManifest } from '../src/recorder/session-manager';
import { transcribe } from '../src/recorder/transcription';
import { buildManifest } from '../src/recorder/manifest-builder';
import { parseRecordingToWorkflow } from '../src/agent/workflow-parser';
import { formatWorkflowAsGoal } from '../src/agent/workflow-executor';
import type { WorkflowDefinition } from '../src/agent/workflow-types';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Counter for generating unique command IDs */
let commandCounter = 0;

/** Reference to the connected agent (null if no agent is connected) */
let agentSocket: WebSocket | null = null;

/** Batch mode state */
let batchQueue: string[] = [];     // Queued commands (raw strings, same format as interactive input)
let batchDelayMs: number = 1000;  // Delay between commands
let batchTotal: number = 0;       // Total commands in current batch
let batchCompleted: number = 0;   // Commands completed so far
let batchActive: boolean = false; // Whether a batch is currently running

/** Agent loop state */
const pendingCommands: Map<string, (result: AgentResult) => void> = new Map();
let agentLoopActive: boolean = false;
let agentCommandCounter: number = 0;

// ---------------------------------------------------------------------------
// Start the WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: DEFAULT_WS_PORT });
console.log(`[${timestamp()}] [test-server] WebSocket server started on ws://localhost:${DEFAULT_WS_PORT}`);
console.log(`[${timestamp()}] [test-server] Waiting for the Local Agent to connect...`);
console.log('');

wss.on('connection', (ws: WebSocket) => {
  console.log(`[${timestamp()}] [test-server] Agent connected!`);
  agentSocket = ws;

  // Handle messages from the agent
  ws.on('message', (data: Buffer) => {
    const raw = data.toString();

    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'hello') {
        // Agent registration message
        console.log('');
        console.log(`  Agent: ${msg.agentName} v${msg.version} (${msg.platform})`);
        console.log(`  Supported layers: ${msg.supportedLayers.join(', ')}`);
        console.log('');
        console.log('  Type "help" for available commands.');
        console.log('');
        showPrompt();
        return;
      }

      if (msg.type === 'result') {
        // If the agent loop is waiting for this response, deliver it directly
        const pendingHandler = pendingCommands.get(msg.id);
        if (pendingHandler) {
          pendingHandler(msg as AgentResult);
          if (agentLoopActive) return; // suppress normal output during agent loop
        }

        // Command result from the agent
        console.log('');
        console.log(`  ← Response [${msg.id}] (${msg.status}):`);

        const responseData = msg.data || {};

        // Special formatting for element snapshots (CDP and Accessibility)
        if (responseData.elements && Array.isArray(responseData.elements)) {
          // CDP snapshots have pageTitle/pageUrl, accessibility snapshots have app
          if (responseData.pageTitle !== undefined || responseData.pageUrl !== undefined) {
            console.log(`     Page: ${responseData.pageTitle || '(untitled)'} (${responseData.pageUrl || ''})`);
          }
          if (responseData.app) {
            console.log(`     App: ${responseData.app}`);
          }
          console.log(`     Interactive elements (${responseData.count || responseData.elements.length}):`);
          for (const el of responseData.elements as Array<Record<string, unknown>>) {
            const ref = String(el.ref).padEnd(6);
            const role = `[${el.role}]`.padEnd(20);
            const label = el.label ? `"${String(el.label).substring(0, 40)}"` : '';
            const value = el.value ? `  value: "${el.value}"` : '';
            const enabled = el.enabled === false ? '  (disabled)' : '';
            console.log(`       ${ref} ${role} ${label}${value}${enabled}`);
          }
        // Special formatting for accessibility tree
        } else if (responseData.windows && Array.isArray(responseData.windows)) {
          if (responseData.app) {
            console.log(`     App: ${responseData.app} (${responseData.elementCount || 0} elements)`);
          }
          function printTree(nodes: Array<Record<string, unknown>>, indent: string): void {
            for (const node of nodes) {
              const id = node.id ? `${String(node.id).padEnd(6)} ` : '';
              const role = node.role ? `[${node.role}]` : '';
              const label = node.label ? ` "${String(node.label).substring(0, 40)}"` : '';
              const value = node.value ? `  value: "${node.value}"` : '';
              console.log(`     ${indent}${id}${role}${label}${value}`);
              if (node.children && Array.isArray(node.children)) {
                printTree(node.children as Array<Record<string, unknown>>, indent + '  ');
              }
            }
          }
          printTree(responseData.windows as Array<Record<string, unknown>>, '');
        // Special formatting for tabs list
        } else if (responseData.tabs && Array.isArray(responseData.tabs)) {
          for (const tab of responseData.tabs as Array<Record<string, unknown>>) {
            console.log(`       [${tab.index}] ${tab.title || '(untitled)'} — ${tab.url}`);
          }
        // Vision: collect_context result — check BEFORE CDP screenshot (both use responseData.screenshot)
        } else if (responseData.screenshot && typeof responseData.screenshot === 'object' && responseData.windowInfo) {
          const ctx = responseData as Record<string, unknown>;
          const win = ctx.windowInfo as Record<string, unknown>;
          const ax = ctx.partialAccessibility as Record<string, unknown>;
          const recent = ctx.recentActions as unknown[];
          const ss = ctx.screenshot as Record<string, unknown>;
          const sizeKb = Math.round(String(ss.base64 || '').length / 1024);
          console.log(`     App: ${win.frontmostApp}  Window: "${win.windowTitle}"`);
          console.log(`     Screenshot: ${ss.width}×${ss.height} (${sizeKb}KB, ${ss.captureType})`);
          const menuItems = (ax.menuBarItems as string[]).join(', ') || '(none)';
          console.log(`     AX elements: ${ax.elementCount}  Menu items: ${menuItems}`);
          console.log(`     Recent actions: ${(recent).length}`);
          if ((recent as Array<Record<string, unknown>>).length > 0) {
            for (const a of recent as Array<Record<string, unknown>>) {
              console.log(`       • ${a.action} → ${a.result}`);
            }
          }
          if (ctx.taskContext) {
            const tc = ctx.taskContext as Record<string, unknown>;
            console.log(`     Task: "${tc.currentStep}" (${tc.workflowName})`);
          }
        // Vision: direct screenshot/region result (base64 at top level with captureType)
        } else if (responseData.base64 && responseData.captureType) {
          const sizeKb = Math.round(String(responseData.base64).length / 1024);
          console.log(`     Screenshot: ${responseData.width}×${responseData.height} (${sizeKb}KB base64, type: ${responseData.captureType})`);
          console.log(`     Timestamp: ${responseData.timestamp}`);
        // Vision: action result (click/type/key/drag/scroll)
        } else if (responseData.action && responseData.timestamp && typeof responseData.success === 'boolean') {
          const ok = responseData.success ? 'OK' : 'FAIL';
          console.log(`     [${ok}] ${responseData.action}`);
          if (responseData.error) {
            console.log(`     Error: ${responseData.error}`);
          }
          if (responseData.verificationScreenshot) {
            const vs = responseData.verificationScreenshot as Record<string, unknown>;
            const sizeKb = Math.round(String(vs.base64 || '').length / 1024);
            console.log(`     Verification screenshot: ${vs.width}×${vs.height} (${sizeKb}KB)`);
          }
        // Special formatting for CDP screenshot (just show size, not the base64 blob)
        } else if (responseData.screenshot) {
          const size = Math.round(String(responseData.screenshot).length / 1024);
          console.log(`     Screenshot captured (${size}KB base64, format: ${responseData.format})`);
        } else {
          // Default: print each key/value pair
          for (const [key, value] of Object.entries(responseData)) {
            if (value !== undefined && value !== null && value !== '') {
              console.log(`     ${key}: ${value}`);
            }
          }
        }
        console.log('');
        if (batchActive) {
          processBatchNext();
        } else {
          showPrompt();
        }
        return;
      }

      // Unknown message type
      console.log(`  ← Unknown message: ${raw.substring(0, 200)}`);
      showPrompt();
    } catch {
      console.log(`  ← Raw message: ${raw.substring(0, 200)}`);
      showPrompt();
    }
  });

  ws.on('close', () => {
    console.log(`\n[${timestamp()}] [test-server] Agent disconnected`);
    agentSocket = null;
    showPrompt();
  });

  ws.on('error', (err: Error) => {
    console.error(`[${timestamp()}] [test-server] WebSocket error: ${err.message}`);
  });
});

// ---------------------------------------------------------------------------
// Interactive CLI
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function showPrompt(): void {
  const status = agentSocket ? '●' : '○';
  rl.setPrompt(`${status} test-server> `);
  rl.prompt();
}

/**
 * Send a command to the Local Agent and wait for its response.
 * Used by the agent loop for synchronous-style command execution.
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

    const sent = sendCommand(command);
    if (!sent) {
      clearTimeout(timer);
      pendingCommands.delete(command.id);
      reject(new Error('Failed to send command — agent not connected'));
    }
  });
}

function showHelp(): void {
  console.log('');
  console.log('  Shell commands (Layer 2):');
  console.log('  ──────────────────────────────────────────────');
  console.log('  launch <appname>           Launch an application');
  console.log('  switch <appname>           Bring an app to the front');
  console.log('  close <appname>            Quit an application');
  console.log('  minimize [appname]         Minimize a window');
  console.log('  list                       List running applications');
  console.log('  exec <command>             Run a shell command');
  console.log('');
  console.log('  Browser commands (Layer 3 — CDP/Playwright):');
  console.log('  ──────────────────────────────────────────────');
  console.log('  browser launch             Launch the isolated browser');
  console.log('  browser close              Close the browser');
  console.log('  browser navigate <url>     Navigate to a URL');
  console.log('  browser snapshot           Get interactive elements with refs');
  console.log('  browser click <ref>        Click element (e.g. browser click e5)');
  console.log('  browser type <ref> <text>  Type into element');
  console.log('  browser select <ref> <val> Select dropdown option');
  console.log('  browser screenshot         Take a page screenshot');
  console.log('  browser info               Show current URL and title');
  console.log('  browser tabs               List open tabs');
  console.log('  browser newtab [url]       Open a new tab');
  console.log('  browser closetab           Close the current tab');
  console.log('');
  console.log('  Accessibility commands (Layer 4 — macOS AX APIs):');
  console.log('  ──────────────────────────────────────────────');
  console.log('  ax tree <appname>              Get accessibility tree');
  console.log('  ax snapshot <appname>          Get interactive elements with refs');
  console.log('  ax find <app> <role> <label>   Find elements by criteria');
  console.log('  ax click <ref>                 Click/press element (e.g. ax click ax_5)');
  console.log('  ax setvalue <ref> <value>      Set element value');
  console.log('  ax getvalue <ref>              Get element value');
  console.log('  ax menu <app> <menu items...>  Click through menus');
  console.log('  ax focus <ref>                 Focus an element');
  console.log('  ax windows <appname>           Show window info');
  console.log('');
  console.log('  Vision commands (Layer 5 — Hybrid Last Resort):');
  console.log('  ──────────────────────────────────────────────');
  console.log('  vision screenshot [app]        Take a screenshot (fullscreen or app window)');
  console.log('  vision context [app]           Collect hybrid context (screenshot + AX + metadata)');
  console.log('  vision click <x> <y> [verify]  Click at screen coordinates');
  console.log('  vision doubleclick <x> <y>     Double-click at coordinates');
  console.log('  vision rightclick <x> <y>      Right-click at coordinates');
  console.log('  vision type <text>             Type text into focused element');
  console.log('  vision key <keys...>           Keyboard shortcut (e.g. "vision key cmd s")');
  console.log('  vision drag <x1> <y1> <x2> <y2>  Drag between points');
  console.log('  vision scroll <x> <y> <dir> <n>  Scroll at position');
  console.log('  vision region <x> <y> <w> <h>    Capture a screen region');
  console.log('');
  console.log('  Batch Mode:');
  console.log('  ──────────────────────────────────────────────');
  console.log('  batch <cmd1> | <cmd2> | ...    Run commands sequentially (1s delay between each)');
  console.log('  batch <ms> <cmd1> | <cmd2>     Custom delay (e.g. "batch 2000 switch TextEdit | vision click 400 300")');
  console.log('');
  console.log('  Agent Loop (requires ANTHROPIC_API_KEY in .env):');
  console.log('  ──────────────────────────────────────────────');
  console.log('  agent <goal>               Start autonomous agent with a goal');
  console.log('                             Example: agent Open TextEdit and type "Hello World"');
  console.log('');
  console.log('  Recording Mode (no agent connection needed):');
  console.log('  ──────────────────────────────────────────────');
  console.log('  record start [description] Start a recording session');
  console.log('  record stop                Stop and save session manifest');
  console.log('  record status              Show current recording state');
  console.log('  record list                List all saved recordings');
  console.log('  record view <id>           View a recording manifest');
  console.log('  record retranscribe <id>  Re-run Whisper on existing recording');
  console.log('');
  console.log('  Workflow (requires ANTHROPIC_API_KEY in .env):');
  console.log('  ──────────────────────────────────────────────');
  console.log('  parse <sessionId>          Parse a recording into a workflow');
  console.log('  workflow list              List saved workflows');
  console.log('  workflow run <workflowId>  Run a workflow via the agent loop');
  console.log('');
  console.log('  Other:');
  console.log('  ──────────────────────────────────────────────');
  console.log('  help                       Show this help message');
  console.log('  quit                       Stop the test server');
  console.log('');
}

/**
 * Send a command to the connected agent.
 * Returns true if sent, false if no agent is connected.
 */
function sendCommand(command: AgentCommand): boolean {
  if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
    console.log('  No agent connected. Start the agent with: npm run agent:dev');
    return false;
  }

  const json = JSON.stringify(command);
  console.log(`  → Sending [${command.id}]: ${command.layer}/${command.action}`);
  agentSocket.send(json);
  return true;
}

/** Generate a unique command ID */
function nextId(): string {
  commandCounter++;
  return `cmd_${commandCounter}`;
}

/**
 * Execute the next command in the batch queue.
 * Called after each command's response arrives when batchActive is true.
 */
function processBatchNext(): void {
  if (batchQueue.length === 0) {
    // Batch complete
    console.log('');
    console.log(`  ═══ BATCH COMPLETE (${batchCompleted}/${batchTotal} commands) ═══`);
    console.log('');
    batchActive = false;
    batchTotal = 0;
    batchCompleted = 0;
    showPrompt();
    return;
  }

  const nextCmd = batchQueue.shift()!;
  batchCompleted++;
  console.log(`  ── Batch [${batchCompleted}/${batchTotal}]: ${nextCmd}`);

  // Wait the configured delay, then feed the command through the normal parser
  setTimeout(() => {
    rl.emit('line', nextCmd);
  }, batchDelayMs);
}

// Handle user input
rl.on('line', (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    showPrompt();
    return;
  }

  // Parse the command and first argument
  const spaceIndex = trimmed.indexOf(' ');
  const cmd = spaceIndex === -1 ? trimmed.toLowerCase() : trimmed.substring(0, spaceIndex).toLowerCase();
  const arg = spaceIndex === -1 ? '' : trimmed.substring(spaceIndex + 1).trim();

  switch (cmd) {
    case 'help':
      showHelp();
      showPrompt();
      break;

    case 'quit':
    case 'exit':
      console.log('  Shutting down test server...');
      wss.close();
      rl.close();
      process.exit(0);
      break;

    case 'launch':
      if (!arg) {
        console.log('  Usage: launch <appname>  (e.g. "launch Google Chrome")');
        showPrompt();
        break;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'shell',
        action: 'launch_app',
        params: { appName: arg },
      });
      break;

    case 'switch':
      if (!arg) {
        console.log('  Usage: switch <appname>  (e.g. "switch Finder")');
        showPrompt();
        break;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'shell',
        action: 'switch_app',
        params: { appName: arg },
      });
      break;

    case 'close':
      if (!arg) {
        console.log('  Usage: close <appname>  (e.g. "close Safari")');
        showPrompt();
        break;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'shell',
        action: 'close_app',
        params: { appName: arg },
      });
      break;

    case 'minimize':
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'shell',
        action: 'minimize_window',
        params: arg ? { appName: arg } : {},
      });
      break;

    case 'list':
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'shell',
        action: 'list_apps',
        params: {},
      });
      break;

    case 'exec':
      if (!arg) {
        console.log('  Usage: exec <command>  (e.g. "exec ls ~/Desktop")');
        showPrompt();
        break;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'shell',
        action: 'exec',
        params: { command: arg },
      });
      break;

    case 'browser':
      handleBrowserCommand(arg);
      break;

    case 'ax':
      handleAxCommand(arg);
      break;

    case 'vision':
      handleVisionCommand(arg);
      break;

    case 'batch': {
      if (!arg) {
        console.log('  Usage: batch [delay_ms] <cmd1> | <cmd2> | <cmd3>');
        console.log('  Example: batch switch TextEdit | vision click 400 300 | vision type Hello');
        console.log('  Example: batch 2000 switch TextEdit | vision click 400 300');
        showPrompt();
        break;
      }

      // Check if the first word of arg is a plain number (delay in ms)
      // Must be checked BEFORE splitting by | so "1500 switch TextEdit | ..." works correctly
      batchDelayMs = 1000;
      let cmdString = arg;
      const firstWord = arg.split(/\s+/)[0];
      if (/^\d+$/.test(firstWord)) {
        batchDelayMs = parseInt(firstWord, 10);
        cmdString = arg.substring(firstWord.length).trimStart();
      }

      // Split remaining string by pipe and trim each command
      const rawParts = cmdString.split('|').map((s) => s.trim()).filter((s) => s.length > 0);

      if (rawParts.length === 0) {
        console.log('  No commands found. Separate commands with |');
        showPrompt();
        break;
      }

      const batchCmds = rawParts;

      if (batchCmds.length === 0) {
        console.log('  No commands found after delay value.');
        showPrompt();
        break;
      }

      // Set up batch state
      batchQueue = batchCmds.slice(); // copy
      batchTotal = batchCmds.length;
      batchCompleted = 0;
      batchActive = true;

      // Print the plan
      console.log('');
      console.log(`  ═══ BATCH MODE (${batchTotal} commands, ${batchDelayMs}ms delay) ═══`);
      batchCmds.forEach((c, i) => {
        console.log(`    ${i + 1}. ${c}`);
      });
      console.log('  ═══ Starting... ═══');
      console.log('');

      // Kick off the first command
      processBatchNext();
      break;
    }

    case 'agent': {
      if (!arg) {
        console.log('  Usage: agent <goal>');
        console.log('  Example: agent Open TextEdit and type "Hello World"');
        showPrompt();
        break;
      }

      if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
        console.log('  Error: No agent connected. Start the agent first (npm run agent:dev)');
        showPrompt();
        break;
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        console.log('  Error: ANTHROPIC_API_KEY not found.');
        console.log('  Create a .env file at the repo root with: ANTHROPIC_API_KEY=sk-ant-...');
        showPrompt();
        break;
      }

      runAgentLoop(arg).catch((err: Error) => {
        console.log(`\n  ✗ Agent loop error: ${err.message}`);
        agentLoopActive = false;
        showPrompt();
      });
      break;
    }

    case 'record': {
      handleRecordCommand(arg).catch((err: unknown) => {
        console.log(`  ✗ Record error: ${err instanceof Error ? err.message : String(err)}`);
        showPrompt();
      });
      break;
    }

    case 'parse': {
      handleParseCommand(arg).catch((err: unknown) => {
        console.log(`  ✗ Parse error: ${err instanceof Error ? err.message : String(err)}`);
        showPrompt();
      });
      break;
    }

    case 'workflow': {
      handleWorkflowCommand(arg).catch((err: unknown) => {
        console.log(`  ✗ Workflow error: ${err instanceof Error ? err.message : String(err)}`);
        showPrompt();
      });
      break;
    }

    default:
      console.log(`  Unknown command: "${cmd}". Type "help" for available commands.`);
      showPrompt();
      break;
  }
});

/**
 * Handle "browser <subcommand>" commands.
 * Parses the subcommand and sends the appropriate CDP layer command.
 */
function handleBrowserCommand(args: string): void {
  const spaceIdx = args.indexOf(' ');
  const sub = spaceIdx === -1 ? args.toLowerCase() : args.substring(0, spaceIdx).toLowerCase();
  const rest = spaceIdx === -1 ? '' : args.substring(spaceIdx + 1).trim();

  switch (sub) {
    case 'launch':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'launch', params: {} });
      break;

    case 'close':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'close', params: {} });
      break;

    case 'navigate':
    case 'nav':
    case 'goto':
      if (!rest) {
        console.log('  Usage: browser navigate <url>  (e.g. "browser navigate https://google.com")');
        showPrompt();
        return;
      }
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'navigate', params: { url: rest } });
      break;

    case 'snapshot':
    case 'snap':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'snapshot', params: { interactive: true } });
      break;

    case 'click':
      if (!rest) {
        console.log('  Usage: browser click <ref>  (e.g. "browser click e5")');
        showPrompt();
        return;
      }
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'click', params: { ref: rest } });
      break;

    case 'type': {
      // Format: browser type <ref> <text>
      const typeSpaceIdx = rest.indexOf(' ');
      if (!rest || typeSpaceIdx === -1) {
        console.log('  Usage: browser type <ref> <text>  (e.g. "browser type e3 Hello World")');
        showPrompt();
        return;
      }
      const ref = rest.substring(0, typeSpaceIdx);
      const text = rest.substring(typeSpaceIdx + 1);
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'type', params: { ref, text } });
      break;
    }

    case 'select': {
      // Format: browser select <ref> <value>
      const selSpaceIdx = rest.indexOf(' ');
      if (!rest || selSpaceIdx === -1) {
        console.log('  Usage: browser select <ref> <value>  (e.g. "browser select e3 Option A")');
        showPrompt();
        return;
      }
      const ref = rest.substring(0, selSpaceIdx);
      const value = rest.substring(selSpaceIdx + 1);
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'select', params: { ref, value } });
      break;
    }

    case 'screenshot':
    case 'ss':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'screenshot', params: {} });
      break;

    case 'info':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'page_info', params: {} });
      break;

    case 'tabs':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'list_tabs', params: {} });
      break;

    case 'newtab':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'new_tab', params: rest ? { url: rest } : {} });
      break;

    case 'closetab':
      sendCommand({ type: 'command', id: nextId(), layer: 'cdp', action: 'close_tab', params: {} });
      break;

    default:
      console.log(`  Unknown browser subcommand: "${sub}". Type "help" for available commands.`);
      showPrompt();
      break;
  }
}

/**
 * Handle "ax <subcommand>" commands.
 * Parses the subcommand and sends the appropriate accessibility layer command.
 */
function handleAxCommand(args: string): void {
  if (!args) {
    console.log('  Usage: ax <subcommand> — Type "help" for available ax commands.');
    showPrompt();
    return;
  }

  const spaceIdx = args.indexOf(' ');
  const sub = spaceIdx === -1 ? args.toLowerCase() : args.substring(0, spaceIdx).toLowerCase();
  const rest = spaceIdx === -1 ? '' : args.substring(spaceIdx + 1).trim();

  switch (sub) {
    case 'tree': {
      if (!rest) {
        console.log('  Usage: ax tree <appname>  (e.g. "ax tree TextEdit")');
        showPrompt();
        return;
      }
      // Parse optional depth: "ax tree TextEdit 5" → app="TextEdit", depth=5
      const parts = rest.split(/\s+/);
      const lastPart = parts[parts.length - 1];
      const depthNum = Number(lastPart);
      let app: string;
      let depth: number | undefined;
      if (parts.length > 1 && !isNaN(depthNum) && depthNum > 0) {
        app = parts.slice(0, -1).join(' ');
        depth = depthNum;
      } else {
        app = rest;
      }
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'get_tree',
        params: depth ? { app, depth } : { app },
      });
      break;
    }

    case 'snapshot':
    case 'snap': {
      if (!rest) {
        console.log('  Usage: ax snapshot <appname>  (e.g. "ax snapshot TextEdit")');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'snapshot',
        params: { app: rest },
      });
      break;
    }

    case 'find': {
      // Format: ax find <app> <role> <label>
      // e.g. "ax find Excel cell B3" or "ax find TextEdit button Bold"
      if (!rest) {
        console.log('  Usage: ax find <app> <role> <label>  (e.g. "ax find Excel cell B3")');
        showPrompt();
        return;
      }
      const findParts = rest.split(/\s+/);
      if (findParts.length < 3) {
        console.log('  Usage: ax find <app> <role> <label>  (e.g. "ax find Excel cell B3")');
        showPrompt();
        return;
      }
      const app = findParts[0];
      const role = findParts[1];
      const label = findParts.slice(2).join(' ');
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'find_element',
        params: { app, role, label },
      });
      break;
    }

    case 'click': {
      if (!rest) {
        console.log('  Usage: ax click <ref>  (e.g. "ax click ax_5")');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'press_button',
        params: { ref: rest },
      });
      break;
    }

    case 'setvalue': {
      // Format: ax setvalue <ref> <value>
      const svSpaceIdx = rest.indexOf(' ');
      if (!rest || svSpaceIdx === -1) {
        console.log('  Usage: ax setvalue <ref> <value>  (e.g. "ax setvalue ax_12 4200")');
        showPrompt();
        return;
      }
      const ref = rest.substring(0, svSpaceIdx);
      const value = rest.substring(svSpaceIdx + 1);
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'set_value',
        params: { ref, value },
      });
      break;
    }

    case 'getvalue': {
      if (!rest) {
        console.log('  Usage: ax getvalue <ref>  (e.g. "ax getvalue ax_12")');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'get_value',
        params: { ref: rest },
      });
      break;
    }

    case 'menu': {
      // Format: ax menu <app> <menu1> <menu2> ...
      // e.g. "ax menu TextEdit File Save"
      if (!rest) {
        console.log('  Usage: ax menu <app> <menu items...>  (e.g. "ax menu TextEdit File Save")');
        showPrompt();
        return;
      }
      const menuParts = rest.split(/\s+/);
      if (menuParts.length < 2) {
        console.log('  Usage: ax menu <app> <menu items...>  (e.g. "ax menu TextEdit File Save")');
        showPrompt();
        return;
      }
      const app = menuParts[0];
      const menuPath = menuParts.slice(1);
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'menu_click',
        params: { app, menuPath },
      });
      break;
    }

    case 'focus': {
      if (!rest) {
        console.log('  Usage: ax focus <ref>  (e.g. "ax focus ax_3")');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'focus',
        params: { ref: rest },
      });
      break;
    }

    case 'windows':
    case 'windowinfo': {
      if (!rest) {
        console.log('  Usage: ax windows <appname>  (e.g. "ax windows TextEdit")');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command', id: nextId(), layer: 'accessibility', action: 'window_info',
        params: { app: rest },
      });
      break;
    }

    default:
      console.log(`  Unknown ax subcommand: "${sub}". Type "help" for available commands.`);
      showPrompt();
      break;
  }
}

/**
 * Handle "vision <subcommand>" commands.
 * Parses the subcommand and sends the appropriate Layer 5 vision command.
 */
function handleVisionCommand(args: string): void {
  const parts = args.trim().split(/\s+/);
  const subCmd = parts[0] || '';
  const rest = parts.slice(1);

  switch (subCmd) {
    case 'screenshot': {
      const app = rest.join(' ') || undefined;
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'screenshot',
        params: app ? { app } : {},
      });
      break;
    }

    case 'context': {
      const app = rest.join(' ') || undefined;
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'collect_context',
        params: app ? { app } : {},
      });
      break;
    }

    case 'click': {
      const x = parseInt(rest[0], 10);
      const y = parseInt(rest[1], 10);
      const verify = rest[2] === 'verify';
      if (isNaN(x) || isNaN(y)) {
        console.log('  Usage: vision click <x> <y> [verify]');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'click_coordinates',
        params: { x, y, verify },
      });
      break;
    }

    case 'doubleclick': {
      const x = parseInt(rest[0], 10);
      const y = parseInt(rest[1], 10);
      if (isNaN(x) || isNaN(y)) {
        console.log('  Usage: vision doubleclick <x> <y>');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'double_click',
        params: { x, y },
      });
      break;
    }

    case 'rightclick': {
      const x = parseInt(rest[0], 10);
      const y = parseInt(rest[1], 10);
      if (isNaN(x) || isNaN(y)) {
        console.log('  Usage: vision rightclick <x> <y>');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'right_click',
        params: { x, y },
      });
      break;
    }

    case 'type': {
      const text = rest.join(' ');
      if (!text) {
        console.log('  Usage: vision type <text>');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'type_text',
        params: { text },
      });
      break;
    }

    case 'key': {
      if (rest.length === 0) {
        console.log('  Usage: vision key <key1> <key2>... (e.g. "vision key cmd s")');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'key_combo',
        params: { keys: rest },
      });
      break;
    }

    case 'drag': {
      const fromX = parseInt(rest[0], 10);
      const fromY = parseInt(rest[1], 10);
      const toX = parseInt(rest[2], 10);
      const toY = parseInt(rest[3], 10);
      if (isNaN(fromX) || isNaN(fromY) || isNaN(toX) || isNaN(toY)) {
        console.log('  Usage: vision drag <fromX> <fromY> <toX> <toY>');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'drag',
        params: { fromX, fromY, toX, toY },
      });
      break;
    }

    case 'scroll': {
      const x = parseInt(rest[0], 10);
      const y = parseInt(rest[1], 10);
      const direction = rest[2] as 'up' | 'down' | 'left' | 'right';
      const amount = parseInt(rest[3], 10) || 3;
      if (isNaN(x) || isNaN(y) || !direction) {
        console.log('  Usage: vision scroll <x> <y> <up|down|left|right> [amount]');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'scroll',
        params: { x, y, direction, amount },
      });
      break;
    }

    case 'region': {
      const x = parseInt(rest[0], 10);
      const y = parseInt(rest[1], 10);
      const w = parseInt(rest[2], 10);
      const h = parseInt(rest[3], 10);
      if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) {
        console.log('  Usage: vision region <x> <y> <width> <height>');
        showPrompt();
        return;
      }
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'capture_region',
        params: { x, y, width: w, height: h },
      });
      break;
    }

    default:
      console.log(`  Unknown vision subcommand: "${subCmd}"`);
      console.log('  Available: screenshot, context, click, doubleclick, rightclick, type, key, drag, scroll, region');
      showPrompt();
      break;
  }
}

// ---------------------------------------------------------------------------
// Recording Mode
// ---------------------------------------------------------------------------

/**
 * Handle "record <subcommand>" commands.
 * Recording works standalone — no agent WebSocket connection needed.
 */
async function handleRecordCommand(args: string): Promise<void> {
  const spaceIdx = args.indexOf(' ');
  const sub = (spaceIdx === -1 ? args : args.substring(0, spaceIdx)).toLowerCase().trim();
  const rest = spaceIdx === -1 ? '' : args.substring(spaceIdx + 1).trim();

  switch (sub) {
    case 'start': {
      const description = rest || 'untitled';
      console.log(`\n  Starting recording: "${description}"...`);
      const state = await startSession(description);
      console.log(`  Session ID: ${state.id}`);
      console.log(`  Directory:  ${state.dir}`);
      console.log(`  Status:     ${state.status}`);
      console.log('  (Type "record stop" to stop recording)\n');
      showPrompt();
      break;
    }

    case 'stop': {
      const status = getStatus();
      if (status.status !== 'recording') {
        console.log(`  No active recording session (status: ${status.status || 'idle'})`);
        showPrompt();
        return;
      }
      console.log('\n  Stopping recording...');
      const finalState = await stopSession();
      console.log(`  Session:    ${finalState.id}`);
      console.log(`  Status:     ${finalState.status}`);
      console.log(`  Events:     ${finalState.eventCount}`);
      console.log(`  Frames:     ${finalState.frameCount}`);
      console.log(`  Directory:  ${finalState.dir}`);
      if (finalState.errorMessage) {
        console.log(`  Error:      ${finalState.errorMessage}`);
      }
      console.log('');
      showPrompt();
      break;
    }

    case 'status': {
      const state = getStatus();
      console.log('');
      if (!state.id) {
        console.log('  No recording session (idle)');
      } else {
        console.log(`  Session:    ${state.id}`);
        console.log(`  Status:     ${state.status}`);
        console.log(`  Events:     ${state.eventCount}`);
        console.log(`  Frames:     ${state.frameCount}`);
        if (state.startTime) {
          const elapsed = Math.round((Date.now() - state.startTime) / 1000);
          console.log(`  Elapsed:    ${elapsed}s`);
        }
      }
      console.log('');
      showPrompt();
      break;
    }

    case 'list': {
      const sessions = listSessions();
      console.log('');
      if (sessions.length === 0) {
        console.log('  No recordings found.');
      } else {
        console.log(`  ${sessions.length} recording(s):`);
        for (const id of sessions) {
          console.log(`    ${id}`);
        }
      }
      console.log('');
      showPrompt();
      break;
    }

    case 'view': {
      if (!rest) {
        console.log('  Usage: record view <session-id>');
        showPrompt();
        return;
      }
      const manifest = getSessionManifest(rest);
      if (!manifest) {
        console.log(`  No manifest found for: ${rest}`);
        showPrompt();
        return;
      }
      console.log('');
      console.log(`  Session: ${manifest.id}`);
      console.log(`  Description: ${manifest.description}`);
      console.log(`  Duration: ${Math.round((manifest.durationMs as number) / 1000)}s`);
      console.log(`  Events: ${manifest.eventCount}`);
      console.log(`  Frames: ${manifest.frameCount}`);
      console.log(`  Audio: ${manifest.audioFile || 'none'}`);
      const entries = manifest.entries as Array<Record<string, unknown>>;
      if (entries && entries.length > 0) {
        console.log(`  Entries (first 5 of ${entries.length}):`);
        for (const entry of entries.slice(0, 5)) {
          const ev = entry.event as Record<string, unknown>;
          const frame = entry.frame as string | null;
          const narr = entry.narration as string | null;
          console.log(`    [${ev.type}] t=${ev.relativeMs}ms frame=${frame || 'none'} narr=${narr ? narr.substring(0, 40) : 'none'}`);
        }
      }
      console.log('');
      showPrompt();
      break;
    }

    case 'retranscribe': {
      if (!rest) {
        console.log('  Usage: record retranscribe <sessionId>');
        showPrompt();
        return;
      }

      if (!process.env.OPENAI_API_KEY) {
        console.log('  Error: OPENAI_API_KEY not found.');
        console.log('  Add it to your .env file: OPENAI_API_KEY=sk-...');
        showPrompt();
        return;
      }

      const sessionDir = path.join(RECORDINGS_DIR, rest);
      const fs = await import('fs');

      const audioPath = path.join(sessionDir, 'audio.wav');
      if (!fs.existsSync(audioPath)) {
        console.log(`  No audio.wav found in session: ${rest}`);
        console.log(`  Looked in: ${sessionDir}`);
        showPrompt();
        return;
      }

      const eventsPath = path.join(sessionDir, 'events.json');
      if (!fs.existsSync(eventsPath)) {
        console.log(`  No events.json found in session: ${rest}`);
        showPrompt();
        return;
      }

      console.log(`\n  Re-transcribing session "${rest}"...`);

      // Load existing events
      const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));

      // Rebuild frame map from frames/ directory
      const frameMap = new Map<number, string>();
      const framesDir = path.join(sessionDir, 'frames');
      if (fs.existsSync(framesDir)) {
        const frameFiles = fs.readdirSync(framesDir).filter((f: string) => f.endsWith('.png')).sort();
        for (const file of frameFiles) {
          // frame-001234.png → relativeMs 1234
          const match = file.match(/^frame-(\d+)\.png$/);
          if (match) {
            const relativeMs = parseInt(match[1], 10);
            frameMap.set(relativeMs, path.join('frames', file));
          }
        }
      }

      // Transcribe audio
      console.log('  Running Whisper transcription...');
      const transcription = await transcribe(audioPath);
      console.log(`  Got ${transcription.length} transcription segment(s)`);

      // Load existing manifest to get metadata
      const manifestPath = path.join(sessionDir, 'manifest.json');
      let description = rest;
      let startTime = 0;
      let endTime = 0;
      if (fs.existsSync(manifestPath)) {
        const oldManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        description = oldManifest.description || rest;
        startTime = new Date(oldManifest.startTime).getTime();
        endTime = new Date(oldManifest.endTime).getTime();
      }

      // Rebuild manifest with new transcription
      buildManifest({
        sessionId: rest,
        description,
        sessionDir,
        startTime,
        endTime,
        events,
        frameMap,
        transcription,
        audioFile: 'audio.wav',
      });

      console.log(`  Manifest rebuilt with ${transcription.length} narration segment(s)`);
      console.log(`  Saved to: ${manifestPath}`);
      console.log('');
      showPrompt();
      break;
    }

    default:
      console.log(`  Unknown record subcommand: "${sub}"`);
      console.log('  Available: start [description], stop, status, list, view <id>, retranscribe <id>');
      showPrompt();
      break;
  }
}

// ---------------------------------------------------------------------------
// Workflow Parser & Executor
// ---------------------------------------------------------------------------

/** Recordings dir — matches session-manager.ts constant */
// Compiled JS at local-agent/dist/test/test-server.js → ../../ = local-agent/
const RECORDINGS_DIR = path.resolve(__dirname, '../../recordings');
/** Workflows dir — matches workflow-parser.ts constant */
const WORKFLOWS_DIR_PATH = path.resolve(__dirname, '../../workflows');

/**
 * Handle "parse <sessionId>" command.
 * Parses a recording session into a WorkflowDefinition using Claude.
 */
async function handleParseCommand(sessionId: string): Promise<void> {
  if (!sessionId) {
    console.log('  Usage: parse <sessionId>');
    console.log('  Tip: use "record list" to see available sessions.');
    showPrompt();
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  Error: ANTHROPIC_API_KEY not found.');
    console.log('  Create a .env file at the repo root with: ANTHROPIC_API_KEY=sk-ant-...');
    showPrompt();
    return;
  }

  const sessionDir = path.join(RECORDINGS_DIR, sessionId);
  const fs = await import('fs');
  if (!fs.existsSync(path.join(sessionDir, 'manifest.json'))) {
    console.log(`  No manifest.json found for session: ${sessionId}`);
    console.log(`  Looked in: ${sessionDir}`);
    showPrompt();
    return;
  }

  console.log(`\n  Parsing session "${sessionId}" into a workflow...`);
  console.log('  (This sends the recording data to Claude for analysis)\n');

  const workflow = await parseRecordingToWorkflow(sessionDir);

  console.log('');
  console.log(`  Workflow parsed successfully!`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  ID:           ${workflow.id}`);
  console.log(`  Name:         ${workflow.name}`);
  console.log(`  Description:  ${workflow.description}`);
  console.log(`  Apps:         ${workflow.applications.map((a) => a.name).join(', ') || 'none'}`);
  console.log(`  Variables:    ${workflow.variables.map((v) => v.name).join(', ') || 'none'}`);
  console.log(`  Steps:        ${workflow.steps.length}`);
  if (workflow.loops) {
    console.log(`  Loop:         over ${workflow.loops.over} (${workflow.loops.stepsInLoop.length} steps)`);
  }
  if (workflow.rules && workflow.rules.length > 0) {
    console.log(`  Rules:        ${workflow.rules.length}`);
  }
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Saved to: ${sessionDir}/workflow.json`);
  console.log(`  Saved to: ${WORKFLOWS_DIR_PATH}/${workflow.id}.json`);
  console.log('');

  // Print steps summary
  console.log('  Steps:');
  for (const step of workflow.steps) {
    console.log(`    ${step.id}. ${step.description} [${step.layer}/${step.action}]`);
  }
  console.log('');

  showPrompt();
}

/**
 * Handle "workflow <subcommand>" commands.
 */
async function handleWorkflowCommand(args: string): Promise<void> {
  const spaceIdx = args.indexOf(' ');
  const sub = (spaceIdx === -1 ? args : args.substring(0, spaceIdx)).toLowerCase().trim();
  const rest = spaceIdx === -1 ? '' : args.substring(spaceIdx + 1).trim();

  switch (sub) {
    case 'list': {
      const fs = await import('fs');
      console.log('');
      if (!fs.existsSync(WORKFLOWS_DIR_PATH)) {
        console.log('  No workflows found. Use "parse <sessionId>" to create one.');
        console.log('');
        showPrompt();
        return;
      }
      const files = fs.readdirSync(WORKFLOWS_DIR_PATH)
        .filter((f: string) => f.endsWith('.json'))
        .sort();

      if (files.length === 0) {
        console.log('  No workflows found. Use "parse <sessionId>" to create one.');
      } else {
        console.log(`  ${files.length} workflow(s):`);
        console.log('  ──────────────────────────────────────────────');
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(WORKFLOWS_DIR_PATH, file), 'utf8');
            const wf = JSON.parse(raw) as WorkflowDefinition;
            console.log(`  ${wf.id}`);
            console.log(`    Name:    ${wf.name}`);
            console.log(`    Steps:   ${wf.steps.length}`);
            console.log(`    Created: ${wf.createdAt}`);
            console.log('');
          } catch {
            console.log(`  ${file} (unreadable)`);
          }
        }
      }
      console.log('');
      showPrompt();
      break;
    }

    case 'run': {
      if (!rest) {
        console.log('  Usage: workflow run <workflowId>');
        console.log('  Tip: use "workflow list" to see available workflows.');
        showPrompt();
        return;
      }

      if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
        console.log('  Error: No agent connected. Start the agent first (npm run agent:dev)');
        showPrompt();
        return;
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        console.log('  Error: ANTHROPIC_API_KEY not found.');
        showPrompt();
        return;
      }

      // Load the workflow
      const fs = await import('fs');
      const workflowPath = path.join(WORKFLOWS_DIR_PATH, `${rest}.json`);
      if (!fs.existsSync(workflowPath)) {
        console.log(`  Workflow not found: ${rest}`);
        console.log(`  Looked in: ${workflowPath}`);
        showPrompt();
        return;
      }

      let workflow: WorkflowDefinition;
      try {
        workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8')) as WorkflowDefinition;
      } catch {
        console.log(`  Failed to parse workflow JSON: ${rest}`);
        showPrompt();
        return;
      }

      // Format the workflow as a goal and run the agent loop
      const goal = formatWorkflowAsGoal(workflow);
      console.log(`\n  Running workflow: "${workflow.name}" (${workflow.steps.length} steps)`);
      console.log('');

      runAgentLoop(goal).catch((err: Error) => {
        console.log(`\n  ✗ Agent loop error: ${err.message}`);
        agentLoopActive = false;
        showPrompt();
      });
      break;
    }

    default:
      if (!sub) {
        console.log('  Usage: workflow <list|run <id>>');
      } else {
        console.log(`  Unknown workflow subcommand: "${sub}"`);
        console.log('  Available: list, run <workflowId>');
      }
      showPrompt();
      break;
  }
}

// ---------------------------------------------------------------------------
// Agent Loop — helpers
// ---------------------------------------------------------------------------

/**
 * Format shell output for inclusion in conversation history.
 * Keeps the full text up to a limit; truncates with head+tail if too large.
 */
function formatShellOutput(output: string): string {
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
function formatActionResult(command: AgentCommand, result: AgentResult): string | null {
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
// Agent Loop
// ---------------------------------------------------------------------------

/**
 * Run the autonomous agent loop.
 * Observes the screen, sends observations to Claude, executes Claude's decisions.
 * Repeats until the goal is achieved, max iterations reached, or an error occurs.
 */
async function runAgentLoop(goal: string): Promise<void> {
  const maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS || '25', 10);
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  console.log('');
  console.log('  ╔════════════════════════════════════════════════════════╗');
  console.log('  ║              AGENT LOOP STARTING                       ║');
  console.log('  ╠════════════════════════════════════════════════════════╣');
  const goalLine = goal.substring(0, 48).padEnd(48);
  console.log(`  ║ Goal: ${goalLine} ║`);
  const modelLine = model.substring(0, 47).padEnd(47);
  console.log(`  ║ Model: ${modelLine} ║`);
  const iterLine = String(maxIterations).padEnd(46);
  console.log(`  ║ Max iterations: ${iterLine} ║`);
  console.log('  ╚════════════════════════════════════════════════════════╝');
  console.log('');

  agentLoopActive = true;
  agentCommandCounter = 0;

  try {
    initLLMClient();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ Failed to initialize LLM: ${msg}`);
    agentLoopActive = false;
    showPrompt();
    return;
  }

  resetConversation();

  const systemPrompt = buildSystemPrompt();
  const conversationHistory: ConversationMessage[] = [];
  let browserActive = false;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  for (let step = 1; step <= maxIterations; step++) {
    console.log(`  ┌─── Step ${step}/${maxIterations} ${'─'.repeat(44 - String(step).length - String(maxIterations).length)}┐`);

    // === OBSERVE ===
    console.log('  │ Observing...');
    let observation: Observation;
    try {
      observation = await observe(sendCommandAndWait, browserActive);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  │ ✗ Observation failed: ${msg}`);
      console.log('  └──────────────────────────────────────────────────────┘');
      break;
    }

    console.log(`  │ Screenshot: ${observation.screenshotSize.width}×${observation.screenshotSize.height}`);
    console.log(`  │ App: ${observation.frontmostApp} — "${observation.windowTitle}"`);
    const elemCount = observation.browserElements?.length ?? observation.desktopElements?.length ?? 0;
    console.log(`  │ Data: ${observation.availableLayer} (${elemCount} elements)`);

    // === BUILD MESSAGE ===
    const userMessage = formatObservation(observation, goal, step);
    conversationHistory.push(userMessage);

    // === DECIDE ===
    console.log('  │ Thinking...');
    let responseText: string;
    try {
      responseText = await sendMessage(systemPrompt, conversationHistory);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  │ ✗ LLM call failed: ${msg}`);
      console.log('  └──────────────────────────────────────────────────────┘');
      break;
    }

    // Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: responseText });

    // === PARSE RESPONSE ===
    agentCommandCounter++;
    const parsed = parseResponse(responseText, agentCommandCounter);

    if (parsed.type === 'complete') {
      console.log(`  │ ${parsed.thinking}`);
      console.log('  │');
      console.log('  │ GOAL ACHIEVED');
      console.log(`  │ ${parsed.summary}`);
      console.log('  └──────────────────────────────────────────────────────┘');
      console.log('');
      console.log('  ╔════════════════════════════════════════════════════════╗');
      console.log(`  ║ AGENT COMPLETE — ${step} step${step === 1 ? ' ' : 's'} ${'─'.repeat(34 - String(step).length)}║`);
      console.log('  ╚════════════════════════════════════════════════════════╝');
      console.log('');
      agentLoopActive = false;
      showPrompt();
      return;
    }

    if (parsed.type === 'needs_help') {
      console.log(`  │ ${parsed.thinking}`);
      console.log('  │');
      console.log(`  │ Agent needs help: ${parsed.question}`);
      console.log('  └──────────────────────────────────────────────────────┘');
      console.log('');
      console.log('  Agent paused. Restart with "agent <goal>" and provide more context.');
      agentLoopActive = false;
      showPrompt();
      return;
    }

    if (parsed.type === 'error') {
      consecutiveErrors++;
      console.log(`  │ Parse error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${parsed.error}`);
      console.log(`  │ Raw (first 200): ${parsed.rawResponse.substring(0, 200)}`);
      console.log('  └──────────────────────────────────────────────────────┘');

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log('');
        console.log(`  Stopping: ${MAX_CONSECUTIVE_ERRORS} consecutive API errors. Last error: ${parsed.error}`);
        break;
      }

      // Add plain-text correction only — no image — to avoid bloating the conversation
      conversationHistory.push({
        role: 'user',
        content:
          'Your previous response was not valid JSON. Respond with EXACTLY ONE JSON object — no markdown, no backticks, no extra text.',
      });
      continue;
    }

    if (parsed.type === 'action') {
      consecutiveErrors = 0; // reset circuit breaker on valid response
      console.log(`  │ ${parsed.thinking}`);
      console.log(`  │ Action: ${parsed.command.layer}/${parsed.command.action}`);

      // Show params (truncate large values like base64)
      const displayParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed.command.params)) {
        displayParams[k] = typeof v === 'string' && v.length > 100
          ? `${v.substring(0, 50)}...(${v.length} chars)`
          : v;
      }
      if (Object.keys(displayParams).length > 0) {
        console.log(`  │ Params: ${JSON.stringify(displayParams).substring(0, 150)}`);
      }

      // Track browser state
      if (parsed.command.layer === 'cdp' && parsed.command.action === 'launch') {
        browserActive = true;
      }
      if (parsed.command.layer === 'cdp' && parsed.command.action === 'close') {
        browserActive = false;
      }

      // === ACT ===
      console.log('  │ Executing...');
      let result: AgentResult;
      try {
        result = await sendCommandAndWait(parsed.command);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  │ ✗ Execution failed: ${msg}`);
        console.log('  └──────────────────────────────────────────────────────┘');
        conversationHistory.push({
          role: 'user',
          content: `The action failed with error: ${msg}. What should we try instead?`,
        });
        continue;
      }

      const statusMark = result.status === 'success' ? '✓' : '✗';
      console.log(`  │ ${statusMark} Result: ${result.status}`);

      // Show result data (truncate base64 blobs, but preserve shell output)
      const displayData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result.data)) {
        if (typeof v === 'string' && v.length > 500 && /^[A-Za-z0-9+/=\s]+$/.test(v.substring(0, 100))) {
          // Likely base64 data — truncate for display
          displayData[k] = `(${Math.round(v.length / 1024)}KB base64)`;
        } else {
          displayData[k] = v;
        }
      }
      console.log(`  │ Data: ${JSON.stringify(displayData).substring(0, 300)}`);
      console.log('  └──────────────────────────────────────────────────────┘');

      // Feed action result back to the LLM so it can see command output
      const resultFeedback = formatActionResult(parsed.command, result);
      if (resultFeedback) {
        conversationHistory.push({ role: 'user', content: resultFeedback });
      }

      // Let the UI settle before the next observation
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
    }
  }

  // Max iterations reached
  console.log('');
  console.log('  ╔════════════════════════════════════════════════════════╗');
  console.log(`  ║ MAX ITERATIONS (${maxIterations}) REACHED — STOPPING ${'─'.repeat(26 - String(maxIterations).length)}║`);
  console.log('  ╚════════════════════════════════════════════════════════╝');
  console.log('');
  agentLoopActive = false;
  showPrompt();
}

// Handle Ctrl+C gracefully
rl.on('close', () => {
  console.log('\n  Shutting down...');
  wss.close();
  process.exit(0);
});

// Show initial prompt
setTimeout(() => showPrompt(), 100);
