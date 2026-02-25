/**
 * Frame Capture — Screenshot-at-event for the recording session.
 *
 * Reuses captureFullScreen() from the vision layer (already resizes to 1280px).
 * Saves PNG files to the session's frames/ directory.
 * Enforces a 300ms debounce to avoid duplicate frames during rapid events.
 */

import * as fs from 'fs';
import * as path from 'path';
import { captureFullScreen } from '../executor/vision/screenshot';
import { log, error as logError } from '../utils/logger';

const DEBOUNCE_MS = 300;

export class FrameCapture {
  private framesDir: string = '';
  private lastCaptureMs: number = 0;
  private frameCount: number = 0;
  private frameMap: Map<number, string> = new Map();

  init(sessionDir: string): void {
    this.framesDir = path.join(sessionDir, 'frames');
    fs.mkdirSync(this.framesDir, { recursive: true });
    this.lastCaptureMs = 0;
    this.frameCount = 0;
    log(`[frame-capture] Initialized. Frames dir: ${this.framesDir}`);
  }

  /**
   * Capture a frame for the given session-relative timestamp.
   * Returns the relative path (e.g. "frames/frame-0312.png") or null if debounced.
   */
  async captureFrame(relativeMs: number): Promise<string | null> {
    const now = Date.now();
    if (now - this.lastCaptureMs < DEBOUNCE_MS) {
      return null; // too soon after last capture
    }
    this.lastCaptureMs = now;

    try {
      const result = await captureFullScreen();
      const filename = `frame-${String(relativeMs).padStart(6, '0')}.png`;
      const filePath = path.join(this.framesDir, filename);

      // Decode base64 and write PNG
      const buffer = Buffer.from(result.base64, 'base64');
      fs.writeFileSync(filePath, buffer);

      const relativePath = path.join('frames', filename);
      this.frameMap.set(relativeMs, relativePath);
      this.frameCount++;
      log(`[frame-capture] Frame ${this.frameCount}: ${filename} (${result.width}×${result.height})`);

      return relativePath;
    } catch (err) {
      logError(`[frame-capture] Capture failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  getFrameMap(): Map<number, string> {
    return new Map(this.frameMap);
  }

  reset(): void {
    this.framesDir = '';
    this.lastCaptureMs = 0;
    this.frameCount = 0;
    this.frameMap = new Map();
  }
}
