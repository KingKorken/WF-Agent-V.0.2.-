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
 */
export async function typeText(text: string): Promise<VisionActionResult> {
  const preview = text.substring(0, 30) + (text.length > 30 ? '...' : '');
  log(`[${timestamp()}] [vision-actions] Type: "${preview}"`);

  const actionDesc = `type "${preview}"`;
  const ts = new Date().toISOString();

  try {
    // Escape the text for embedding in a JXA string literal
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '');

    const script = `Application('System Events').keystroke("${escaped}");`;
    await runJxa(script);

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Type failed: ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}

/**
 * Press a keyboard shortcut (key combination).
 *
 * Examples:
 *   typeKeyCombo(['cmd', 's'])         → Cmd+S (Save)
 *   typeKeyCombo(['cmd', 'a'])         → Cmd+A (Select All)
 *   typeKeyCombo(['shift', 'tab'])     → Shift+Tab
 *   typeKeyCombo(['tab'])              → Tab
 *   typeKeyCombo(['escape'])           → Escape
 */
export async function typeKeyCombo(keys: string[]): Promise<VisionActionResult> {
  const keyDesc = keys.join('+');
  log(`[${timestamp()}] [vision-actions] Key combo: ${keyDesc}`);

  const actionDesc = `key combo [${keyDesc}]`;
  const ts = new Date().toISOString();

  try {
    const lowerKeys = keys.map((k) => k.toLowerCase());

    // Separate modifiers from the main key
    const modifiers: string[] = [];
    const mainKeys: string[] = [];

    for (const k of lowerKeys) {
      if (MODIFIER_MAP[k]) {
        modifiers.push(MODIFIER_MAP[k]);
      } else {
        mainKeys.push(k);
      }
    }

    const mainKey = mainKeys[0] || '';
    const usingClause =
      modifiers.length > 0
        ? `{ using: [${modifiers.map((m) => `'${m}'`).join(', ')}] }`
        : '';

    let script: string;

    if (!mainKey) {
      // Only modifiers — press each modifier key individually (rare)
      script = `Application('System Events').keyCode(0, ${usingClause});`;
    } else if (KEY_CODES[mainKey] !== undefined) {
      // Special key: use keyCode
      const code = KEY_CODES[mainKey];
      script = usingClause
        ? `Application('System Events').keyCode(${code}, ${usingClause});`
        : `Application('System Events').keyCode(${code});`;
    } else {
      // Printable character: use keystroke
      const escaped = mainKey.replace(/"/g, '\\"');
      script = usingClause
        ? `Application('System Events').keystroke("${escaped}", ${usingClause});`
        : `Application('System Events').keystroke("${escaped}");`;
    }

    await runJxa(script);

    recordAction(actionDesc, 'success');
    return { success: true, action: actionDesc, timestamp: ts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [vision-actions] Key combo failed (${keyDesc}): ${message}`);
    recordAction(actionDesc, message);
    return { success: false, action: actionDesc, timestamp: ts, error: message };
  }
}
