/**
 * Vision Actions — Coordinate-based mouse and keyboard actions.
 *
 * Performs actions at specific screen coordinates using macOS CoreGraphics
 * events via JXA (JavaScript for Automation). Every action:
 *   1. Executes via runJxa()
 *   2. Optionally takes a verification screenshot
 *   3. Records itself in the action history buffer
 *
 * These are absolute screen coordinates (not window-relative).
 * macOS-only.
 */

import { execFileSync } from 'child_process';
import { log, error as logError } from '../../utils/logger';
import { runJxa } from '../accessibility/macos-ax';
import { captureFullScreen } from './screenshot';
import { recordAction } from './action-history';
import { VisionActionResult } from '@workflow-agent/shared';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Wait for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Coordinate scaling (image space → screen space)
// ---------------------------------------------------------------------------

const IMAGE_WIDTH = 1280; // screenshots are resized to this width

let cachedScreenSize: { width: number; height: number } | null = null;

async function getScreenLogicalSize(): Promise<{ width: number; height: number }> {
  if (cachedScreenSize) return cachedScreenSize;
  const result = await runJxa(`
    ObjC.import('AppKit');
    var screen = $.NSScreen.mainScreen;
    var frame = screen.frame;
    JSON.stringify({ width: frame.size.width, height: frame.size.height });
  `);
  cachedScreenSize = JSON.parse(result);
  return cachedScreenSize!;
}

async function scaleCoords(x: number, y: number): Promise<{ scaledX: number; scaledY: number }> {
  const screenSize = await getScreenLogicalSize();
  const imageHeight = Math.round(screenSize.height * IMAGE_WIDTH / screenSize.width);
  const scaledX = Math.round(x * screenSize.width / IMAGE_WIDTH);
  const scaledY = Math.round(y * screenSize.height / imageHeight);
  return { scaledX, scaledY };
}

/**
 * Modifier key names → JXA "using" string values.
 * System Events accepts these in the `using` array for keystroke().
 */
const MODIFIER_MAP: Record<string, string> = {
  cmd: 'command down',
  command: 'command down',
  opt: 'option down',
  option: 'option down',
  alt: 'option down',
  shift: 'shift down',
  ctrl: 'control down',
  control: 'control down',
};

/**
 * Special key name → JXA keyCode values.
 * Used when the "key" is not a printable character.
 */
const KEY_CODES: Record<string, number> = {
  tab: 48,
  return: 36,
  enter: 36,
  escape: 53,
  esc: 53,
  delete: 51,
  backspace: 51,
  space: 49,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  f1: 122, f2: 120, f3: 99, f4: 118,
  f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

// ---------------------------------------------------------------------------
// Mouse Actions
// ---------------------------------------------------------------------------

/**
 * Click at screen coordinates (x, y).
 * Optionally takes a verification screenshot 500ms after clicking.
 */
export async function clickAt(
  x: number,
  y: number,
  verify: boolean = false
): Promise<VisionActionResult> {
  const { scaledX, scaledY } = await scaleCoords(x, y);
  log(`[${timestamp()}] [vision-actions] Click at (${x}, ${y}) → scaled to (${scaledX}, ${scaledY})${verify ? ' with verify' : ''}`);

  const actionDesc = `click at (${x}, ${y}) → (${scaledX}, ${scaledY})`;
  const ts = new Date().toISOString();

  try {
    const script = `
      ObjC.import('CoreGraphics');
      var pt = $.CGPointMake(${scaledX}, ${scaledY});
      var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
      var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
      $.CGEventPost($.kCGHIDEventTap, down);
      delay(0.05);
      $.CGEventPost($.kCGHIDEventTap, up);
      'ok';
    `;
    await runJxa(script);

    let verificationScreenshot: VisionActionResult['verificationScreenshot'];
    if (verify) {
      await sleep(500);
      try {
        const ss = await captureFullScreen();
        verificationScreenshot = { base64: ss.base64, width: ss.width, height: ss.height };
      } catch {
        // Verification is optional — don't fail the action if screenshot fails
      }
    }

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts, verificationScreenshot };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Click failed at (${x}, ${y}): ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}

/**
 * Double-click at screen coordinates.
 */
export async function doubleClickAt(
  x: number,
  y: number,
  verify: boolean = false
): Promise<VisionActionResult> {
  const { scaledX, scaledY } = await scaleCoords(x, y);
  log(`[${timestamp()}] [vision-actions] Double-click at (${x}, ${y}) → scaled to (${scaledX}, ${scaledY})`);

  const actionDesc = `double-click at (${x}, ${y}) → (${scaledX}, ${scaledY})`;
  const ts = new Date().toISOString();

  try {
    const script = `
      ObjC.import('CoreGraphics');
      var pt = $.CGPointMake(${scaledX}, ${scaledY});
      var down1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
      var up1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
      var down2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
      var up2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(down1, $.kCGMouseEventClickState, 2);
      $.CGEventSetIntegerValueField(up1, $.kCGMouseEventClickState, 2);
      $.CGEventSetIntegerValueField(down2, $.kCGMouseEventClickState, 2);
      $.CGEventSetIntegerValueField(up2, $.kCGMouseEventClickState, 2);
      $.CGEventPost($.kCGHIDEventTap, down1);
      $.CGEventPost($.kCGHIDEventTap, up1);
      delay(0.05);
      $.CGEventPost($.kCGHIDEventTap, down2);
      $.CGEventPost($.kCGHIDEventTap, up2);
      'ok';
    `;
    await runJxa(script);

    let verificationScreenshot: VisionActionResult['verificationScreenshot'];
    if (verify) {
      await sleep(500);
      try {
        const ss = await captureFullScreen();
        verificationScreenshot = { base64: ss.base64, width: ss.width, height: ss.height };
      } catch { /* ignore */ }
    }

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts, verificationScreenshot };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Double-click failed: ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}

/**
 * Right-click at screen coordinates (opens context menu).
 */
export async function rightClickAt(
  x: number,
  y: number,
  verify: boolean = false
): Promise<VisionActionResult> {
  const { scaledX, scaledY } = await scaleCoords(x, y);
  log(`[${timestamp()}] [vision-actions] Right-click at (${x}, ${y}) → scaled to (${scaledX}, ${scaledY})`);

  const actionDesc = `right-click at (${x}, ${y}) → (${scaledX}, ${scaledY})`;
  const ts = new Date().toISOString();

  try {
    const script = `
      ObjC.import('CoreGraphics');
      var pt = $.CGPointMake(${scaledX}, ${scaledY});
      var down = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseDown, pt, $.kCGMouseButtonRight);
      var up = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseUp, pt, $.kCGMouseButtonRight);
      $.CGEventPost($.kCGHIDEventTap, down);
      delay(0.05);
      $.CGEventPost($.kCGHIDEventTap, up);
      'ok';
    `;
    await runJxa(script);

    let verificationScreenshot: VisionActionResult['verificationScreenshot'];
    if (verify) {
      await sleep(500);
      try {
        const ss = await captureFullScreen();
        verificationScreenshot = { base64: ss.base64, width: ss.width, height: ss.height };
      } catch { /* ignore */ }
    }

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts, verificationScreenshot };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Right-click failed: ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}

/**
 * Drag from one screen position to another.
 */
export async function dragFromTo(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Promise<VisionActionResult> {
  const from = await scaleCoords(fromX, fromY);
  const to = await scaleCoords(toX, toY);
  log(`[${timestamp()}] [vision-actions] Drag from (${fromX}, ${fromY}) → (${from.scaledX}, ${from.scaledY}) to (${toX}, ${toY}) → (${to.scaledX}, ${to.scaledY})`);

  const actionDesc = `drag from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
  const ts = new Date().toISOString();

  try {
    const script = `
      ObjC.import('CoreGraphics');
      var from = $.CGPointMake(${from.scaledX}, ${from.scaledY});
      var to = $.CGPointMake(${to.scaledX}, ${to.scaledY});
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, from, $.kCGMouseButtonLeft));
      delay(0.1);
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDragged, to, $.kCGMouseButtonLeft));
      delay(0.05);
      $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, to, $.kCGMouseButtonLeft));
      'ok';
    `;
    await runJxa(script);

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Drag failed: ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}

/**
 * Scroll at a specific screen position.
 */
export async function scrollAt(
  x: number,
  y: number,
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number = 3
): Promise<VisionActionResult> {
  const { scaledX, scaledY } = await scaleCoords(x, y);
  log(`[${timestamp()}] [vision-actions] Scroll ${direction} × ${amount} at (${x}, ${y}) → scaled to (${scaledX}, ${scaledY})`);

  const actionDesc = `scroll ${direction} × ${amount} at (${x}, ${y})`;
  const ts = new Date().toISOString();

  try {
    // Move mouse to the scroll target first
    // Scroll wheel: positive = up/left, negative = down/right
    const verticalDelta = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
    const horizontalDelta = direction === 'left' ? amount : direction === 'right' ? -amount : 0;

    const script = `
      ObjC.import('CoreGraphics');
      var pt = $.CGPointMake(${scaledX}, ${scaledY});
      var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft);
      $.CGEventPost($.kCGHIDEventTap, move);
      delay(0.05);
      var scroll = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, ${verticalDelta}, ${horizontalDelta});
      $.CGEventPost($.kCGHIDEventTap, scroll);
      'ok';
    `;
    await runJxa(script);

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Scroll failed: ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}

// ---------------------------------------------------------------------------
// Keyboard Actions
// ---------------------------------------------------------------------------

/**
 * Type text into the currently focused element.
 * Does NOT click first — call clickAt() to focus the target field.
 *
 * Primary method: pbcopy + CoreGraphics Cmd+V paste.
 * Fallback: System Events keystroke (unreliable from Electron, ~12.5% success rate).
 *
 * Tradeoff: Clipboard is overwritten during execution. No save/restore — the
 * agent controls the machine during execution.
 */
export async function typeText(text: string): Promise<VisionActionResult> {
  const preview = text.substring(0, 30) + (text.length > 30 ? '...' : '');
  log(`[${timestamp()}] [vision-actions] Type: "${preview}"`);

  const actionDesc = `type "${preview}"`;
  const ts = new Date().toISOString();

  // Primary method: clipboard paste (pbcopy + Cmd+V via CoreGraphics)
  try {
    // Write text to clipboard via stdin pipe — no shell interpolation, handles all Unicode
    execFileSync('pbcopy', { input: text, timeout: 3000 });

    // Small delay to let focus settle before pasting
    await sleep(150);

    // Paste via CoreGraphics key event: Cmd+V
    // Virtual key code for V = 9, Command flag = 0x100000
    const pasteScript = `
      ObjC.import('CoreGraphics');
      var src = $.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);
      var vDown = $.CGEventCreateKeyboardEvent(src, 9, true);
      var vUp = $.CGEventCreateKeyboardEvent(src, 9, false);
      $.CGEventSetFlags(vDown, $.kCGEventFlagMaskCommand);
      $.CGEventSetFlags(vUp, $.kCGEventFlagMaskCommand);
      $.CGEventPost($.kCGHIDEventTap, vDown);
      $.CGEventPost($.kCGHIDEventTap, vUp);
      'ok';
    `;
    await runJxa(pasteScript);

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts };
  } catch (err) {
    const clipboardError = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Clipboard paste failed: ${clipboardError}, falling back to System Events`);

    // Fallback: System Events keystroke (unreliable but handles paste-blocked fields)
    try {
      const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');

      const script = `Application('System Events').keystroke("${escaped}");`;
      await runJxa(script);

      recordAction(actionDesc, 'success (fallback)');
      return { success: true, action: actionDesc, timestamp: ts };
    } catch (fallbackErr) {
      const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      logError(`[${timestamp()}] [vision-actions] Type failed (both methods): clipboard: ${clipboardError}, keystroke: ${message}`);
      recordAction(actionDesc, message);
      return { success: false, action: actionDesc, timestamp: ts, error: `Clipboard paste failed: ${clipboardError}. Keystroke fallback also failed: ${message}` };
    }
  }
}

/**
 * CoreGraphics modifier key flags.
 */
const CG_MODIFIER_FLAGS: Record<string, string> = {
  cmd: '$.kCGEventFlagMaskCommand',
  command: '$.kCGEventFlagMaskCommand',
  opt: '$.kCGEventFlagMaskAlternate',
  option: '$.kCGEventFlagMaskAlternate',
  alt: '$.kCGEventFlagMaskAlternate',
  shift: '$.kCGEventFlagMaskShift',
  ctrl: '$.kCGEventFlagMaskControl',
  control: '$.kCGEventFlagMaskControl',
};

/**
 * Printable character → virtual key code (macOS).
 * Only lowercase chars that differ from KEY_CODES.
 */
const CHAR_KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19,
  '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34,
  p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43,
  '/': 44, n: 45, m: 46, '.': 47, '`': 50, ' ': 49,
};

/**
 * Press a keyboard shortcut (key combination) via CoreGraphics.
 *
 * Primary method: CoreGraphics CGEventCreateKeyboardEvent (layout-independent).
 * Fallback: System Events keystroke/keyCode.
 *
 * Examples:
 *   typeKeyCombo(['cmd', 's'])         -> Cmd+S (Save)
 *   typeKeyCombo(['cmd', 'a'])         -> Cmd+A (Select All)
 *   typeKeyCombo(['shift', 'tab'])     -> Shift+Tab
 *   typeKeyCombo(['tab'])              -> Tab
 *   typeKeyCombo(['escape'])           -> Escape
 */
export async function typeKeyCombo(keys: string[]): Promise<VisionActionResult> {
  const keyDesc = keys.join('+');
  log(`[${timestamp()}] [vision-actions] Key combo: ${keyDesc}`);

  const actionDesc = `key combo [${keyDesc}]`;
  const ts = new Date().toISOString();

  try {
    const lowerKeys = keys.map((k) => k.toLowerCase());

    // Separate modifiers from the main key
    const cgModifiers: string[] = [];
    const mainKeys: string[] = [];

    for (const k of lowerKeys) {
      if (CG_MODIFIER_FLAGS[k]) {
        cgModifiers.push(CG_MODIFIER_FLAGS[k]);
      } else {
        mainKeys.push(k);
      }
    }

    const mainKey = mainKeys[0] || '';

    // Resolve to virtual key code
    let keyCode: number | undefined;
    if (KEY_CODES[mainKey] !== undefined) {
      keyCode = KEY_CODES[mainKey];
    } else if (CHAR_KEY_CODES[mainKey] !== undefined) {
      keyCode = CHAR_KEY_CODES[mainKey];
    }

    if (keyCode !== undefined) {
      // CoreGraphics path
      const flagsExpr = cgModifiers.length > 0
        ? cgModifiers.join(' | ')
        : '0';

      const script = `
        ObjC.import('CoreGraphics');
        var src = $.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);
        var keyDown = $.CGEventCreateKeyboardEvent(src, ${keyCode}, true);
        var keyUp = $.CGEventCreateKeyboardEvent(src, ${keyCode}, false);
        ${cgModifiers.length > 0 ? `var flags = ${flagsExpr};
        $.CGEventSetFlags(keyDown, flags);
        $.CGEventSetFlags(keyUp, flags);` : ''}
        $.CGEventPost($.kCGHIDEventTap, keyDown);
        $.CGEventPost($.kCGHIDEventTap, keyUp);
        'ok';
      `;
      await runJxa(script);
    } else {
      // Unknown key — fall back to System Events
      const seModifiers: string[] = [];
      for (const k of lowerKeys) {
        if (MODIFIER_MAP[k]) seModifiers.push(MODIFIER_MAP[k]);
      }
      const usingClause = seModifiers.length > 0
        ? `{ using: [${seModifiers.map((m) => `'${m}'`).join(', ')}] }`
        : '';
      const escaped = mainKey.replace(/"/g, '\\"');
      const script = usingClause
        ? `Application('System Events').keystroke("${escaped}", ${usingClause});`
        : `Application('System Events').keystroke("${escaped}");`;
      await runJxa(script);
    }

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Key combo failed (${keyDesc}): ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}
