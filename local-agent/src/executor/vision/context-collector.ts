/**
 * Context Collector — Gather hybrid context alongside a screenshot.
 *
 * This is what makes Layer 5 "hybrid" instead of "blind."
 * It combines:
 *   - A screenshot (visual)
 *   - Window metadata (frontmost app, title, bounds, screen size)
 *   - Partial accessibility data (whatever Layer 4 can give us in 3s)
 *   - Action history (what we just did)
 *   - Task context (what we're trying to accomplish)
 *
 * Even apps with poor accessibility support expose SOME data:
 * a window title, menu bar items, a few labels. Combined with the
 * screenshot this gives the LLM far more to work with than raw pixels.
 */

import { log, error as logError } from '../../utils/logger';
import { runJxa, getInteractiveElements, RawInteractiveElement } from '../accessibility/macos-ax';
import { captureFullScreen, captureWindow } from './screenshot';
import { getRecentActions } from './action-history';
import { VisionContext, PartialAXElement } from '@workflow-agent/shared';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** 3-second timeout for partial accessibility collection — don't hang waiting */
const PARTIAL_AX_TIMEOUT = 3000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Get the name of the frontmost application */
async function getFrontmostApp(): Promise<string> {
  try {
    const script = `Application('System Events').processes.whose({ frontmost: true })[0].name()`;
    return await runJxa(script);
  } catch {
    return 'Unknown';
  }
}

/** Get window title for a specific app */
async function getWindowTitle(appName: string): Promise<string> {
  try {
    const escaped = appName.replace(/'/g, "\\'");
    const script = `Application('System Events').processes.byName('${escaped}').windows[0].title()`;
    return await runJxa(script);
  } catch {
    return '';
  }
}

/** Get window bounds (position + size) for a specific app */
async function getWindowBounds(
  appName: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  try {
    const escaped = appName.replace(/'/g, "\\'");
    const script = `
      var proc = Application('System Events').processes.byName('${escaped}');
      var win = proc.windows[0];
      var pos = win.position();
      var size = win.size();
      JSON.stringify({ x: pos[0], y: pos[1], width: size[0], height: size[1] });
    `;
    const raw = await runJxa(script);
    return JSON.parse(raw);
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

/** Get screen dimensions via ObjC AppKit bridge */
async function getScreenSize(): Promise<{ width: number; height: number }> {
  try {
    const script = `
      ObjC.import('AppKit');
      var f = $.NSScreen.mainScreen.frame;
      JSON.stringify({ width: f.size.width, height: f.size.height });
    `;
    const raw = await runJxa(script);
    return JSON.parse(raw);
  } catch {
    return { width: 0, height: 0 };
  }
}

/** Get menu bar item titles for an app — almost always accessible */
async function getMenuBarItems(appName: string): Promise<string[]> {
  try {
    const escaped = appName.replace(/'/g, "\\'");
    const script = `
      var proc = Application('System Events').processes.byName('${escaped}');
      var menuBar = proc.menuBars[0];
      var items = menuBar.menuBarItems();
      JSON.stringify(items.map(function(i) { return i.title(); }));
    `;
    const raw = await runJxa(script);
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Collect partial accessibility data with a strict timeout.
 * Returns whatever we can get in 3 seconds; doesn't block if the app is unresponsive.
 */
async function getPartialAccessibility(appName: string): Promise<VisionContext['partialAccessibility']> {
  const empty: VisionContext['partialAccessibility'] = {
    available: false,
    menuBarItems: [],
    visibleLabels: [],
    focusedElement: null,
    elementCount: 0,
    rawElements: [],
  };

  if (!appName) return empty;

  try {
    // Race: get interactive elements vs 3-second timeout
    const rawElements = await Promise.race<RawInteractiveElement[]>([
      getInteractiveElements(appName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Accessibility timeout')), PARTIAL_AX_TIMEOUT)
      ),
    ]);

    // Map to PartialAXElement (no position/size — RawInteractiveElement doesn't carry them)
    const partialElements: PartialAXElement[] = rawElements.map((el) => ({
      role: el.role,
      label: el.label,
      value: el.value || undefined,
    }));

    // Extract visible labels (all non-empty)
    const visibleLabels = rawElements
      .map((el) => el.label)
      .filter((label) => label && label.trim().length > 0);

    // Find focused element
    const focusedRaw = rawElements.find((el) => el.focused);
    const focusedElement = focusedRaw
      ? { role: focusedRaw.role, label: focusedRaw.label, value: focusedRaw.value }
      : null;

    // Get menu bar items separately (almost always works even when tree is poor)
    const menuBarItems = await getMenuBarItems(appName);

    log(`[${timestamp()}] [context-collector] AX: ${rawElements.length} elements, ${menuBarItems.length} menu items`);

    return {
      available: true,
      menuBarItems,
      visibleLabels,
      focusedElement,
      elementCount: rawElements.length,
      rawElements: partialElements,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('timeout')) {
      logError(`[${timestamp()}] [context-collector] Partial AX failed: ${message}`);
    } else {
      log(`[${timestamp()}] [context-collector] AX timed out after ${PARTIAL_AX_TIMEOUT}ms — continuing without AX data`);
    }

    // Still try to get menu bar items even if full AX failed
    const menuBarItems = await getMenuBarItems(appName).catch(() => []);
    return { ...empty, menuBarItems };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Collect the full hybrid vision context for a given app.
 *
 * @param appName     - Target app (optional; uses frontmost app if omitted)
 * @param taskContext - What we're trying to accomplish (from the cloud's command)
 */
export async function collectVisionContext(
  appName?: string,
  taskContext?: {
    currentStep: string;
    expectedOutcome: string;
    workflowName: string;
  } | null
): Promise<VisionContext> {
  log(`[${timestamp()}] [context-collector] Collecting vision context${appName ? ` for "${appName}"` : ''}`);

  // 1. Screenshot
  const screenshotResult = appName
    ? await captureWindow(appName).catch(() => captureFullScreen())
    : await captureFullScreen();

  log(`[${timestamp()}] [context-collector] Screenshot: ${screenshotResult.width}×${screenshotResult.height} (${screenshotResult.captureType})`);

  // 2. Window metadata — run in parallel where possible
  const [frontmostApp, screenSize] = await Promise.all([
    getFrontmostApp(),
    getScreenSize(),
  ]);

  const resolvedApp = appName || frontmostApp;

  const [windowTitle, windowBounds] = await Promise.all([
    getWindowTitle(resolvedApp),
    getWindowBounds(resolvedApp),
  ]);

  log(`[${timestamp()}] [context-collector] Window: "${windowTitle}" bounds=${JSON.stringify(windowBounds)}`);

  // 3. Partial accessibility (with timeout)
  const partialAccessibility = await getPartialAccessibility(resolvedApp);

  // 4. Recent action history
  const recentActions = getRecentActions(5);

  log(`[${timestamp()}] [context-collector] Context ready: ${partialAccessibility.elementCount} AX elements, ${recentActions.length} recent actions`);

  return {
    screenshot: {
      base64: screenshotResult.base64,
      width: screenshotResult.width,
      height: screenshotResult.height,
      captureType: screenshotResult.captureType,
    },
    windowInfo: {
      frontmostApp,
      windowTitle,
      windowBounds,
      screenSize,
    },
    partialAccessibility,
    recentActions,
    taskContext: taskContext ?? null,
  };
}
