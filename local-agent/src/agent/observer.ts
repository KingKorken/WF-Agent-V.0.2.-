/**
 * Observer — Gather the richest possible screen state for the agent loop.
 *
 * Combines data from multiple layers into one Observation struct:
 *   - Screenshot (Layer 5 vision)
 *   - Window metadata + menu bar + recent actions (Layer 5 collect_context)
 *   - Browser element refs (Layer 3 CDP snapshot) — when browser is active
 *   - Desktop element refs (Layer 4 Accessibility snapshot) — when AX is available
 *
 * The observer never throws. Every step is wrapped in try-catch and the
 * function always returns at minimum a screenshot + basic window info.
 */

import { AgentCommand, AgentResult } from '@workflow-agent/shared';
import { log, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function that sends a command to the Local Agent and waits for the response */
type SendAndWait = (command: AgentCommand) => Promise<AgentResult>;

/** Browser element from a CDP snapshot */
interface BrowserElement {
  ref: string;       // e.g. "e1", "e2"
  role: string;      // "button", "input", "link", etc.
  label: string;
  value: string;
  tagName: string;
  enabled: boolean;
  visible: boolean;
}

/** Desktop app element from an Accessibility snapshot */
interface DesktopElement {
  ref: string;       // e.g. "ax_1", "ax_2"
  role: string;      // "AXButton", "AXTextField", etc.
  label: string;
  value: string;
  enabled: boolean;
}

/** Complete observation returned to the agent loop each step */
export interface Observation {
  /** Base64 PNG screenshot */
  screenshot: string;
  /** Screenshot pixel dimensions */
  screenshotSize: { width: number; height: number };
  /** Frontmost application name */
  frontmostApp: string;
  /** Window title of the frontmost app */
  windowTitle: string;
  /** Browser elements (null if browser layer not active) */
  browserElements: BrowserElement[] | null;
  /** Browser page metadata (null if browser layer not active) */
  browserPage: { url: string; title: string } | null;
  /** Desktop app elements (null if no AX data available) */
  desktopElements: DesktopElement[] | null;
  /** Menu bar item labels */
  menuBarItems: string[];
  /** Last few actions taken (from Layer 5 action history) */
  recentActions: Array<{ action: string; result: string; timestamp: string }>;
  /** Which element data source is available */
  availableLayer: 'cdp' | 'accessibility' | 'vision-only';
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let obsCounter = 0;
function nextObsId(): string {
  obsCounter++;
  return `obs_${obsCounter}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Options for controlling observation behavior */
export interface ObserveOptions {
  /** Apps where AX snapshot is known to fail — skip AX for these */
  axFailedApps?: Set<string>;
  /** If provided and the last action definitively failed pre-execution, reuse this observation's screenshot */
  previousObservation?: Observation;
  /** Whether the last action was a definitive pre-execution failure (safe to reuse screenshot) */
  reuseScreenshot?: boolean;
}

/**
 * Gather the full observation for one agent loop step.
 *
 * @param sendAndWait     - Async function to send a command and await its result
 * @param isBrowserActive - Whether the CDP browser layer is currently open
 * @param options         - Optional: AX failure tracking and screenshot reuse
 */
export async function observe(
  sendAndWait: SendAndWait,
  isBrowserActive: boolean,
  options?: ObserveOptions,
): Promise<Observation> {
  log('[observer] Collecting observation...');

  // Defaults used if steps fail
  let screenshot = '';
  let screenshotSize = { width: 0, height: 0 };
  let frontmostApp = 'Unknown';
  let windowTitle = '';
  let menuBarItems: string[] = [];
  let recentActions: Observation['recentActions'] = [];
  let browserElements: BrowserElement[] | null = null;
  let browserPage: Observation['browserPage'] = null;
  let desktopElements: DesktopElement[] | null = null;
  let availableLayer: Observation['availableLayer'] = 'vision-only';

  // --- Step 1: Screenshot ---------------------------------------------------
  // Reuse previous screenshot if last action was a definitive pre-execution failure
  if (options?.reuseScreenshot && options?.previousObservation) {
    screenshot = options.previousObservation.screenshot;
    screenshotSize = options.previousObservation.screenshotSize;
    log(`[observer] Reusing previous screenshot (last action failed pre-execution)`);
  } else {
    try {
      const result = await sendAndWait({
        type: 'command',
        id: nextObsId(),
        layer: 'vision',
        action: 'screenshot',
        params: {},
      });
      if (result.status === 'success' && result.data.base64) {
        const raw = result.data.base64 as string;
        screenshotSize = {
          width: (result.data.width as number) || 0,
          height: (result.data.height as number) || 0,
        };

        // Validate screenshot — reject empty or too-small images
        const MIN_SCREENSHOT_BYTES = 1000;
        if (raw.length >= MIN_SCREENSHOT_BYTES) {
          screenshot = raw;
          log(`[observer] Screenshot: ${screenshotSize.width}×${screenshotSize.height}`);
        } else {
          log(`[observer] WARNING: Screenshot is empty or too small (${raw.length} bytes), skipping image`);
        }
      }
    } catch (err) {
      logError(`[observer] Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Step 2: Window metadata via collect_context (lightweight — no screenshot, no AX) ---
  try {
    const result = await sendAndWait({
      type: 'command',
      id: nextObsId(),
      layer: 'vision',
      action: 'collect_context',
      params: { metadataOnly: true },
    });
    if (result.status === 'success' && result.data) {
      const d = result.data;

      // Top-level fields
      if (d.frontmostApp) frontmostApp = d.frontmostApp as string;
      if (d.windowTitle) windowTitle = d.windowTitle as string;

      // windowInfo sub-object
      const wi = d.windowInfo as Record<string, unknown> | undefined;
      if (wi) {
        if (wi.frontmostApp) frontmostApp = wi.frontmostApp as string;
        if (wi.windowTitle) windowTitle = wi.windowTitle as string;
      }

      // partialAccessibility sub-object
      const pa = d.partialAccessibility as Record<string, unknown> | undefined;
      if (pa && Array.isArray(pa.menuBarItems)) {
        menuBarItems = pa.menuBarItems as string[];
      }

      // recentActions
      if (Array.isArray(d.recentActions)) {
        recentActions = d.recentActions as Observation['recentActions'];
      }

      log(`[observer] Context: app="${frontmostApp}", title="${windowTitle}", menu=${menuBarItems.length} items`);
    }
  } catch (err) {
    logError(`[observer] Context collection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Step 3: Structured element data -------------------------------------
  if (isBrowserActive) {
    // Try CDP snapshot
    try {
      const snapResult = await sendAndWait({
        type: 'command',
        id: nextObsId(),
        layer: 'cdp',
        action: 'snapshot',
        params: {},
      });
      if (snapResult.status === 'success' && Array.isArray(snapResult.data.elements)) {
        browserElements = (snapResult.data.elements as Array<Record<string, unknown>>).map((el) => ({
          ref: String(el.ref || ''),
          role: String(el.role || ''),
          label: String(el.label || ''),
          value: String(el.value || ''),
          tagName: String(el.tagName || ''),
          enabled: el.enabled !== false,
          visible: el.visible !== false,
        }));
        availableLayer = 'cdp';
        log(`[observer] CDP snapshot: ${browserElements.length} elements`);
      }
    } catch (err) {
      logError(`[observer] CDP snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Try page_info
    if (browserElements !== null) {
      try {
        const infoResult = await sendAndWait({
          type: 'command',
          id: nextObsId(),
          layer: 'cdp',
          action: 'page_info',
          params: {},
        });
        if (infoResult.status === 'success') {
          browserPage = {
            url: String(infoResult.data.url || ''),
            title: String(infoResult.data.title || ''),
          };
        }
      } catch {
        // page_info is optional
      }
    }
  }

  // Try accessibility snapshot if no browser elements (skip for known-failing apps)
  const axFailed = options?.axFailedApps;
  if (browserElements === null && frontmostApp) {
    if (axFailed?.has(frontmostApp)) {
      log(`[observer] Skipping AX snapshot for "${frontmostApp}" (previously failed)`);
    } else {
      try {
        const axResult = await sendAndWait({
          type: 'command',
          id: nextObsId(),
          layer: 'accessibility',
          action: 'snapshot',
          params: { app: frontmostApp },
        });
        if (axResult.status === 'success' && Array.isArray(axResult.data.elements)) {
          desktopElements = (axResult.data.elements as Array<Record<string, unknown>>).map((el) => ({
            ref: String(el.ref || ''),
            role: String(el.role || ''),
            label: String(el.label || ''),
            value: String(el.value || ''),
            enabled: el.enabled !== false,
          }));
          availableLayer = 'accessibility';
          log(`[observer] AX snapshot: ${desktopElements.length} elements`);
        } else if (axResult.status === 'error') {
          // AX failed — record for future skipping
          axFailed?.add(frontmostApp);
          log(`[observer] AX snapshot failed for "${frontmostApp}" — added to axFailedApps`);
        }
      } catch (err) {
        // AX threw — record for future skipping
        axFailed?.add(frontmostApp);
        logError(`[observer] AX snapshot failed: ${err instanceof Error ? err.message : String(err)} — added to axFailedApps`);
      }
    }
  }

  if (availableLayer === 'vision-only') {
    log('[observer] No element data available — vision-only mode');
  }

  return {
    screenshot,
    screenshotSize,
    frontmostApp,
    windowTitle,
    browserElements,
    browserPage,
    desktopElements,
    menuBarItems,
    recentActions,
    availableLayer,
  };
}
