/**
 * Accessibility Tree Reader — Higher-level functions for reading app UI state.
 *
 * Wraps the low-level macOS accessibility bridge (macos-ax.ts) with:
 *   - Sequential ref ID assignment (ax_1, ax_2, ...)
 *   - Flat element snapshots for interactive elements
 *   - Element search by role/label
 *   - Persistent ref → { appName, windowIndex, flatIndex } mapping for actions
 *
 * Refs from getElementSnapshot() are ACTIONABLE — they store the flat index
 * from window.entireContents() so ax-actions.ts can re-access the element.
 *
 * Refs from getAppTree() are DISPLAY-ONLY — they are assigned IDs for the
 * tree view but are not stored in the action map.
 *
 * The "ax_" prefix on ref IDs distinguishes them from CDP's "e" prefix,
 * so the cloud can tell which layer an element belongs to.
 */

import { AXNode, RawAXElement, RawInteractiveElement, getAppAccessibilityTree, getInteractiveElements } from './macos-ax';
import { log, error as logError } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An element in the flat snapshot list */
export interface AXSnapshotElement {
  /** Reference ID (e.g. "ax_1", "ax_2") */
  ref: string;
  /** Accessibility role (e.g. "AXButton", "AXTextField") */
  role: string;
  /** Human-readable label/title */
  label: string;
  /** Current value (for text fields, checkboxes, etc.) */
  value: string;
  /** Whether the element is enabled */
  enabled: boolean;
  /** Window index (for informational purposes) */
  windowIndex: number;
  /** Flat index in window.entireContents() — used by actions */
  flatIndex: number;
}

/** Result of getting the full accessibility tree */
export interface AXTreeResult {
  success: boolean;
  error?: string;
  app?: string;
  windows?: AXNode[];
  elementCount?: number;
}

/** Result of getting the element snapshot */
export interface AXSnapshotResult {
  success: boolean;
  error?: string;
  app?: string;
  elements?: AXSnapshotElement[];
  count?: number;
}

/** Result of finding elements by criteria */
export interface AXFindResult {
  success: boolean;
  error?: string;
  elements?: AXSnapshotElement[];
  count?: number;
}

// ---------------------------------------------------------------------------
// Ref ID Mapping (persistent between snapshot and action calls)
// ---------------------------------------------------------------------------

/**
 * Maps ref IDs (e.g. "ax_1") to flat element indices.
 * Reset each time a new snapshot is taken via getElementSnapshot().
 * Refs from getAppTree() are NOT stored here — they are display-only.
 */
let refToFlat: Map<string, { appName: string; windowIndex: number; flatIndex: number }> = new Map();

/** The app name for the current snapshot */
let snapshotAppName: string | null = null;

/**
 * Look up the stored flat index for a given ref ID.
 * Returns null if the ref is unknown or came from getAppTree() (display-only).
 */
export function getPathForRef(ref: string): { appName: string; windowIndex: number; flatIndex: number } | null {
  return refToFlat.get(ref) || null;
}

/**
 * Get the app name from the current snapshot.
 */
export function getSnapshotAppName(): string | null {
  return snapshotAppName;
}

// ---------------------------------------------------------------------------
// Tree Reader (display only — no action mapping)
// ---------------------------------------------------------------------------

/**
 * Get the full accessibility tree of an application.
 * Returns a hierarchical tree with assigned ref IDs for DISPLAY only.
 * These refs are NOT stored in the action map — use getElementSnapshot() for actions.
 *
 * @param appName - The application name (e.g. "TextEdit")
 * @param depth - Maximum tree depth (default 3)
 */
export async function getAppTree(appName: string, depth: number = 3): Promise<AXTreeResult> {
  try {
    log(`[${timestamp()}] [ax-tree] Getting tree for "${appName}" (depth=${depth})`);

    const rawWindows = await getAppAccessibilityTree(appName, depth);

    if (rawWindows.length === 0) {
      return { success: true, app: appName, windows: [], elementCount: 0 };
    }

    // Assign sequential display IDs — NOT stored in action map
    let idCounter = 0;

    function assignIds(raw: RawAXElement): AXNode {
      idCounter++;
      return {
        id: `ax_${idCounter}`,
        role: raw.role,
        label: raw.label,
        value: raw.value,
        enabled: raw.enabled,
        focused: raw.focused,
        elementPath: raw.elementPath,
        children: raw.children.map(assignIds),
      };
    }

    const windows = rawWindows.map(assignIds);

    log(`[${timestamp()}] [ax-tree] Tree has ${idCounter} elements`);

    return {
      success: true,
      app: appName,
      windows,
      elementCount: idCounter,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-tree] Failed to get tree: ${message}`);
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Element Snapshot (interactive elements with actionable refs)
// ---------------------------------------------------------------------------

/**
 * Get a flat list of interactive elements from an application.
 * Each element gets a ref ID (ax_1, ax_2, ...) that can be used in actions.
 * The ref→{windowIndex, flatIndex} mapping is persisted for action use.
 *
 * @param appName - The application name
 */
export async function getElementSnapshot(appName: string): Promise<AXSnapshotResult> {
  try {
    log(`[${timestamp()}] [ax-tree] Getting element snapshot for "${appName}"`);

    const rawElements: RawInteractiveElement[] = await getInteractiveElements(appName);

    // Reset the mapping for this session
    refToFlat = new Map();
    snapshotAppName = appName;

    const elements: AXSnapshotElement[] = rawElements.map((raw, i) => {
      const ref = `ax_${i + 1}`;

      // Store flat index mapping for action use
      refToFlat.set(ref, {
        appName,
        windowIndex: raw.windowIndex,
        flatIndex: raw.flatIndex,
      });

      return {
        ref,
        role: raw.role,
        label: raw.label,
        value: raw.value,
        enabled: raw.enabled,
        windowIndex: raw.windowIndex,
        flatIndex: raw.flatIndex,
      };
    });

    log(`[${timestamp()}] [ax-tree] Found ${elements.length} interactive elements`);

    return {
      success: true,
      app: appName,
      elements,
      count: elements.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-tree] Snapshot failed: ${message}`);
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Element Search
// ---------------------------------------------------------------------------

/**
 * Find elements matching specific criteria.
 * Takes a fresh snapshot and filters by role and/or label.
 *
 * @param appName - The application name
 * @param query - Search criteria (all optional, case-insensitive partial match)
 */
export async function findElement(
  appName: string,
  query: { role?: string; label?: string; value?: string }
): Promise<AXFindResult> {
  try {
    log(`[${timestamp()}] [ax-tree] Finding elements in "${appName}": ${JSON.stringify(query)}`);

    const snapshot = await getElementSnapshot(appName);
    if (!snapshot.success || !snapshot.elements) {
      return { success: false, error: snapshot.error || 'Failed to get snapshot' };
    }

    const matches = snapshot.elements.filter((el) => {
      if (query.role) {
        const queryRole = query.role.toLowerCase();
        const elRole = el.role.toLowerCase();
        if (!elRole.includes(queryRole) && !elRole.replace('ax', '').includes(queryRole)) {
          return false;
        }
      }
      if (query.label) {
        const queryLabel = query.label.toLowerCase();
        const elLabel = el.label.toLowerCase();
        if (!elLabel.includes(queryLabel)) return false;
      }
      if (query.value) {
        const queryValue = query.value.toLowerCase();
        const elValue = el.value.toLowerCase();
        if (!elValue.includes(queryValue)) return false;
      }
      return true;
    });

    log(`[${timestamp()}] [ax-tree] Found ${matches.length} matching elements`);

    return { success: true, elements: matches, count: matches.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-tree] Find failed: ${message}`);
    return { success: false, error: message };
  }
}
