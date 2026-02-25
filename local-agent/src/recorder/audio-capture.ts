/**
 * Audio Capture — Records microphone audio via the native audio-recorder-darwin binary.
 *
 * Spawns audio-recorder-darwin with the output WAV path.
 * Stops by sending SIGTERM.
 * Gracefully handles the case where the binary is missing or mic is denied.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { log, error as logError } from '../utils/logger';

// Compiled JS: local-agent/dist/src/recorder/audio-capture.js
// Binary:      local-agent/bin/audio-recorder-darwin
const BINARY_PATH = path.join(__dirname, '../../../bin/audio-recorder-darwin');

export class AudioCapture {
  private proc: ChildProcess | null = null;
  private outputPath: string = '';
  private started: boolean = false;

  /**
   * Start recording to outputPath.
   * Returns true if recording started successfully, false if unavailable.
   */
  start(outputPath: string): boolean {
    this.outputPath = outputPath;

    if (!fs.existsSync(BINARY_PATH)) {
      logError(`[audio-capture] Binary not found: ${BINARY_PATH}. Recording without audio.`);
      return false;
    }

    try {
      this.proc = spawn(BINARY_PATH, [outputPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.proc.stdout?.setEncoding('utf8');
      this.proc.stdout?.on('data', (data: string) => {
        log(`[audio-capture] ${data.trim()}`);
        if (data.includes('RECORDING_STARTED')) {
          this.started = true;
        }
      });

      this.proc.stderr?.setEncoding('utf8');
      this.proc.stderr?.on('data', (data: string) => {
        logError(`[audio-capture] stderr: ${data.trim()}`);
      });

      this.proc.on('exit', (code) => {
        log(`[audio-capture] Recorder exited (code ${code})`);
      });

      log(`[audio-capture] Started → ${outputPath}`);
      return true;
    } catch (err) {
      logError(`[audio-capture] Failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Stop recording. Returns the output file path if audio was saved.
   */
  stop(): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.proc) {
        resolve(null);
        return;
      }

      const outputPath = this.outputPath;

      this.proc.on('exit', () => {
        // Give the file a moment to flush
        setTimeout(() => {
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            log(`[audio-capture] Saved: ${outputPath}`);
            resolve(outputPath);
          } else {
            log('[audio-capture] No audio file produced');
            resolve(null);
          }
        }, 200);
      });

      try {
        this.proc.kill('SIGTERM');
      } catch (err) {
        logError(`[audio-capture] Kill failed: ${err instanceof Error ? err.message : String(err)}`);
        resolve(null);
      }

      this.proc = null;
    });
  }

  isRecording(): boolean {
    return this.proc !== null && this.started;
  }
}
