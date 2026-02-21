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
 *   screenshot                 — Request a vision screenshot (not implemented)
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
import { DEFAULT_WS_PORT, AgentCommand } from '@workflow-agent/shared';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Counter for generating unique command IDs */
let commandCounter = 0;

/** Reference to the connected agent (null if no agent is connected) */
let agentSocket: WebSocket | null = null;

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
        // Special formatting for screenshot (just show size, not the base64 blob)
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
        showPrompt();
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
  console.log('  Other:');
  console.log('  ──────────────────────────────────────────────');
  console.log('  screenshot                 Vision screenshot (not implemented)');
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

    case 'screenshot':
      sendCommand({
        type: 'command',
        id: nextId(),
        layer: 'vision',
        action: 'screenshot',
        params: {},
      });
      break;

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

// Handle Ctrl+C gracefully
rl.on('close', () => {
  console.log('\n  Shutting down...');
  wss.close();
  process.exit(0);
});

// Show initial prompt
setTimeout(() => showPrompt(), 100);
