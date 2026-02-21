/**
 * Element Snapshot — Scans the page for interactive elements and assigns reference IDs.
 *
 * This is the KEY module that replaces pixel-based clicking with element references.
 * When the cloud says "click e7", we look up what e7 maps to and click it via Playwright.
 *
 * How it works:
 *   1. Run a DOM query inside the page to find all interactive elements
 *   2. Assign each a sequential reference ID: e1, e2, e3, ...
 *   3. Store a mapping from ref → CSS selector so we can find them again
 *   4. Return the structured snapshot to the caller
 *
 * The mapping resets every time getSnapshot() is called.
 */

import { Page, Locator } from 'playwright';
import { getActivePage } from './browser-manager';
import { log, error as logError } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** One element in the snapshot */
export interface SnapshotElement {
  ref: string;          // e.g. "e1", "e2"
  role: string;         // "button", "input", "link", "select", etc.
  label: string;        // Human-readable label
  value: string;        // Current value (for inputs/selects)
  tagName: string;      // HTML tag name
  enabled: boolean;     // Whether the element is enabled
  visible: boolean;     // Whether the element is on screen
}

/** The full snapshot result */
export interface SnapshotResult {
  success: boolean;
  error?: string;
  pageUrl?: string;
  pageTitle?: string;
  elements?: SnapshotElement[];
}

/**
 * Internal mapping from reference ID to a CSS selector string.
 * This persists until the next getSnapshot() call resets it.
 */
let refToSelector: Map<string, string> = new Map();

/**
 * Internal reference to the page used for the current snapshot,
 * so browser-actions can verify it's still the same page.
 */
let snapshotPage: Page | null = null;

/**
 * Scan the current page and return a structured list of interactive elements.
 * Each element gets a sequential reference ID (e1, e2, ...).
 *
 * @param interactive - If true, only return visible+enabled elements (default: true)
 */
export async function getSnapshot(interactive: boolean = true): Promise<SnapshotResult> {
  const page = await getActivePage();
  if (!page) return { success: false, error: 'No browser running. Launch the browser first.' };

  try {
    log(`[${timestamp()}] [element-snapshot] Taking snapshot (interactive=${interactive})`);

    // Reset the mapping for this new snapshot
    refToSelector = new Map();
    snapshotPage = page;

    const pageUrl = page.url();
    let pageTitle = '';
    try { pageTitle = await page.title(); } catch { /* ignore */ }

    // Query the DOM for all interactive elements and extract their properties.
    // This runs inside the browser's JavaScript context.
    const rawElements = await page.evaluate((interactiveOnly: boolean) => {
      const SELECTORS = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="switch"]',
        '[role="option"]',
        '[contenteditable="true"]',
      ];

      const seen = new Set<Element>();
      const results: Array<{
        index: number;
        role: string;
        label: string;
        value: string;
        tagName: string;
        enabled: boolean;
        visible: boolean;
        selector: string;
      }> = [];

      let index = 0;

      for (const sel of SELECTORS) {
        const nodes = document.querySelectorAll(sel);
        for (const el of Array.from(nodes)) {
          if (seen.has(el)) continue;
          seen.add(el);

          // Check visibility
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const isVisible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';

          // Check enabled state
          const isEnabled = !(el as HTMLInputElement).disabled;

          // Skip hidden/disabled elements if we only want interactive ones
          if (interactiveOnly && (!isVisible || !isEnabled)) continue;

          // Determine the role
          const tag = el.tagName.toLowerCase();
          const ariaRole = el.getAttribute('role');
          let role = ariaRole || tag;
          if (tag === 'input') {
            const inputType = (el as HTMLInputElement).type || 'text';
            role = inputType === 'submit' || inputType === 'button' ? 'button' : `input[${inputType}]`;
          }
          if (tag === 'a') role = 'link';
          if (tag === 'select') role = 'select';
          if (tag === 'textarea') role = 'textarea';

          // Get the label — try multiple sources
          const ariaLabel = el.getAttribute('aria-label') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const title = el.getAttribute('title') || '';
          const innerText = (el.textContent || '').trim().substring(0, 80);
          // Check for an associated <label> element
          const id = el.getAttribute('id');
          const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
          const labelText = labelEl ? (labelEl.textContent || '').trim() : '';
          // Pick the best label
          const label = ariaLabel || labelText || placeholder || title || innerText || '';

          // Get the current value
          let value = '';
          if (tag === 'input' || tag === 'textarea') {
            value = (el as HTMLInputElement).value || '';
          } else if (tag === 'select') {
            const selectEl = el as HTMLSelectElement;
            value = selectEl.options[selectEl.selectedIndex]?.text || '';
          }

          // Build a unique CSS selector for this element so we can find it again.
          // Prefer data-testid or id; fall back to nth-of-type.
          let selector = '';
          const testId = el.getAttribute('data-testid');
          if (testId) {
            selector = `[data-testid="${testId}"]`;
          } else if (id) {
            selector = `#${CSS.escape(id)}`;
          } else {
            // Use a positional selector: tag + nth-of-type
            const parent = el.parentElement;
            if (parent) {
              const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}`));
              const nth = siblings.indexOf(el) + 1;
              // Build a path from the parent too for specificity
              const parentId = parent.getAttribute('id');
              if (parentId) {
                selector = `#${CSS.escape(parentId)} > ${tag}:nth-of-type(${nth})`;
              } else {
                // Fall back to a full path using the element index in the document
                selector = `${tag}:nth-of-type(${nth})`;
                // Make it more specific with aria-label or text content
                if (ariaLabel) {
                  selector = `${tag}[aria-label="${ariaLabel}"]`;
                } else if (placeholder) {
                  selector = `${tag}[placeholder="${placeholder}"]`;
                } else if (id === null && el.className) {
                  const firstClass = (el.className as string).split?.(' ')?.[0];
                  if (firstClass) {
                    selector = `${tag}.${CSS.escape(firstClass)}:nth-of-type(${nth})`;
                  }
                }
              }
            }
          }

          results.push({
            index,
            role,
            label: label.substring(0, 100),
            value: value.substring(0, 100),
            tagName: tag,
            enabled: isEnabled,
            visible: isVisible,
            selector,
          });

          index++;
        }
      }

      return results;
    }, interactive);

    // Build the snapshot and ref mapping
    const elements: SnapshotElement[] = rawElements.map((raw, i) => {
      const ref = `e${i + 1}`;
      refToSelector.set(ref, raw.selector);
      return {
        ref,
        role: raw.role,
        label: raw.label,
        value: raw.value,
        tagName: raw.tagName,
        enabled: raw.enabled,
        visible: raw.visible,
      };
    });

    log(`[${timestamp()}] [element-snapshot] Found ${elements.length} elements`);

    return {
      success: true,
      pageUrl,
      pageTitle,
      elements,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [element-snapshot] Snapshot failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Look up the Playwright Locator for a given reference ID.
 * Returns null if the ref is unknown or the page has changed.
 */
export async function getLocatorForRef(ref: string): Promise<{ locator: Locator | null; error?: string }> {
  const page = await getActivePage();
  if (!page) return { locator: null, error: 'No browser running.' };
  if (page !== snapshotPage) {
    return { locator: null, error: 'Page has changed since last snapshot. Take a new snapshot first.' };
  }

  const selector = refToSelector.get(ref);
  if (!selector) {
    return { locator: null, error: `Unknown reference "${ref}". Take a new snapshot to get current elements.` };
  }

  try {
    const locator = page.locator(selector).first();
    // Quick check that the element still exists
    const count = await locator.count();
    if (count === 0) {
      return { locator: null, error: `Element "${ref}" no longer exists on page. Take a new snapshot.` };
    }
    return { locator };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { locator: null, error: `Failed to locate "${ref}": ${message}` };
  }
}

/**
 * Get the current ref-to-selector mapping size (for debugging).
 */
export function getRefCount(): number {
  return refToSelector.size;
}
