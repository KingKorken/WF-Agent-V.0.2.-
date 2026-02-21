/**
 * Accessibility Tree Reader — Higher-level functions for reading app UI state.
 *
 * Wraps the low-level macOS accessibility bridge (macos-ax.ts) with:
 *   - Sequential ref ID assignment (ax_1, ax_2, ...)
 *   - Flat element snapshots for interactive elements
 *   - Element search by role/label
 *   - Persistent ref→elementPath mapping for use in actions
 *
 * The "ax_" prefix on ref IDs distinguishes them from CDP's "e" prefix,
 * so the cloud can tell which layer an element belongs to.
 */

import { AXNode, RawAXElement, getAppAccessibilityTree, getInteractiveElements } from './macos-ax';
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
  /** Path to the element for interaction */
  elementPath: string[];
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
 * Maps ref IDs (e.g. "ax_1") to element paths.
 * Reset each time a new snapshot is taken.
 */
let refToPath: Map<string, { appName: string; elementPath: string[] }> = new Map();

/** The app name for the current snapshot */
let snapshotAppName: string | null = null;

/**
 * Look up the stored element path for a given ref ID.
 * Returns null if the ref is unknown.
 */
export function getPathForRef(ref: string): { appName: string; elementPath: string[] } | null {
  return refToPath.get(ref) || null;
}

/**
 * Get the app name from the current snapshot.
 */
export function getSnapshotAppName(): string | null {
  return snapshotAppName;
}

// ---------------------------------------------------------------------------
// Tree Reader
// ---------------------------------------------------------------------------

/**
 * Get the full accessibility tree of an application.
 * Returns a hierarchical tree with assigned ref IDs.
 *
 * @param appName - The application name (e.g. "TextEdit")
 * @param depth - Maximum tree depth (default 3)
 */
export async function getAppTree(appName: string, depth: number = 3): Promise<AXTreeResult> {
  try {
    log(`[${timestamp()}] [ax-tree] Getting tree for "${appName}" (depth=${depth})`);

    const rawWindows = await getAppAccessibilityTree(appName, depth);

    if (rawWindows.length === 0) {
      return {
        success: true,
        app: appName,
        windows: [],
        elementCount: 0,
      };
    }

    // Assign sequential ref IDs to all nodes
    let refCounter = 0;
    refToPath = new Map();
    snapshotAppName = appName;

    function assignIds(raw: RawAXElement): AXNode {
      refCounter++;
      const ref = `ax_${refCounter}`;

      // Store the mapping for later actions
      refToPath.set(ref, { appName, elementPath: raw.elementPath });

      return {
        id: ref,
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

    log(`[${timestamp()}] [ax-tree] Tree has ${refCounter} elements`);

    return {
      success: true,
      app: appName,
      windows,
      elementCount: refCounter,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-tree] Failed to get tree: ${message}`);
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Element Snapshot
// ---------------------------------------------------------------------------

/**
 * Get a flat list of interactive elements from an application.
 * Similar to the CDP element snapshot but for desktop apps.
 *
 * Each element gets a ref ID (ax_1, ax_2, ...) that can be used
 * in subsequent action commands.
 *
 * @param appName - The application name
 */
export async function getElementSnapshot(appName: string): Promise<AXSnapshotResult> {
  try {
    log(`[${timestamp()}] [ax-tree] Getting element snapshot for "${appName}"`);

    const rawElements = await getInteractiveElements(appName);

    // Reset the mapping
    refToPath = new Map();
    snapshotAppName = appName;

    const elements: AXSnapshotElement[] = rawElements.map((raw, i) => {
      const ref = `ax_${i + 1}`;

      // Store the mapping for later actions
      refToPath.set(ref, { appName, elementPath: raw.elementPath });

      return {
        ref,
        role: raw.role,
        label: raw.label,
        value: raw.value,
        enabled: raw.enabled,
        elementPath: raw.elementPath,
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
 * Searches by role and/or label within the snapshot.
 *
 * @param appName - The application name
 * @param query - Search criteria: role, label, and/or value (all optional, case-insensitive partial match)
 */
export async function findElement(
  appName: string,
  query: { role?: string; label?: string; value?: string }
): Promise<AXFindResult> {
  try {
    log(`[${timestamp()}] [ax-tree] Finding elements in "${appName}": ${JSON.stringify(query)}`);

    // Take a fresh snapshot first
    const snapshot = await getElementSnapshot(appName);
    if (!snapshot.success || !snapshot.elements) {
      return { success: false, error: snapshot.error || 'Failed to get snapshot' };
    }

    // Filter elements matching the query
    const matches = snapshot.elements.filter((el) => {
      if (query.role) {
        const queryRole = query.role.toLowerCase();
        const elRole = el.role.toLowerCase();
        // Match "button" to "AXButton", "cell" to "AXCell", etc.
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

    return {
      success: true,
      elements: matches,
      count: matches.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [ax-tree] Find failed: ${message}`);
    return { success: false, error: message };
  }
}
