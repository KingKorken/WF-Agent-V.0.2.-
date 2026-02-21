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
 * Requirements:
 *   - macOS only
 *   - The app (Terminal / Electron) needs Accessibility permissions in
 *     System Settings → Privacy & Security → Accessibility
 */

import { execFile } from 'child_process';
import { writeFileSync } from 'fs';
import { log, error as logError } from '../../utils/logger';

/** Timeout for JXA script execution (15 seconds) */
const JXA_TIMEOUT_MS = 15_000;

/** Temp file path for JXA scripts — avoids all shell escaping issues */
const TEMP_SCRIPT_PATH = '/tmp/wf-agent-ax-script.js';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A node in the accessibility tree */
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
  /** Path to reach this element from the app (used for performing actions) */
  elementPath: string[];
  /** Child elements in the tree */
  children: AXNode[];
}

/** Raw element data returned from JXA scripts (before ID assignment) */
export interface RawAXElement {
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  elementPath: string[];
  children: RawAXElement[];
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
  return new Promise((resolve, reject) => {
    log(`[${timestamp()}] [macos-ax] Writing JXA script (${script.length} chars) to ${TEMP_SCRIPT_PATH}`);

    // Write script to temp file — no shell escaping needed
    try {
      writeFileSync(TEMP_SCRIPT_PATH, script, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reject(new Error(`Failed to write JXA temp script: ${msg}`));
      return;
    }

    execFile(
      'osascript',
      ['-l', 'JavaScript', TEMP_SCRIPT_PATH],
      { timeout: JXA_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
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
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Accessibility Tree Reader
// ---------------------------------------------------------------------------

/**
 * Get the accessibility tree of a running application.
 *
 * Uses System Events to walk the UI element hierarchy of the target app.
 * Returns raw tree data (without assigned IDs — those are added by ax-tree.ts).
 *
 * @param appName - The application name (e.g. "TextEdit", "Microsoft Excel")
 * @param maxDepth - Maximum depth to traverse (default 3 to avoid huge trees)
 * @returns Array of raw accessibility tree nodes (one per window)
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
    try { enabled = el.enabled(); } catch(e) {}

    var focused = false;
    try { focused = el.focused(); } catch(e) {}

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

  log(`[${timestamp()}] [macos-ax] getAppAccessibilityTree script written, executing...`);
  const output = await runJxa(script);

  try {
    const result = JSON.parse(output);
    if (result.error) {
      throw new Error(result.error);
    }
    log(`[${timestamp()}] [macos-ax] Tree: ${result.windowCount} windows`);
    return result.windows || [];
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse accessibility tree output: ${output.substring(0, 200)}`);
    }
    throw err;
  }
}

/**
 * Get a flat list of all interactive elements from an application.
 * This is the raw version — ax-tree.ts wraps this with ref ID assignment.
 *
 * Proven pattern: proc.windows() → win.uiElements() → recurse
 *
 * @param appName - The application name
 * @returns Array of interactive elements with their paths
 */
export async function getInteractiveElements(appName: string): Promise<RawAXElement[]> {
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
    "AXMenuItem", "AXMenuBarItem", "AXLink", "AXIncrementor",
    "AXDisclosureTriangle", "AXTab", "AXTabGroup",
    "AXCell", "AXColorWell", "AXDateField", "AXList",
    "AXTable", "AXSheet", "AXToolbar"
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

  function scanElement(el, path, depth) {
    if (elements.length >= MAX_ELEMENTS || depth > 6) return;

    var role = "";
    try { role = el.role(); } catch(e) { return; }

    if (INTERACTIVE_ROLES.indexOf(role) !== -1) {
      var label = getLabel(el);
      var value = "";
      try {
        var v = el.value();
        if (v !== null && v !== undefined && v !== "null") value = String(v);
      } catch(e) {}
      var enabled = true;
      try { enabled = el.enabled(); } catch(e) {}
      var focused = false;
      try { focused = el.focused(); } catch(e) {}

      elements.push({
        role: role,
        label: label.substring(0, 100),
        value: value.substring(0, 100),
        enabled: enabled,
        focused: focused,
        elementPath: path,
        children: []
      });
    }

    // Recurse into children
    var kids = [];
    try { kids = el.uiElements(); } catch(e) { return; }
    for (var i = 0; i < kids.length && elements.length < MAX_ELEMENTS; i++) {
      var kidRole = "";
      try { kidRole = kids[i].role(); } catch(e) {}
      var kidLabel = getLabel(kids[i]);
      var seg = kidRole + (kidLabel ? " \\"" + kidLabel + "\\"" : "[" + i + "]");
      scanElement(kids[i], path.concat([seg]), depth + 1);
    }
  }

  // Walk each window's direct uiElements — matches the proven terminal pattern
  for (var w = 0; w < wins.length; w++) {
    var winTitle = "";
    try { winTitle = wins[w].title(); } catch(e) {}
    if (!winTitle || winTitle === "null") winTitle = "Window " + w;
    var winPath = ["window \\"" + winTitle + "\\""];

    var winElems = [];
    try { winElems = wins[w].uiElements(); } catch(e) { continue; }

    for (var i = 0; i < winElems.length; i++) {
      var elRole = "";
      try { elRole = winElems[i].role(); } catch(e) {}
      var elLabel = getLabel(winElems[i]);
      var seg = elRole + (elLabel ? " \\"" + elLabel + "\\"" : "[" + i + "]");
      scanElement(winElems[i], winPath.concat([seg]), 1);
    }
  }

  return JSON.stringify({ elements: elements, windowCount: wins.length, elementCount: elements.length });
})()
`;

  log(`[${timestamp()}] [macos-ax] getInteractiveElements script written, executing...`);
  const output = await runJxa(script);

  try {
    const result = JSON.parse(output);
    if (result.error) {
      throw new Error(result.error);
    }
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
// Element Actions
// ---------------------------------------------------------------------------

/**
 * Perform an action on an element located by its path through the accessibility tree.
 *
 * @param appName - The application name
 * @param elementPath - Path to the element (e.g. ['window "Untitled"', 'AXButton "Bold"'])
 * @param action - The accessibility action to perform (e.g. "AXPress", "AXConfirm", "AXRaise")
 * @returns true if the action was performed
 */
export async function performAction(appName: string, elementPath: string[], action: string): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Performing ${action} on ${appName}: ${elementPath.join(' → ')}`);

  const pathCode = buildPathCode(elementPath);

  const script = `
(function() {
  var se = Application("System Events");
  var proc = se.processes.byName("${escapeJsString(appName)}");
  try {
    var el = ${pathCode};
    el.actions.byName("${escapeJsString(action)}").perform();
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

/**
 * Click (press) an element by its path.
 *
 * @param appName - The application name
 * @param elementPath - Path to the element
 */
export async function clickElementByPath(appName: string, elementPath: string[]): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Clicking element in ${appName}: ${elementPath.join(' → ')}`);

  const pathCode = buildPathCode(elementPath);

  const script = `
(function() {
  var se = Application("System Events");
  var proc = se.processes.byName("${escapeJsString(appName)}");
  try {
    var el = ${pathCode};
    try {
      el.click();
      return "ok";
    } catch(e1) {
      try {
        el.actions.byName("AXPress").perform();
        return "ok";
      } catch(e2) {
        return "error: click failed - " + e1.message + " / AXPress failed - " + e2.message;
      }
    }
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

/**
 * Set the value of an element (text field, cell, etc.) by its path.
 *
 * @param appName - The application name
 * @param elementPath - Path to the element
 * @param value - The value to set
 */
export async function setElementValueByPath(appName: string, elementPath: string[], value: string): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Setting value in ${appName}: ${elementPath.join(' → ')} = "${value.substring(0, 50)}"`);

  const pathCode = buildPathCode(elementPath);

  const script = `
(function() {
  var se = Application("System Events");
  var proc = se.processes.byName("${escapeJsString(appName)}");
  try {
    var el = ${pathCode};
    try {
      el.value = "${escapeJsString(value)}";
      return "ok";
    } catch(e1) {
      try { el.focused = true; } catch(e2) {}
      return "ok_focused";
    }
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

/**
 * Read a specific attribute of an element.
 *
 * @param appName - The application name
 * @param elementPath - Path to the element
 * @param attribute - Attribute name (e.g. "value", "title", "role", "enabled")
 */
export async function getElementAttribute(appName: string, elementPath: string[], attribute: string): Promise<string> {
  log(`[${timestamp()}] [macos-ax] Getting attribute "${attribute}" from ${appName}: ${elementPath.join(' → ')}`);

  const pathCode = buildPathCode(elementPath);

  const script = `
(function() {
  var se = Application("System Events");
  var proc = se.processes.byName("${escapeJsString(appName)}");
  try {
    var el = ${pathCode};
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
 * Set focus to an element by its path.
 */
export async function focusElementByPath(appName: string, elementPath: string[]): Promise<boolean> {
  log(`[${timestamp()}] [macos-ax] Focusing element in ${appName}: ${elementPath.join(' → ')}`);

  const pathCode = buildPathCode(elementPath);

  const script = `
(function() {
  var se = Application("System Events");
  var proc = se.processes.byName("${escapeJsString(appName)}");
  try {
    var el = ${pathCode};
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

/**
 * Click through a menu path in an application.
 * E.g., ["File", "Save As..."] clicks File menu then Save As... item.
 *
 * @param appName - The application name
 * @param menuPath - Array of menu item labels (e.g. ["File", "Save"])
 */
export async function clickMenuPath(appName: string, menuPath: string[]): Promise<boolean> {
  if (menuPath.length === 0) {
    throw new Error('Menu path cannot be empty');
  }

  log(`[${timestamp()}] [macos-ax] Clicking menu in ${appName}: ${menuPath.join(' → ')}`);

  // Build JXA code to navigate through the menu hierarchy
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
  if (output.startsWith('error:')) {
    throw new Error(output.substring(7).trim());
  }
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
  if (output.startsWith('error:')) {
    throw new Error(output.substring(7).trim());
  }
  return true;
}

/**
 * Get information about an application's windows.
 *
 * @param appName - The application name
 * @returns Array of window info objects
 */
export async function getWindowInfo(appName: string): Promise<Array<{ title: string; position: string; size: string }>> {
  log(`[${timestamp()}] [macos-ax] Getting window info for: ${appName}`);

  const script = `
(function() {
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
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion as a JavaScript string literal.
 * Used when embedding values directly in JXA scripts written to a file.
 * No shell escaping needed since the script is passed via a temp file.
 */
function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Build JXA code to navigate to an element via its path.
 *
 * Path entries look like:
 *   'window "Untitled"'     → proc.windows.byName('Untitled')
 *   'AXButton "Bold"'       → .buttons.byName('Bold')
 *   'AXTextField[2]'        → .textFields[2]
 */
function buildPathCode(elementPath: string[]): string {
  let code = 'proc';

  for (const segment of elementPath) {
    // Parse: role "label"
    const quoteMatch = segment.match(/^(\S+)\s+"(.+)"$/);
    // Parse: role[index]
    const bracketMatch = segment.match(/^(\S+)\[(\d+)\]$/);
    // Parse: window "name"
    const windowMatch = segment.match(/^window\s+"(.+)"$/);

    if (windowMatch) {
      code += `.windows.byName("${escapeJsString(windowMatch[1])}")`;
    } else if (quoteMatch) {
      const [, role, label] = quoteMatch;
      const accessor = roleToAccessor(role);
      code += `.${accessor}.byName("${escapeJsString(label)}")`;
    } else if (bracketMatch) {
      const [, role, index] = bracketMatch;
      const accessor = roleToAccessor(role);
      code += `.${accessor}[${index}]`;
    } else if (segment === 'window') {
      code += '.windows[0]';
    } else {
      code += `.uiElements.byName("${escapeJsString(segment)}")`;
    }
  }

  return code;
}

/**
 * Map an AX role to the JXA accessor name.
 * E.g., "AXButton" → "buttons", "AXTextField" → "textFields"
 */
function roleToAccessor(role: string): string {
  const map: Record<string, string> = {
    'AXWindow': 'windows',
    'AXButton': 'buttons',
    'AXTextField': 'textFields',
    'AXTextArea': 'textAreas',
    'AXCheckBox': 'checkboxes',
    'AXRadioButton': 'radioButtons',
    'AXPopUpButton': 'popUpButtons',
    'AXComboBox': 'comboBoxes',
    'AXSlider': 'sliders',
    'AXMenuItem': 'menuItems',
    'AXMenuBarItem': 'menuBarItems',
    'AXMenu': 'menus',
    'AXMenuBar': 'menuBars',
    'AXToolbar': 'toolbars',
    'AXGroup': 'groups',
    'AXScrollArea': 'scrollAreas',
    'AXTable': 'tables',
    'AXRow': 'rows',
    'AXColumn': 'columns',
    'AXCell': 'cells',
    'AXStaticText': 'staticTexts',
    'AXImage': 'images',
    'AXLink': 'links',
    'AXList': 'lists',
    'AXTabGroup': 'tabGroups',
    'AXTab': 'tabs',
    'AXSheet': 'sheets',
    'AXSplitGroup': 'splitGroups',
    'AXSplitter': 'splitters',
    'AXDisclosureTriangle': 'disclosureTriangles',
    'AXIncrementor': 'incrementors',
    'AXColorWell': 'colorWells',
    'AXOutline': 'outlines',
    'AXBrowser': 'browsers',
    'window': 'windows',
  };

  return map[role] || 'uiElements';
}
