/**
 * Browser Manager — Launches and manages an isolated Chromium browser.
 *
 * Uses Playwright's persistent context to create a browser profile
 * that is completely separate from the user's personal Chrome.
 * The browser is VISIBLE (not headless) so the user can see what
 * the agent is doing.
 *
 * Profile data is stored in ~/.workflow-agent/browser-profile/
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import os from 'os';
import { log, error as logError } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Where the isolated browser profile is stored */
const BROWSER_PROFILE_DIR = path.join(os.homedir(), '.workflow-agent', 'browser-profile');

/** The Playwright browser context (one persistent instance) */
let browserContext: BrowserContext | null = null;

/**
 * Launch the isolated browser if it's not already running.
 * Opens a visible Chromium window with its own profile directory.
 */
export async function launchBrowser(): Promise<{ success: boolean; error?: string }> {
  if (browserContext) {
    log(`[${timestamp()}] [browser-manager] Browser is already running`);
    return { success: true };
  }

  try {
    log(`[${timestamp()}] [browser-manager] Launching browser (profile: ${BROWSER_PROFILE_DIR})`);

    browserContext = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: false,
      viewport: null,              // Use the full window size, not a fixed viewport
      args: [
        '--disable-blink-features=AutomationControlled',  // Less "automation detected" flags
      ],
    });

    // When the user closes the browser window manually, clean up our reference
    browserContext.on('close', () => {
      log(`[${timestamp()}] [browser-manager] Browser closed`);
      browserContext = null;
    });

    log(`[${timestamp()}] [browser-manager] Browser launched successfully`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [browser-manager] Failed to launch browser: ${message}`);
    browserContext = null;
    return { success: false, error: message };
  }
}

/**
 * Close the browser gracefully.
 */
export async function closeBrowser(): Promise<{ success: boolean; error?: string }> {
  if (!browserContext) {
    log(`[${timestamp()}] [browser-manager] No browser running`);
    return { success: true };
  }

  try {
    log(`[${timestamp()}] [browser-manager] Closing browser`);
    await browserContext.close();
    browserContext = null;
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [browser-manager] Error closing browser: ${message}`);
    browserContext = null;
    return { success: false, error: message };
  }
}

/**
 * Check if the browser is currently running.
 */
export function isBrowserRunning(): boolean {
  return browserContext !== null;
}

/**
 * Get the currently active page (last focused tab).
 * If no pages exist, creates a new blank one.
 * Returns null if no browser is running.
 */
export async function getActivePage(): Promise<Page | null> {
  if (!browserContext) return null;

  const pages = browserContext.pages();
  if (pages.length === 0) {
    // Browser is open but no tabs — create one
    return await browserContext.newPage();
  }

  // Return the last page (Playwright tracks most recently used)
  return pages[pages.length - 1];
}

/**
 * Get the browser context directly (for creating new pages, etc.).
 * Returns null if no browser is running.
 */
export function getBrowserContext(): BrowserContext | null {
  return browserContext;
}
