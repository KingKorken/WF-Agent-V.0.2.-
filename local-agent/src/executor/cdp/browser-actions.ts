/**
 * Browser Actions — Perform actions on elements by reference ID.
 *
 * When the cloud says "click e7" or "type e3 Hello", this module
 * looks up what element e7/e3 maps to (from the last snapshot) and
 * performs the action via Playwright.
 *
 * All functions return structured results and never throw.
 */

import { getLocatorForRef } from './element-snapshot';
import { log, error as logError } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Standard result type for browser actions */
export interface ActionResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Click an element by its reference ID.
 */
export async function clickElement(ref: string): Promise<ActionResult> {
  log(`[${timestamp()}] [browser-actions] Click: ${ref}`);

  const { locator, error } = await getLocatorForRef(ref);
  if (!locator) return { success: false, error };

  try {
    await locator.click({ timeout: 10_000 });
    return { success: true, data: { action: 'click', ref } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [browser-actions] Click failed for ${ref}: ${message}`);
    return { success: false, error: `Click failed: ${message}` };
  }
}

/**
 * Clear an element and type text into it.
 */
export async function typeInElement(ref: string, text: string): Promise<ActionResult> {
  log(`[${timestamp()}] [browser-actions] Type into ${ref}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

  const { locator, error } = await getLocatorForRef(ref);
  if (!locator) return { success: false, error };

  try {
    await locator.click({ timeout: 5_000 }); // Focus the element first
    await locator.fill(text);                 // Clear existing content and type
    return { success: true, data: { action: 'type', ref, text } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [browser-actions] Type failed for ${ref}: ${message}`);
    return { success: false, error: `Type failed: ${message}` };
  }
}

/**
 * Select an option in a dropdown by visible text or value.
 */
export async function selectOption(ref: string, value: string): Promise<ActionResult> {
  log(`[${timestamp()}] [browser-actions] Select "${value}" in ${ref}`);

  const { locator, error } = await getLocatorForRef(ref);
  if (!locator) return { success: false, error };

  try {
    // Try selecting by label (visible text) first, fall back to value
    await locator.selectOption({ label: value }, { timeout: 5_000 });
    return { success: true, data: { action: 'select', ref, value } };
  } catch {
    // If label didn't work, try by value attribute
    try {
      await locator.selectOption({ value }, { timeout: 5_000 });
      return { success: true, data: { action: 'select', ref, value } };
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2);
      logError(`[${timestamp()}] [browser-actions] Select failed for ${ref}: ${message}`);
      return { success: false, error: `Select failed: ${message}` };
    }
  }
}

/**
 * Check or uncheck a checkbox.
 */
export async function checkElement(ref: string, checked: boolean): Promise<ActionResult> {
  log(`[${timestamp()}] [browser-actions] ${checked ? 'Check' : 'Uncheck'}: ${ref}`);

  const { locator, error } = await getLocatorForRef(ref);
  if (!locator) return { success: false, error };

  try {
    if (checked) {
      await locator.check({ timeout: 5_000 });
    } else {
      await locator.uncheck({ timeout: 5_000 });
    }
    return { success: true, data: { action: 'check', ref, checked } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Check failed: ${message}` };
  }
}

/**
 * Read the current value of an element.
 */
export async function getElementValue(ref: string): Promise<ActionResult> {
  log(`[${timestamp()}] [browser-actions] Get value: ${ref}`);

  const { locator, error } = await getLocatorForRef(ref);
  if (!locator) return { success: false, error };

  try {
    const value = await locator.inputValue({ timeout: 5_000 });
    return { success: true, data: { ref, value } };
  } catch {
    // Not an input element — try textContent instead
    try {
      const text = await locator.textContent({ timeout: 5_000 });
      return { success: true, data: { ref, value: text || '' } };
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2);
      return { success: false, error: `Get value failed: ${message}` };
    }
  }
}

/**
 * Hover over an element.
 */
export async function hoverElement(ref: string): Promise<ActionResult> {
  log(`[${timestamp()}] [browser-actions] Hover: ${ref}`);

  const { locator, error } = await getLocatorForRef(ref);
  if (!locator) return { success: false, error };

  try {
    await locator.hover({ timeout: 5_000 });
    return { success: true, data: { action: 'hover', ref } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Hover failed: ${message}` };
  }
}
