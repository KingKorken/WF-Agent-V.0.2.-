/**
 * App Launcher — Layer 2: Application Management (macOS)
 *
 * Handles launching, switching, closing, and listing applications
 * on macOS using the `open` command and AppleScript (`osascript`).
 *
 * This is macOS-only for now. Windows/Linux support will be added
 * in a future implementation brief.
 */

import { executeShellCommand } from './shell-executor';
import { AppLauncherResult } from '@workflow-agent/shared';
import { log } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Launch an application by name.
 * Uses macOS `open -a` command which searches Applications folders.
 *
 * @param appName - The application name (e.g. "Google Chrome", "Finder")
 */
export async function launchApp(appName: string): Promise<AppLauncherResult> {
  log(`[${timestamp()}] [app-launcher] Launching: ${appName}`);

  const result = await executeShellCommand(`open -a "${appName}"`);

  if (result.exitCode === 0) {
    return { success: true, message: `Launched "${appName}" successfully` };
  }
  return { success: false, message: `Failed to launch "${appName}"`, error: result.error };
}

/**
 * Bring an application to the foreground.
 * Uses AppleScript to tell the app to activate (come to front).
 *
 * @param appName - The application name (e.g. "Google Chrome", "Finder")
 */
export async function switchToApp(appName: string): Promise<AppLauncherResult> {
  log(`[${timestamp()}] [app-launcher] Switching to: ${appName}`);

  const script = `osascript -e 'tell application "${appName}" to activate'`;
  const result = await executeShellCommand(script);

  if (result.exitCode === 0) {
    return { success: true, message: `Switched to "${appName}"` };
  }
  return { success: false, message: `Failed to switch to "${appName}"`, error: result.error };
}

/**
 * Quit an application gracefully.
 * Uses AppleScript to tell the app to quit.
 *
 * @param appName - The application name (e.g. "Google Chrome")
 */
export async function closeApp(appName: string): Promise<AppLauncherResult> {
  log(`[${timestamp()}] [app-launcher] Closing: ${appName}`);

  const script = `osascript -e 'tell application "${appName}" to quit'`;
  const result = await executeShellCommand(script);

  if (result.exitCode === 0) {
    return { success: true, message: `Closed "${appName}"` };
  }
  return { success: false, message: `Failed to close "${appName}"`, error: result.error };
}

/**
 * Get a list of all currently running applications.
 * Uses AppleScript to query the System Events process list.
 *
 * @returns A result containing a comma-separated list of running app names
 */
export async function listRunningApps(): Promise<AppLauncherResult> {
  log(`[${timestamp()}] [app-launcher] Listing running applications`);

  const script = `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`;
  const result = await executeShellCommand(script);

  if (result.exitCode === 0) {
    return { success: true, message: result.output };
  }
  return { success: false, message: 'Failed to list running applications', error: result.error };
}

/**
 * Minimize a window.
 * If appName is provided, activates that app first, waits briefly, then sends Cmd+M.
 * If no appName, just sends Cmd+M to whatever is currently in front.
 *
 * @param appName - Optional application name to minimize (e.g. "Google Chrome")
 */
export async function minimizeWindow(appName?: string): Promise<AppLauncherResult> {
  if (appName) {
    log(`[${timestamp()}] [app-launcher] Minimizing: ${appName}`);
    const script = `osascript -e 'tell application "${appName}" to activate' -e 'delay 0.5' -e 'tell application "System Events" to keystroke "m" using command down'`;
    const result = await executeShellCommand(script);

    if (result.exitCode === 0) {
      return { success: true, message: `Minimized "${appName}"` };
    }
    return { success: false, message: `Failed to minimize "${appName}"`, error: result.error };
  }

  log(`[${timestamp()}] [app-launcher] Minimizing frontmost window`);
  const script = `osascript -e 'tell application "System Events" to keystroke "m" using command down'`;
  const result = await executeShellCommand(script);

  if (result.exitCode === 0) {
    return { success: true, message: 'Minimized frontmost window' };
  }
  return { success: false, message: 'Failed to minimize window', error: result.error };
}
