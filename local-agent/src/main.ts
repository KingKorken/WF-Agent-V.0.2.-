/**
 * Electron Main Process — Entry point for the Local Agent.
 *
 * This is the file that runs when you start the Electron app.
 * It does three things:
 *   1. Creates a minimal Electron app (no visible window)
 *   2. Sets up the system tray icon
 *   3. Connects to the cloud server via WebSocket
 *
 * The app runs in the background — the user interacts with it
 * through the system tray icon in the menu bar.
 */

import { app } from 'electron';
import { WebSocketClient } from './connection/websocket-client';
import { createTray, updateConnectionStatus } from './ui/tray';
import { APP_NAME, DEFAULT_WS_URL } from '@workflow-agent/shared';
import { log } from './utils/logger';

// ---------------------------------------------------------------------------
// Global error handlers — prevent async EIO crashes from killing the process
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err: Error) => {
  // "write EIO" happens when Electron's stdout/stderr stream breaks
  // (terminal closes, pipe breaks, etc.). Silently swallow these.
  if (err.message && err.message.includes('EIO')) {
    return; // non-fatal — swallow and continue
  }
  // Log other uncaught exceptions but don't crash
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
 * Initialize the agent when Electron is ready.
 * - No visible window is created (the agent runs in the background)
 * - The system tray icon provides status and a quit button
 * - The WebSocket connection is established to receive commands
 */
app.whenReady().then(() => {
  log(`[${timestamp()}] [main] ${APP_NAME} starting...`);
  log(`[${timestamp()}] [main] Platform: ${process.platform}`);

  // Step 1: Create the system tray icon
  createTray();

  // Step 2: Set up the WebSocket connection
  // Use the WS_URL environment variable if set, otherwise use the default
  const serverUrl = process.env.WS_URL || DEFAULT_WS_URL;
  const roomId = process.env.ROOM_ID || undefined;
  log(`[${timestamp()}] [main] Connecting to server: ${serverUrl}`);
  if (roomId) {
    log(`[${timestamp()}] [main] Room: ${roomId.substring(0, 8)}...`);
  }

  wsClient = new WebSocketClient(serverUrl, roomId);

  // Update the tray icon when connection status changes
  wsClient.onStatusChange((connected) => {
    updateConnectionStatus(connected);
  });

  // Connect to the server
  wsClient.connect();

  log(`[${timestamp()}] [main] ${APP_NAME} is running. Check the system tray.`);
});

// Prevent the app from quitting when all windows are closed (we have no windows)
app.on('window-all-closed', (e: Event) => {
  // Do nothing — the agent should keep running in the background
  e.preventDefault();
});

// Clean up when the app is quitting
app.on('before-quit', () => {
  log(`[${timestamp()}] [main] ${APP_NAME} shutting down...`);
  if (wsClient) {
    wsClient.disconnect();
  }
});
