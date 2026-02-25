/**
 * macOS Accessibility Bridge — Low-level JXA interface to the macOS Accessibility API.
 *
 * Uses `osascript -l JavaScript` (JXA — JavaScript for Automation) to interact
 * with macOS System Events and read/manipulate the accessibility tree of running apps.
 *
 * JXA scripts are written to a temp file and executed as:
 *   osascript -l JavaScript /tmp/wf-agent-ax-script.js
 *
 * This avoids ALL shell escaping issues that arise when passing complex scripts
 * with single/double quotes via the `-e` flag.
 *
 * Element interaction uses flat indexing via window.entireContents():
 *   - During snapshot: iterate entireContents(), record the flatIndex of each
 *     interactive element so we can find it again reliably.
 *   - During action: re-run entireContents() and access element[flatIndex]
 *     directly — no fragile tree-path navigation.
 *
 * Requirements:
 *   - macOS only
 *   - The app (Terminal / Electron) needs Accessibility permissions in
 *     System Settings → Privacy & Security → Accessibility
 */

import { execFile } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { log, error as logError } from '../../utils/logger';

/** Timeout for JXA script execution (15 seconds) */
const JXA_TIMEOUT_MS = 15_000;

/** Counter for unique JXA temp file names — prevents parallel calls from overwriting each other */
let jxaCallCounter = 0;

function getTempScriptPath(): string {
  jxaCallCounter++;
  return `/tmp/wf-agent-ax-script-${process.pid}-${jxaCallCounter}.js`;
}

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A node in the accessibility tree (for getAppAccessibilityTree display) */
export interface AXNode {
  /** Generated ID (e.g. "ax_1") — assigned by the tree reader, not JXA */
  id: string;
  /** Accessibility role (e.g. "AXButton", "AXTextField", "AXMenuItem") */
  role: string;
  /** Human-readable title/label */
  label: string;
  /** Current value (for text fields, checkboxes, sliders, etc.) */
  value: string;
  /** Whether the element is enabled */
  enabled: boolean;
  /** Whether the element has keyboard focus */
  focused: boolean;
  /** Path to reach this element from the app (used for tree display) */
  elementPath: string[];
  /** Child elements in the tree */
  children: AXNode[];
}

/** Raw element data returned from getAppAccessibilityTree (tree display only) */
export interface RawAXElement {
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  elementPath: string[];
  children: RawAXElement[];
}

/**
 * Raw interactive element returned from getInteractiveElements.
 * Uses flat indexing via window.entireContents() instead of tree paths,
 * so the stored index can be used to re-access the element reliably.
 */
export interface RawInteractiveElement {
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  /** Index of the window (0 = first window) */
  windowIndex: number;
  /** Index of this element in window.entireContents() */
  flatIndex: number;
}

// ---------------------------------------------------------------------------
// JXA Script Runner — temp file approach
// ---------------------------------------------------------------------------

/**
 * Execute a JXA (JavaScript for Automation) script via osascript.
 *
 * Writes the script to a temp file and executes:
 *   osascript -l JavaScript /tmp/wf-agent-ax-script.js
 *
 * This completely avoids shell escaping issues with single/double quotes.
 *
 * @param script - The JavaScript code to execute
 * @returns The script's stdout as a trimmed string
 * @throws Error if the script fails or times out
 */
export function runJxa(script: string): Promise<string> {
  const tempPath = getTempScriptPath();

  return new Promise((resolve, reject) => {
    log(`[${timestamp()}] [macos-ax] Writing JXA script (${script.length} chars) to ${tempPath}`);

    try {
      writeFileSync(tempPath, script, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reject(new Error(`Failed to write JXA temp script: ${msg}`));
      return;
    }

    execFile(
      'osascript',
      ['-l', 'JavaScript', tempPath],
      { timeout: JXA_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          const out = stdout.trim();
          const errText = (stderr || '').trim();

          log(`[${timestamp()}] [macos-ax] JXA stdout (${out.length} chars): ${out.substring(0, 500)}`);
          if (errText) {
            logError(`[${timestamp()}] [macos-ax] JXA stderr: ${errText}`);
          }

          if (error) {
            const errMsg = errText || error.message;
            if (errMsg.includes('not allowed assistive access') || errMsg.includes('assistive')) {
              reject(new Error(
                'Accessibility permission denied. Grant access in System Settings → Privacy & Security → Accessibility.'
              ));
              return;
            }
            if (errMsg.includes("Can't get application process") || errMsg.includes('not running')) {
              reject(new Error('Application not running or not found.'));
              return;
            }
            reject(new Error(`JXA script failed: ${errMsg}`));
            return;
          }

          resolve(out);
        } finally {
          try {
            if (existsSync(tempPath)) unlinkSync(tempPath);
          } catch { /* best-effort cleanup */ }
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Accessibility Tree Reader (for display only)
// ---------------------------------------------------------------------------

/**
 * Get the accessibility tree of a running application.
 * Returns raw tree data for display (without assigned IDs — those are added by ax-tree.ts).
 * Tree nodes use elementPath for display but cannot be actioned; use getInteractiveElements for actions.
 *
 * @param appName - The application name (e.g. "TextEdit", "Microsoft Excel")
 * @param maxDepth - Maximum depth to traverse (default 3 to avoid huge trees)
 */
export async function getAppAccessibilityTree(appName: string, maxDepth: number = 3): Promise<RawAXElement[]> {
  log(`[${timestamp()}] [macos-ax] Getting accessibility tree for "${appName}" (depth=${maxDepth})`);

  const escapedApp = escapeJsString(appName);

  const script = `
(function() {
  // Activate the app first — macOS only exposes the accessibility hierarchy when the app is frontmost
  try { Application("${escapedApp}").activate(); delay(0.3); } catch(e) {}

  var sysEvents = Application("System Events");
  var proc;
  try {
    proc = sysEvents.processes.byName("${escapedApp}");
    proc.name(); // Force resolution — throws if not found
  } catch(e) {
    return JSON.stringify({ error: "App not found: ${escapedApp} - " + e.message });
  }

  var MAX_DEPTH = ${maxDepth};

  function getLabel(el) {
    var label = "";
    try { label = el.title(); } catch(e) {}
    if (!label || label === "null") { try { label = el.description(); } catch(e) {} }
    if (!label || label === "null") { try { label = el.name(); } catch(e) {} }
    return (label && label !== "null") ? String(label) : "";
  }

  function getElementInfo(el, path, depth) {
    var role = "";
    try { role = el.role(); } catch(e) { return null; }

    var label = getLabel(el);
    var value = "";
    try {
      var v = el.value();
      if (v !== null && v !== undefined && v !== "null") value = String(v);
    } catch(e) {}

    var enabled = true;
    try { var en = el.enabled(); enabled = en !== false && en !== null; } catch(e) {}

    var focused = false;
    try { focused = el.focused() === true; } catch(e) {}

    var children = [];
    if (depth < MAX_DEPTH) {
      var kids = [];
      try { kids = el.uiElements(); } catch(e) {}
      for (var i = 0; i < kids.length && i < 100; i++) {
        var kidRole = "";
        try { kidRole = kids[i].role(); } catch(e) {}
        var kidLabel = getLabel(kids[i]);
        var seg = kidRole + (kidLabel ? " \\"" + kidLabel + "\\"" : "[" + i + "]");
        var child = getElementInfo(kids[i], path.concat([seg]), depth + 1);
        if (child) children.push(child);
      }
    }

    return {
      role: role,
      label: label.substring(0, 100),
      value: value.substring(0, 100),
      enabled: enabled,
      focused: focused,
      elementPath: path,
      children: children
    };
  }

  var wins = [];
  try { wins = proc.windows(); } catch(e) {
    return JSON.stringify({ error: "Failed to get windows: " + e.message });
  }

  var windows = [];
  for (var w = 0; w < wins.length; w++) {
    var winTitle = "";
    try { winTitle = wins[w].title(); } catch(e) {}
    if (!winTitle || winTitle === "null") winTitle = "Window " + w;
    var winPath = ["window \\"" + winTitle + "\\""];
    var winInfo = getElementInfo(wins[w], winPath, 0);
    if (winInfo) windows.push(winInfo);
  }

  return JSON.stringify({ windows: windows, windowCount: wins.length });
})()
`;

  log(`[${timestamp()}] [macos-ax] getAppAccessibilityTree executing...`);
  const output = await runJxa(script);

  try {
    const result = JSON.parse(output);
    if (result.error) throw new Error(result.error);
    log(`[${timestamp()}] [macos-ax] Tree: ${result.windowCount} windows`);
    return result.windows || [];
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse accessibility tree output: ${output.substring(0, 200)}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Interactive Element Snapshot (flat indexing via entireContents)
// ---------------------------------------------------------------------------

/**
 * Get a flat list of all interactive elements from an application.
 * Uses window.entireContents() to enumerate ALL elements with a stable flat index.
 * The flatIndex is stored in the ref→mapping so actions can re-access the same element.
 *
 * @param appName - The application name
 */
export async function getInteractiveElements(appName: string): Promise<RawInteractiveElement[]> {
  log(`[${timestamp()}] [macos-ax] Getting interactive elements for: "${appName}"`);

  const escapedApp = escapeJsString(appName);

  const script = `
(function() {
  // Activate the app first — macOS only exposes the accessibility hierarchy when the app is frontmost
  try { Application("${escapedApp}").activate(); delay(0.3); } catch(e) {}

  var sysEvents = Application("System Events");
  var proc;
  try {
    proc = sysEvents.processes.byName("${escapedApp}");
    proc.name(); // Force resolution — throws if not found
  } catch(e) {
    return JSON.stringify({ error: "App not found: ${escapedApp} - " + e.message });
  }

  var wins = [];
  try { wins = proc.windows(); } catch(e) {
    return JSON.stringify({ error: "Failed to get windows: " + e.message });
  }

  var INTERACTIVE_ROLES = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider",
    "AXMenuItem", "AXLink", "AXIncrementor",
    "AXDisclosureTriangle", "AXTab", "AXColorWell", "AXDateField"
  ];

  var elements = [];
  var MAX_ELEMENTS = 200;

  function getLabel(el) {
    var label = "";
    try { label = el.title(); } catch(e) {}
    if (!label || label === "null") { try { label = el.description(); } catch(e) {} }
    if (!label || label === "null") { try { label = el.name(); } catch(e) {} }
    return (label && label !== "null") ? String(label) : "";
  }

  for (var w = 0; w < wins.length && elements.length < MAX_ELEMENTS; w++) {
    // Use entireContents() to get a flat list of ALL elements in the window
    var allElems = [];
    try { allElems = wins[w].entireContents(); } catch(e) { continue; }

    for (var i = 0; i < allElems.length && elements.length < MAX_ELEMENTS; i++) {
      var role = "";
      try { role = allElems[i].role(); } catch(e) { continue; }

      if (INTERACTIVE_ROLES.indexOf(role) === -1) continue;

      var label = getLabel(allElems[i]);
      var value = "";
      try {
        var v = allElems[i].value();
        if (v !== null && v !== undefined && v !== "null") value = String(v);
      } catch(e) {}

      var enabled = true;
      try {
        var en = allElems[i].enabled();
        enabled = en !== false && en !== null;
      } catch(e) {}

      var focused = false;
      try { focused = allElems[i].focused() === true; } catch(e) {}

      elements.push({
        role: role,
        label: label.substring(0, 100),
        value: value.substring(0, 100),
        enabled: enabled,
        focused: focused,
        windowIndex: w,
        flatIndex: i
      });
    }
  }

  return JSON.stringify({ elements: elements, windowCount: wins.length, elementCount: elements.length });
})()
`;

  log(`[${timestamp()}] [macos-ax] getInteractiveElements executing...`);
  const output = await runJxa(script);

  try {
    const result = JSON.parse(output);
    if (result.error) throw new Error(result.error);
    log(`[${timestamp()}] [macos-ax] Found ${result.elementCount} interactive elements across ${result.windowCount} windows`);
    return result.elements || [];
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse interactive elements output: ${output.substring(0, 200)}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Element Actions — flat index approach
// ---------------------------------------------------------------------------

/**
 * Click (press) an element using its flat index in window.entireContents().
 * Tries AXPress first, falls back to click(), logs which element was targeted.
 */
export async function clickElementAtIndex(
  appName: string,
  windowIndex: number,
  flatIndex: number
): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Clicking element in "${appName}" window[${windowIndex}] entireContents[${flatIndex}]`);

  const escapedApp = escapeJsString(appName);

  const script = `
(function() {
  try { Application("${escapedApp}").activate(); delay(0.3); } catch(e) {}

  var sysEvents = Application("System Events");
  var proc = sysEvents.processes.byName("${escapedApp}");
  var wins = proc.windows();
  var win = wins[${windowIndex}];
  var allElems = win.entireContents();
  var el = allElems[${flatIndex}];

  var role = "";
  try { role = el.role(); } catch(e) {}
  var label = "";
  try { label = el.title() || el.description() || el.name() || ""; } catch(e) {}

  // Try AXPress first (standard accessibility action)
  try {
    el.actions["AXPress"].perform();
    return JSON.stringify({ ok: true, method: "AXPress", role: role, label: label });
  } catch(e1) {
    // Fall back to click()
    try {
      el.click();
      return JSON.stringify({ ok: true, method: "click", role: role, label: label });
    } catch(e2) {
      return JSON.stringify({ error: "AXPress failed: " + e1.message + " / click failed: " + e2.message, role: role, label: label });
    }
  }
})()
`;

  const output = await runJxa(script);
  try {
    const result = JSON.parse(output);
    log(`[${timestamp()}] [macos-ax] Click result: ${JSON.stringify(result)}`);
    if (result.error) throw new Error(result.error);
    return true;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Click failed (bad output): ${output.substring(0, 200)}`);
    }
    throw err;
  }
}

/**
 * Set the value of an element using its flat index.
 * For text fields/areas tries direct value assignment; falls back to keystroke.
 */
export async function setElementValueAtIndex(
  appName: string,
  windowIndex: number,
  flatIndex: number,
  value: string
): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Setting value in "${appName}" window[${windowIndex}] entireContents[${flatIndex}] = "${value.substring(0, 50)}"`);

  const escapedApp = escapeJsString(appName);
  const escapedValue = escapeJsString(value);

  const script = `
(function() {
  try { Application("${escapedApp}").activate(); delay(0.3); } catch(e) {}

  var sysEvents = Application("System Events");
  var proc = sysEvents.processes.byName("${escapedApp}");
  var wins = proc.windows();
  var win = wins[${windowIndex}];
  var allElems = win.entireContents();
  var el = allElems[${flatIndex}];

  var role = "";
  try { role = el.role(); } catch(e) {}
  var label = "";
  try { label = el.title() || el.description() || el.name() || ""; } catch(e) {}

  // Try direct value assignment first
  try {
    el.value = "${escapedValue}";
    return JSON.stringify({ ok: true, method: "set_value", role: role, label: label });
  } catch(e1) {
    // Fall back: focus element and use keystroke to type text
    try {
      el.focused = true;
      delay(0.1);
      // Select all existing text and replace
      sysEvents.keystroke("a", { using: "command down" });
      delay(0.05);
      sysEvents.keystroke("${escapedValue}");
      return JSON.stringify({ ok: true, method: "keystroke", role: role, label: label });
    } catch(e2) {
      return JSON.stringify({ error: "set_value failed: " + e1.message + " / keystroke failed: " + e2.message, role: role, label: label });
    }
  }
})()
`;

  const output = await runJxa(script);
  try {
    const result = JSON.parse(output);
    log(`[${timestamp()}] [macos-ax] SetValue result: ${JSON.stringify(result)}`);
    if (result.error) throw new Error(result.error);
    return true;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`SetValue failed (bad output): ${output.substring(0, 200)}`);
    }
    throw err;
  }
}

/**
 * Read an attribute of an element using its flat index.
 */
export async function getElementAttributeAtIndex(
  appName: string,
  windowIndex: number,
  flatIndex: number,
  attribute: string
): Promise<string> {
  log(`[${timestamp()}] [macos-ax] Getting "${attribute}" from "${appName}" window[${windowIndex}] entireContents[${flatIndex}]`);

  const escapedApp = escapeJsString(appName);

  const script = `
(function() {
  var sysEvents = Application("System Events");
  var proc = sysEvents.processes.byName("${escapedApp}");
  var wins = proc.windows();
  var win = wins[${windowIndex}];
  var allElems = win.entireContents();
  var el = allElems[${flatIndex}];
  try {
    var val = el.${escapeJsString(attribute)}();
    return (val !== null && val !== undefined) ? String(val) : "";
  } catch(e) {
    return "error: " + e.message;
  }
})()
`;

  const output = await runJxa(script);
  if (output.startsWith('error:')) {
    throw new Error(output.substring(7).trim());
  }
  return output;
}

/**
 * Focus an element using its flat index.
 */
export async function focusElementAtIndex(
  appName: string,
  windowIndex: number,
  flatIndex: number
): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Focusing "${appName}" window[${windowIndex}] entireContents[${flatIndex}]`);

  const escapedApp = escapeJsString(appName);

  const script = `
(function() {
  try { Application("${escapedApp}").activate(); delay(0.1); } catch(e) {}

  var sysEvents = Application("System Events");
  var proc = sysEvents.processes.byName("${escapedApp}");
  var wins = proc.windows();
  var win = wins[${windowIndex}];
  var allElems = win.entireContents();
  var el = allElems[${flatIndex}];
  try {
    el.focused = true;
    return "ok";
  } catch(e) {
    return "error: " + e.message;
  }
})()
`;

  const output = await runJxa(script);
  if (output.startsWith('error:')) {
    throw new Error(output.substring(7).trim());
  }
  return true;
}

// ---------------------------------------------------------------------------
// App-level actions (not element-specific)
// ---------------------------------------------------------------------------

/**
 * Click through a menu path in an application.
 * E.g., ["File", "Save As..."] clicks File menu then Save As... item.
 *
 * @param appName - The application name
 * @param menuPath - Array of menu item labels (e.g. ["File", "Save"])
 */
export async function clickMenuPath(appName: string, menuPath: string[]): Promise<boolean> {
  if (menuPath.length === 0) throw new Error('Menu path cannot be empty');

  log(`[${timestamp()}] [macos-ax] Clicking menu in ${appName}: ${menuPath.join(' → ')}`);

  let menuCode = `proc.menuBars[0].menuBarItems.byName("${escapeJsString(menuPath[0])}")`;
  for (let i = 1; i < menuPath.length; i++) {
    menuCode += `.menus[0].menuItems.byName("${escapeJsString(menuPath[i])}")`;
  }

  const script = `
(function() {
  var se = Application("System Events");
  var proc = se.processes.byName("${escapeJsString(appName)}");
  try {
    Application("${escapeJsString(appName)}").activate();
    delay(0.3);
    ${menuCode}.click();
    return "ok";
  } catch(e) {
    return "error: " + e.message;
  }
})()
`;

  const output = await runJxa(script);
  if (output.startsWith('error:')) throw new Error(output.substring(7).trim());
  return true;
}

/**
 * Activate (bring to front) an application.
 */
export async function activateApp(appName: string): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Activating app: ${appName}`);

  const script = `
(function() {
  try {
    Application("${escapeJsString(appName)}").activate();
    return "ok";
  } catch(e) {
    return "error: " + e.message;
  }
})()
`;

  const output = await runJxa(script);
  if (output.startsWith('error:')) throw new Error(output.substring(7).trim());
  return true;
}

/**
 * Get information about an application's windows.
 */
export async function getWindowInfo(appName: string): Promise<Array<{ title: string; position: string; size: string }>> {
  log(`[${timestamp()}] [macos-ax] Getting window info for: ${appName}`);

  const script = `
(function() {
  try { Application("${escapeJsString(appName)}").activate(); delay(0.2); } catch(e) {}
  var se = Application("System Events");
  var proc = se.processes.byName("${escapeJsString(appName)}");
  var wins = [];
  try { wins = proc.windows(); } catch(e) {
    return JSON.stringify({ error: "Failed to get windows: " + e.message });
  }
  var result = [];
  for (var i = 0; i < wins.length; i++) {
    var title = "";
    var pos = "";
    var sz = "";
    try { title = wins[i].title() || "Window " + i; } catch(e) {}
    try { pos = String(wins[i].position()); } catch(e) {}
    try { sz = String(wins[i].size()); } catch(e) {}
    result.push({ title: title, position: pos, size: sz });
  }
  return JSON.stringify(result);
})()
`;

  const output = await runJxa(script);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Failed to parse window info: ${output.substring(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion as a JavaScript string literal.
 * Used when embedding values directly in JXA scripts written to a file.
 */
function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
