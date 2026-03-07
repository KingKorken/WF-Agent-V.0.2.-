/**
 * Setup Window — First-launch BrowserWindow for room token + macOS permissions.
 *
 * Shows on first launch when no room token is saved in config.json.
 * After entering a valid token and checking permissions, the window closes
 * and the agent connects to the bridge server.
 */

import { BrowserWindow, ipcMain, shell, systemPreferences } from 'electron';
import * as path from 'path';
import WebSocket from 'ws';
import { log } from '../utils/logger';
import { saveConfig } from '../utils/config';
import { startConnection } from '../main';
import { BRIDGE_URL } from '../build-config';

let setupWindow: BrowserWindow | null = null;
let validatedToken: string | null = null;

/**
 * Show the setup window for room token entry and permissions check.
 */
export function showSetupWindow(): void {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 460,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#E0E0E0',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Load the setup HTML page
  const htmlPath = path.join(__dirname, '../ui/setup.html');
  setupWindow.loadFile(htmlPath);

  setupWindow.on('closed', () => {
    setupWindow = null;
  });

  // --- IPC Handlers ---

  ipcMain.on('setup:connect', async (_event, token: string) => {
    log(`[setup] Validating token: ${token.slice(0, 8)}...`);
    const serverUrl = process.env.WS_URL || BRIDGE_URL;

    try {
      const success = await validateToken(serverUrl, token);
      if (success) {
        validatedToken = token;
        setupWindow?.webContents.send('setup:connect-result', { success: true });
      } else {
        setupWindow?.webContents.send('setup:connect-result', {
          success: false,
          error: 'Connection rejected. Check your room token.',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[setup] Connection failed: ${msg}`);
      setupWindow?.webContents.send('setup:connect-result', {
        success: false,
        error: `Connection failed: ${msg}`,
      });
    }
  });

  ipcMain.on('setup:check-permissions', () => {
    const perms = checkPermissions();
    setupWindow?.webContents.send('setup:permissions-result', perms);
  });

  ipcMain.on('setup:open-permission', (_event, type: string) => {
    switch (type) {
      case 'accessibility':
        // Open System Settings > Privacy & Security > Accessibility
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        break;
      case 'screen':
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        break;
      case 'microphone':
        // Trigger the native microphone permission prompt
        systemPreferences.askForMediaAccess('microphone').then((granted) => {
          log(`[setup] Microphone permission: ${granted ? 'granted' : 'denied'}`);
          const perms = checkPermissions();
          setupWindow?.webContents.send('setup:permissions-result', perms);
        });
        break;
    }
  });

  ipcMain.on('setup:done', () => {
    if (validatedToken) {
      // Save config and start connection
      saveConfig({ roomId: validatedToken });
      startConnection(validatedToken);

      // Close setup window
      if (setupWindow) {
        setupWindow.close();
        setupWindow = null;
      }

      // Clean up IPC handlers
      ipcMain.removeAllListeners('setup:connect');
      ipcMain.removeAllListeners('setup:check-permissions');
      ipcMain.removeAllListeners('setup:open-permission');
      ipcMain.removeAllListeners('setup:done');
    }
  });
}

/**
 * Validate a room token by attempting a WebSocket connection to the bridge.
 * Returns true if the connection is accepted, false if rejected.
 */
function validateToken(serverUrl: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Convert ws:// to wss:// or vice versa based on URL
    const ws = new WebSocket(serverUrl);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 5000);

    ws.on('open', () => {
      // Send hello with room token
      ws.send(JSON.stringify({
        type: 'hello',
        agentName: 'setup-validator',
        version: '0.1.0',
        platform: process.platform,
        supportedLayers: [],
        roomId: token,
      }));

      // If still connected after 1 second, token was accepted
      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      }, 1000);
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      // 1008 = Policy Violation (invalid room token)
      if (code === 1008) {
        resolve(false);
      }
      // Normal close after our test = success (already resolved above)
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Check macOS permissions. Only runs on macOS (darwin).
 */
function checkPermissions(): { accessibility: boolean; screenRecording: boolean; microphone: boolean } {
  if (process.platform !== 'darwin') {
    return { accessibility: true, screenRecording: true, microphone: true };
  }

  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    microphone: systemPreferences.getMediaAccessStatus('microphone') === 'granted',
  };
}
