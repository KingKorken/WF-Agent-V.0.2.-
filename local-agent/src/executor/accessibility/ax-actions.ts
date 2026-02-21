/**
 * Accessibility Actions — Perform actions on elements by reference ID.
 *
 * When the cloud says "click ax_5" or "set value ax_12 to 4200", this module
 * looks up what element ax_5/ax_12 maps to (from the last snapshot) and
 * performs the action via the macOS accessibility bridge.
 *
 * All functions return structured results and never throw.
 */

import { getPathForRef } from './ax-tree';
import {
  clickElementByPath,
  setElementValueByPath,
  getElementAttribute,
  focusElementByPath,
  clickMenuPath,
  activateApp as macosActivateApp,
  getWindowInfo as macosGetWindowInfo,
} from './macos-ax';
import { log, error as logError } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Standard result type for accessibility actions */
export interface AXActionResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Actions by Ref ID
// ---------------------------------------------------------------------------

/**
 * Click/press an element by its reference ID.
 * Looks up the element path from the stored snapshot mapping.
 */
export async function clickElement(ref: string): Promise<AXActionResult> {
  log(`[${timestamp()}] [ax-actions] Click: ${ref}`);

  const mapping = getPathForRef(ref);
  if (!mapping) {
    return {
      success: false,
      error: `Unknown reference "${ref}". Take a new snapshot to get current elements.`,
    };
  }

  try {
    await clickElementByPath(mapping.appName, mapping.elementPath);
    return { success: true, data: { action: 'click', ref } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-actions] Click failed for ${ref}: ${message}`);
    return { success: false, error: `Click failed: ${message}` };
  }
}

/**
 * Set the value of an element (text field, cell, etc.) by its reference ID.
 */
export async function setElementValue(ref: string, value: string): Promise<AXActionResult> {
  log(`[${timestamp()}] [ax-actions] Set value ${ref}: "${value.substring(0, 50)}${value.length > 50 ? '...' : ''}"`);

  const mapping = getPathForRef(ref);
  if (!mapping) {
    return {
      success: false,
      error: `Unknown reference "${ref}". Take a new snapshot to get current elements.`,
    };
  }

  try {
    await setElementValueByPath(mapping.appName, mapping.elementPath, value);
    return { success: true, data: { action: 'set_value', ref, value } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-actions] Set value failed for ${ref}: ${message}`);
    return { success: false, error: `Set value failed: ${message}` };
  }
}

/**
 * Read the current value of an element by its reference ID.
 */
export async function getElementValue(ref: string): Promise<AXActionResult> {
  log(`[${timestamp()}] [ax-actions] Get value: ${ref}`);

  const mapping = getPathForRef(ref);
  if (!mapping) {
    return {
      success: false,
      error: `Unknown reference "${ref}". Take a new snapshot to get current elements.`,
    };
  }

  try {
    const value = await getElementAttribute(mapping.appName, mapping.elementPath, 'value');
    return { success: true, data: { ref, value } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-actions] Get value failed for ${ref}: ${message}`);
    return { success: false, error: `Get value failed: ${message}` };
  }
}

/**
 * Set focus to an element by its reference ID.
 */
export async function focusElement(ref: string): Promise<AXActionResult> {
  log(`[${timestamp()}] [ax-actions] Focus: ${ref}`);

  const mapping = getPathForRef(ref);
  if (!mapping) {
    return {
      success: false,
      error: `Unknown reference "${ref}". Take a new snapshot to get current elements.`,
    };
  }

  try {
    await focusElementByPath(mapping.appName, mapping.elementPath);
    return { success: true, data: { action: 'focus', ref } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-actions] Focus failed for ${ref}: ${message}`);
    return { success: false, error: `Focus failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Actions by App Name (not ref-based)
// ---------------------------------------------------------------------------

/**
 * Click through a menu path in an application.
 * E.g., pressMenuPath("TextEdit", ["File", "Save"])
 */
export async function pressMenuPath(appName: string, menuPath: string[]): Promise<AXActionResult> {
  log(`[${timestamp()}] [ax-actions] Menu click in ${appName}: ${menuPath.join(' → ')}`);

  try {
    await clickMenuPath(appName, menuPath);
    return { success: true, data: { action: 'menu_click', app: appName, menuPath } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-actions] Menu click failed: ${message}`);
    return { success: false, error: `Menu click failed: ${message}` };
  }
}

/**
 * Activate (bring to front) an application.
 */
export async function activateApp(appName: string): Promise<AXActionResult> {
  log(`[${timestamp()}] [ax-actions] Activate: ${appName}`);

  try {
    await macosActivateApp(appName);
    return { success: true, data: { action: 'activate', app: appName } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-actions] Activate failed: ${message}`);
    return { success: false, error: `Activate failed: ${message}` };
  }
}

/**
 * Get window info for an application (titles, positions, sizes).
 */
export async function getWindowInfo(appName: string): Promise<AXActionResult> {
  log(`[${timestamp()}] [ax-actions] Window info: ${appName}`);

  try {
    const windows = await macosGetWindowInfo(appName);
    return { success: true, data: { app: appName, windows } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-actions] Window info failed: ${message}`);
    return { success: false, error: `Window info failed: ${message}` };
  }
}
