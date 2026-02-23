/**
 * Screenshot — Capture screenshots of the screen, specific windows, or regions.
 *
 * Uses macOS `screencapture` command for reliable screen capture.
 * All temp files are read into base64 and immediately deleted.
 *
 * Functions:
 *   captureFullScreen()           — Entire display
 *   captureWindow(appName)        — Frontmost window of a specific app
 *   captureRegion(x, y, w, h)    — Arbitrary screen region
 */

import { execSync } from 'child_process';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { log, error as logError } from '../../utils/logger';
import { runJxa } from '../accessibility/macos-ax';
import { ScreenshotResult } from '@workflow-agent/shared';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Read PNG image dimensions using macOS `sips` tool.
 * Returns { width, height } or { width: 0, height: 0 } on failure.
 */
function getPngDimensions(imagePath: string): { width: number; height: number } {
  try {
    const output = execSync(`sips -g pixelWidth -g pixelHeight "${imagePath}" 2>/dev/null`, {
      encoding: 'utf8',
    });
    const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
    return {
      width: widthMatch ? parseInt(widthMatch[1], 10) : 0,
      height: heightMatch ? parseInt(heightMatch[1], 10) : 0,
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Read a temp PNG file into base64 and delete it.
 */
function readAndCleanup(imagePath: string): string {
  try {
    const data = readFileSync(imagePath);
    return data.toString('base64');
  } finally {
    try {
      if (existsSync(imagePath)) {
        unlinkSync(imagePath);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Capture the entire screen.
 */
export async function captureFullScreen(): Promise<ScreenshotResult> {
  const ts = Date.now();
  const tmpPath = `/tmp/wf-agent-screenshot-${ts}.png`;
  log(`[${timestamp()}] [screenshot] Capturing full screen → ${tmpPath}`);

  try {
    execSync(`screencapture -x -t png "${tmpPath}"`, { encoding: 'utf8' });

    const { width, height } = getPngDimensions(tmpPath);
    const base64 = readAndCleanup(tmpPath);

    log(`[${timestamp()}] [screenshot] Full screen captured: ${width}×${height} (${Math.round(base64.length / 1024)}KB)`);

    return {
      base64,
      width,
      height,
      captureType: 'fullscreen',
      timestamp: new Date(ts).toISOString(),
    };
  } catch (err) {
    // Clean up in case of failure
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [screenshot] Full screen capture failed: ${message}`);
    throw new Error(`Full screen capture failed: ${message}`);
  }
}

/**
 * Capture only the frontmost window of a specific application.
 * Falls back to full screen if window bounds cannot be obtained.
 */
export async function captureWindow(appName: string): Promise<ScreenshotResult> {
  const ts = Date.now();
  const tmpPath = `/tmp/wf-agent-window-${ts}.png`;
  log(`[${timestamp()}] [screenshot] Capturing window for "${appName}" → ${tmpPath}`);

  try {
    // Get window position and size via JXA
    const boundsScript = `
      var proc = Application('System Events').processes.byName('${appName.replace(/'/g, "\\'")}');
      var win = proc.windows[0];
      var pos = win.position();
      var size = win.size();
      JSON.stringify({ x: pos[0], y: pos[1], width: size[0], height: size[1] });
    `;

    let bounds = { x: 0, y: 0, width: 0, height: 0 };
    try {
      const raw = await runJxa(boundsScript);
      bounds = JSON.parse(raw);
      log(`[${timestamp()}] [screenshot] Window bounds: ${JSON.stringify(bounds)}`);
    } catch (boundsErr) {
      const msg = boundsErr instanceof Error ? boundsErr.message : String(boundsErr);
      logError(`[${timestamp()}] [screenshot] Could not get window bounds for "${appName}": ${msg} — falling back to full screen`);
      return captureFullScreen();
    }

    const { x, y, width, height } = bounds;
    if (!width || !height) {
      logError(`[${timestamp()}] [screenshot] Invalid window bounds for "${appName}" — falling back to full screen`);
      return captureFullScreen();
    }

    execSync(`screencapture -x -t png -R ${x},${y},${width},${height} "${tmpPath}"`, { encoding: 'utf8' });

    const dims = getPngDimensions(tmpPath);
    const base64 = readAndCleanup(tmpPath);

    log(`[${timestamp()}] [screenshot] Window captured: ${dims.width}×${dims.height} (${Math.round(base64.length / 1024)}KB)`);

    return {
      base64,
      width: dims.width || width,
      height: dims.height || height,
      captureType: 'window',
      timestamp: new Date(ts).toISOString(),
    };
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [screenshot] Window capture failed for "${appName}": ${message}`);
    throw new Error(`Window capture failed: ${message}`);
  }
}

/**
 * Capture a specific region of the screen.
 */
export async function captureRegion(
  x: number,
  y: number,
  width: number,
  height: number
): Promise<ScreenshotResult> {
  const ts = Date.now();
  const tmpPath = `/tmp/wf-agent-region-${ts}.png`;
  log(`[${timestamp()}] [screenshot] Capturing region (${x},${y}) ${width}×${height} → ${tmpPath}`);

  try {
    execSync(`screencapture -x -t png -R ${x},${y},${width},${height} "${tmpPath}"`, { encoding: 'utf8' });

    const dims = getPngDimensions(tmpPath);
    const base64 = readAndCleanup(tmpPath);

    log(`[${timestamp()}] [screenshot] Region captured: ${dims.width}×${dims.height} (${Math.round(base64.length / 1024)}KB)`);

    return {
      base64,
      width: dims.width || width,
      height: dims.height || height,
      captureType: 'region',
      timestamp: new Date(ts).toISOString(),
    };
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [screenshot] Region capture failed: ${message}`);
    throw new Error(`Region capture failed: ${message}`);
  }
}
