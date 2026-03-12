/**
 * Electron Main Process — Entry point for the Local Agent.
 *
 * This is the file that runs when you start the Electron app.
 * It does four things:
 *   1. Creates a minimal Electron app (no visible window)
 *   2. Sets up the system tray icon
 *   3. On first launch: shows setup window for room token + permissions
 *   4. Connects to the bridge server via WebSocket
 *
 * The app runs in the background — the user interacts with it
 * through the system tray icon in the menu bar.
 */

import { app, dialog } from 'electron';
import WebSocket from 'ws';
import { WebSocketClient } from './connection/websocket-client';
import { createTray, updateConnectionStatus } from './ui/tray';
import { APP_NAME } from '@workflow-agent/shared';
import { log } from './utils/logger';
import { loadConfig, clearConfig } from './utils/config';
import { BRIDGE_URL, ANTHROPIC_KEY } from './build-config';

// ---------------------------------------------------------------------------
// Global error handlers — prevent async EIO crashes from killing the process
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err: Error) => {
  if (err.message && err.message.includes('EIO')) {
    return;
  }
  try {
    console.error(`[uncaughtException] ${err.message}\n${err.stack}`);
  } catch {
    // If even stderr is broken, just swallow
  }
});

process.on('unhandledRejection', (reason: unknown) => {
  try {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[unhandledRejection] ${msg}`);
  } catch {
    // swallow
  }
});

// Prevent broken pipe crashes when stdout/stderr streams break
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err: Error) => {
    if (err.message.includes('EIO') || err.message.includes('EPIPE')) return;
  });
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', (err: Error) => {
    if (err.message.includes('EIO') || err.message.includes('EPIPE')) return;
  });
}

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

// The WebSocket client instance (created on app ready)
let wsClient: WebSocketClient;

/**
 * Start the WebSocket connection to the bridge server.
 * Passed as a callback to showSetupWindow() on first launch.
 */
export function startConnection(roomId: string): void {
  const serverUrl = process.env.WS_URL || BRIDGE_URL;
  log(`[${timestamp()}] [main] Connecting to server: ${serverUrl}`);
  log(`[${timestamp()}] [main] Room: ${roomId.substring(0, 8)}...`);

  // Set ANTHROPIC_API_KEY from build-config if not already in env
  if (ANTHROPIC_KEY && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
  }

  wsClient = new WebSocketClient(serverUrl, roomId);

  wsClient.onStatusChange((connected) => {
    updateConnectionStatus(connected);
  });

  wsClient.connect();
}

/**
 * Quick-check whether a saved room token is still valid by opening a temporary
 * WebSocket and waiting for the server to either accept or reject the hello.
 * Returns true if the bridge accepts the token, false otherwise.
 */
function verifySavedToken(serverUrl: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    function settle(value: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch { /* ignore */ }
      resolve(value);
    }

    const ws = new WebSocket(serverUrl);
    const timeout = setTimeout(() => settle(false), 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        agentName: 'token-validator',
        version: '0.1.0',
        platform: process.platform,
        supportedLayers: [],
        roomId: token,
      }));
      // If still connected after 1.5s, token was accepted
      setTimeout(() => settle(true), 1500);
    });

    ws.on('close', (code) => {
      // 1008 = Policy Violation (invalid/expired room token)
      if (code === 1008) settle(false);
    });

    ws.on('error', () => settle(false));
  });
}

/**
 * Show the setup window. Extracted as a helper to avoid duplication.
 */
async function showSetup(): Promise<void> {
  try {
    const { showSetupWindow } = await import('./ui/setup-window');
    showSetupWindow(startConnection);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[${timestamp()}] [main] CRITICAL: Failed to show setup window: ${msg}`);
    dialog.showErrorBox('Setup Error',
      `Failed to open setup window.\n\n${msg}\n\nPlease reinstall the application.`);
  }
}

/**
 * Initialize the agent when Electron is ready.
 */
app.whenReady().then(async () => {
  log(`[${timestamp()}] [main] ${APP_NAME} starting...`);
  log(`[${timestamp()}] [main] Platform: ${process.platform}`);

  // Step 1: Create the system tray icon
  createTray();

  // Step 2: Determine room ID (env var > saved config > setup window)
  const envRoomId = process.env.ROOM_ID;
  const savedConfig = loadConfig();

  if (envRoomId) {
    log(`[${timestamp()}] [main] Using room ID from environment`);
    startConnection(envRoomId);
  } else if (savedConfig) {
    // Validate the saved token before using it — stale tokens survive app reinstalls
    // because macOS does not delete ~/Library/Application Support/ on uninstall.
    const serverUrl = process.env.WS_URL || BRIDGE_URL;
    log(`[${timestamp()}] [main] Verifying saved room token...`);
    const valid = await verifySavedToken(serverUrl, savedConfig.roomId);
    if (valid) {
      log(`[${timestamp()}] [main] Saved token verified — connecting`);
      startConnection(savedConfig.roomId);
    } else {
      log(`[${timestamp()}] [main] Saved token invalid or bridge unreachable — clearing config and showing setup window`);
      clearConfig();
      await showSetup();
    }
  } else {
    log(`[${timestamp()}] [main] No room ID found — showing setup window`);
    await showSetup();
  }

  log(`[${timestamp()}] [main] ${APP_NAME} is running. Check the system tray.`);
});

// Prevent the app from quitting when all windows are closed (we have no windows)
app.on('window-all-closed', (e: Event) => {
  e.preventDefault();
});

// Clean up when the app is quitting
app.on('before-quit', () => {
  log(`[${timestamp()}] [main] ${APP_NAME} shutting down...`);
  if (wsClient) {
    wsClient.disconnect();
  }
});
