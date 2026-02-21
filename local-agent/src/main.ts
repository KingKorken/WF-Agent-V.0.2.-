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
  log(`[${timestamp()}] [main] Connecting to server: ${serverUrl}`);

  wsClient = new WebSocketClient(serverUrl);

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
