/**
 * Setup Preload — Exposes only the IPC channels needed by setup.html.
 *
 * This runs in the renderer process with Node.js access, but setup.html
 * only sees the `window.setupAPI` object — no direct Node/Electron access.
 *
 * Security: contextIsolation: true ensures the renderer cannot reach
 * ipcRenderer, require, or any Node APIs directly.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('setupAPI', {
  connect: (token: string) => ipcRenderer.send('setup:connect', token),
  checkPermissions: () => ipcRenderer.send('setup:check-permissions'),
  openPermission: (type: string) => ipcRenderer.send('setup:open-permission', type),
  done: () => ipcRenderer.send('setup:done'),

  onConnectResult: (callback: (result: { success: boolean; error?: string }) => void) => {
    ipcRenderer.on('setup:connect-result', (_event, result) => callback(result));
  },
  onPermissionsResult: (callback: (perms: { accessibility: boolean; screenRecording: boolean; microphone: boolean }) => void) => {
    ipcRenderer.on('setup:permissions-result', (_event, perms) => callback(perms));
  },
});
