/**
 * CDP Client — Page navigation, tab management, and screenshots.
 *
 * Wraps Playwright page operations into simple functions that the
 * layer-router can call. Each function gets the active page from
 * the browser-manager and performs the requested action.
 */

import { getActivePage, getBrowserContext, isBrowserRunning } from './browser-manager';
import { log, error as logError } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Standard result type for CDP operations */
export interface CdpResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Navigate the active page to a URL. Waits for the page to finish loading.
 */
export async function navigateTo(url: string): Promise<CdpResult> {
  const page = await getActivePage();
  if (!page) return { success: false, error: 'No browser running. Launch the browser first.' };

  try {
    log(`[${timestamp()}] [cdp-client] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title();
    log(`[${timestamp()}] [cdp-client] Page loaded: ${title}`);
    return { success: true, data: { url: page.url(), title } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [cdp-client] Navigation failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Get the current page URL.
 */
export async function getCurrentUrl(): Promise<CdpResult> {
  const page = await getActivePage();
  if (!page) return { success: false, error: 'No browser running.' };

  return { success: true, data: { url: page.url() } };
}

/**
 * Get the current page title.
 */
export async function getPageTitle(): Promise<CdpResult> {
  const page = await getActivePage();
  if (!page) return { success: false, error: 'No browser running.' };

  try {
    const title = await page.title();
    return { success: true, data: { title } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Get current page info (URL + title).
 */
export async function getPageInfo(): Promise<CdpResult> {
  const page = await getActivePage();
  if (!page) return { success: false, error: 'No browser running.' };

  try {
    const title = await page.title();
    return { success: true, data: { url: page.url(), title } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Create a new tab, optionally navigating to a URL.
 */
export async function createNewTab(url?: string): Promise<CdpResult> {
  const ctx = getBrowserContext();
  if (!ctx) return { success: false, error: 'No browser running.' };

  try {
    const page = await ctx.newPage();
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    const title = await page.title();
    log(`[${timestamp()}] [cdp-client] New tab opened: ${title || '(blank)'}`);
    return { success: true, data: { url: page.url(), title } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Close the currently active tab.
 */
export async function closeCurrentTab(): Promise<CdpResult> {
  const page = await getActivePage();
  if (!page) return { success: false, error: 'No browser running.' };

  try {
    const url = page.url();
    await page.close();
    log(`[${timestamp()}] [cdp-client] Closed tab: ${url}`);
    return { success: true, data: { closedUrl: url } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * List all open tabs with their titles and URLs.
 */
export async function listTabs(): Promise<CdpResult> {
  const ctx = getBrowserContext();
  if (!ctx) return { success: false, error: 'No browser running.' };

  try {
    const pages = ctx.pages();
    const tabs = await Promise.all(
      pages.map(async (p, i) => {
        let title = '';
        try { title = await p.title(); } catch { /* page may be loading */ }
        return { index: i, url: p.url(), title };
      })
    );
    return { success: true, data: { tabs, count: tabs.length } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Take a screenshot of the current page. Returns the image as a base64 string.
 */
export async function takeScreenshot(): Promise<CdpResult> {
  const page = await getActivePage();
  if (!page) return { success: false, error: 'No browser running.' };

  try {
    log(`[${timestamp()}] [cdp-client] Taking screenshot`);
    const buffer = await page.screenshot({ type: 'png' });
    const base64 = buffer.toString('base64');
    log(`[${timestamp()}] [cdp-client] Screenshot captured (${Math.round(base64.length / 1024)}KB base64)`);
    return { success: true, data: { screenshot: base64, format: 'png' } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// Re-export isBrowserRunning so callers don't need a separate import
export { isBrowserRunning };
