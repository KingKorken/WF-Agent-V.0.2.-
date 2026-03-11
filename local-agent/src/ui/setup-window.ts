/**
 * Setup Window — First-launch BrowserWindow for room token + macOS permissions.
 *
 * Shows on first launch when no room token is saved in config.json.
 * After entering a valid token and checking permissions, the window closes
 * and the agent connects to the bridge server.
 *
 * Security: Uses contextIsolation + preload script (no nodeIntegration).
 */

import { BrowserWindow, app, ipcMain, IpcMainEvent, shell, systemPreferences } from 'electron';
import * as path from 'path';
import WebSocket from 'ws';
import { log } from '../utils/logger';
import { saveConfig } from '../utils/config';
import { startConnection } from '../main';
import { BRIDGE_URL } from '../build-config';
import { checkRequiredPermissions } from '../platform/permissions';

type IpcHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

let setupWindow: BrowserWindow | null = null;
let validatedToken: string | null = null;

// IPC handler references for cleanup
const ipcHandlers = {
  connect: null as IpcHandler | null,
  checkPermissions: null as IpcHandler | null,
  openPermission: null as IpcHandler | null,
  done: null as IpcHandler | null,
};

/** Remove all setup IPC handlers */
function cleanupIpcHandlers(): void {
  if (ipcHandlers.connect) ipcMain.removeListener('setup:connect', ipcHandlers.connect);
  if (ipcHandlers.checkPermissions) ipcMain.removeListener('setup:check-permissions', ipcHandlers.checkPermissions);
  if (ipcHandlers.openPermission) ipcMain.removeListener('setup:open-permission', ipcHandlers.openPermission);
  if (ipcHandlers.done) ipcMain.removeListener('setup:done', ipcHandlers.done);
  ipcHandlers.connect = null;
  ipcHandlers.checkPermissions = null;
  ipcHandlers.openPermission = null;
  ipcHandlers.done = null;
}

/**
 * Show the setup window for room token entry and permissions check.
 */
export function showSetupWindow(): void {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  // Use app.getAppPath() for path resolution that works in both dev and packaged builds.
  // In dev:      app.getAppPath() → local-agent/
  // In packaged: app.getAppPath() → Contents/Resources/app.asar (Electron reads from asar transparently)
  // NOTE: Do NOT use process.resourcesPath — that points outside the asar where these files don't exist.
  const appRoot = app.getAppPath();
  const preloadPath = path.join(appRoot, 'dist/src/ui/setup-preload.js');
  const htmlPath = path.join(appRoot, 'dist/src/ui/setup.html');
  log(`[setup] App root: ${appRoot}`);
  log(`[setup] Preload path: ${preloadPath}`);
  log(`[setup] HTML path: ${htmlPath}`);

  setupWindow = new BrowserWindow({
    width: 460,
    height: 520,
    show: false, // Wait for ready-to-show to avoid blank flash
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#E0E0E0',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  // Show window once content is ready (prevents blank flash)
  setupWindow.once('ready-to-show', () => {
    log('[setup] Window ready — showing');
    setupWindow?.show();
  });

  // Load the setup HTML page
  setupWindow.loadFile(htmlPath);

  // Log load failures for debugging
  setupWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log(`[setup] Failed to load HTML (${errorCode}): ${errorDescription}`);
  });

  // Clean up IPC handlers AND window reference on close (B2 fix)
  setupWindow.on('closed', () => {
    setupWindow = null;
    cleanupIpcHandlers();
  });

  // --- IPC Handlers (stored for cleanup) ---

  ipcHandlers.connect = async (_event: IpcMainEvent, ...args: unknown[]) => {
    const token = args[0] as string;
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
  };

  ipcHandlers.checkPermissions = (_event: IpcMainEvent) => {
    const perms = checkPermissions();
    setupWindow?.webContents.send('setup:permissions-result', perms);
  };

  ipcHandlers.openPermission = (_event: IpcMainEvent, ...args: unknown[]) => {
    const type = args[0] as string;
    switch (type) {
      case 'accessibility':
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        break;
      case 'screen':
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        break;
      case 'microphone':
        systemPreferences.askForMediaAccess('microphone').then((granted) => {
          log(`[setup] Microphone permission: ${granted ? 'granted' : 'denied'}`);
          const perms = checkPermissions();
          setupWindow?.webContents.send('setup:permissions-result', perms);
        });
        break;
    }
  };

  ipcHandlers.done = (_event: IpcMainEvent) => {
    if (validatedToken) {
      saveConfig({ roomId: validatedToken });
      startConnection(validatedToken);

      if (setupWindow) {
        setupWindow.close();
        // closed event handles cleanup
      }
    }
  };

  ipcMain.on('setup:connect', ipcHandlers.connect);
  ipcMain.on('setup:check-permissions', ipcHandlers.checkPermissions);
  ipcMain.on('setup:open-permission', ipcHandlers.openPermission);
  ipcMain.on('setup:done', ipcHandlers.done);
}

/**
 * Validate a room token by attempting a WebSocket connection to the bridge.
 * Returns true if the connection is accepted, false if rejected.
 */
function validateToken(serverUrl: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    function settle(value: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(outerTimeout);
      ws.close();
      resolve(value);
    }

    const ws = new WebSocket(serverUrl);
    const outerTimeout = setTimeout(() => settle(false), 5000);

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
      setTimeout(() => settle(true), 1000);
    });

    ws.on('close', (code) => {
      // 1008 = Policy Violation (invalid room token)
      if (code === 1008) settle(false);
    });

    ws.on('error', () => settle(false));
  });
}

/**
 * Check macOS permissions. Uses shared module for accessibility + screen recording,
 * adds microphone check as a setup-only concern (not needed for command execution).
 */
function checkPermissions(): { accessibility: boolean; screenRecording: boolean; microphone: boolean } {
  const shared = checkRequiredPermissions();
  const microphone = process.platform === 'darwin'
    ? systemPreferences.getMediaAccessStatus('microphone') === 'granted'
    : true;

  return { ...shared, microphone };
}
