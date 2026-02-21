/**
 * System Tray — Minimal tray icon and menu for the Local Agent.
 *
 * Shows a small icon in the macOS menu bar (or Windows system tray) with:
 *   - The app name
 *   - Current connection status (Connected / Disconnected)
 *   - A quit button
 *
 * The tray icon is the main way the user knows the agent is running,
 * since there's no visible window.
 */

import { Tray, Menu, nativeImage, app } from 'electron';
import { APP_NAME } from '@workflow-agent/shared';
import { log } from '../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Reference to the tray instance (kept so it doesn't get garbage collected) */
let tray: Tray | null = null;

/** Current connection status shown in the tray menu */
let connected: boolean = false;

/**
 * Create the system tray icon and menu.
 * Call this once during app startup.
 */
export function createTray(): void {
  log(`[${timestamp()}] [tray] Creating system tray`);

  // Create a small 16x16 empty image as the tray icon
  // (In a real app you'd use a proper icon file — this is just a placeholder)
  const icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  updateTrayMenu();
}

/**
 * Update the connection status shown in the tray menu.
 * Called by the WebSocket client when the connection status changes.
 *
 * @param isConnected - Whether the agent is currently connected to the server
 */
export function updateConnectionStatus(isConnected: boolean): void {
  connected = isConnected;
  log(`[${timestamp()}] [tray] Connection status: ${connected ? 'Connected' : 'Disconnected'}`);
  updateTrayMenu();
}

/**
 * Rebuild the tray context menu with current status.
 */
function updateTrayMenu(): void {
  if (!tray) return;

  const statusLabel = connected ? '● Connected' : '○ Disconnected';

  const contextMenu = Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        log(`[${timestamp()}] [tray] User clicked Quit`);
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}
