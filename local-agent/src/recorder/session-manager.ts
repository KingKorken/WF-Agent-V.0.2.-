/**
 * Session Manager — Orchestrates all recording components.
 *
 * Manages one recording session at a time:
 *   startSession(description) → creates session dir, starts EventLogger + FrameCapture + AudioCapture
 *   stopSession()             → stops all, runs transcription, builds manifest
 *   getStatus()               → returns current SessionState
 *   listSessions()            → returns array of session IDs from recordings dir
 *
 * Sessions are stored at: local-agent/recordings/<session-id>/
 * Session ID format: YYYY-MM-DDTHH-MM-SS-<slug>
 */

import * as fs from 'fs';
import * as path from 'path';
import { log, error as logError } from '../utils/logger';
import { EventLogger, RecordedEvent } from './event-logger';
import { FrameCapture } from './frame-capture';
import { AudioCapture } from './audio-capture';
import { transcribe, TranscriptionSegment } from './transcription';
import { buildManifest } from './manifest-builder';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Compiled JS lives at local-agent/dist/src/recorder/session-manager.js
// Recordings go at local-agent/recordings/ (gitignored)
// __dirname = local-agent/dist/src/recorder  → ../../.. = local-agent/
const RECORDINGS_DIR = path.join(__dirname, '../../../recordings');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionState {
  id: string;
  status: 'idle' | 'recording' | 'processing' | 'complete' | 'error';
  description: string;
  startTime: number;
  dir: string;
  eventCount: number;
  frameCount: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Module state (one session at a time)
// ---------------------------------------------------------------------------

let currentState: SessionState = {
  id: '',
  status: 'idle',
  description: '',
  startTime: 0,
  dir: '',
  eventCount: 0,
  frameCount: 0,
};

let eventLogger: EventLogger | null = null;
let frameCapture: FrameCapture | null = null;
let audioCapture: AudioCapture | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new recording session.
 * Returns the initial SessionState (status: 'recording').
 */
export async function startSession(description: string): Promise<SessionState> {
  if (currentState.status === 'recording') {
    throw new Error('A recording session is already active. Call stopSession() first.');
  }

  // Generate session ID
  const now = new Date();
  const dateStr = now.toISOString().replace(/:/g, '-').replace('T', 'T').split('.')[0]; // YYYY-MM-DDTHH-MM-SS
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 30)
    .replace(/-+$/, ''); // trim trailing dashes
  const sessionId = `${dateStr}-${slug || 'untitled'}`;

  // Create session directory
  const sessionDir = path.join(RECORDINGS_DIR, sessionId);
  const framesDir = path.join(sessionDir, 'frames');
  try {
    fs.mkdirSync(framesDir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create session directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  const startTime = Date.now();

  // Initialize state
  currentState = {
    id: sessionId,
    status: 'recording',
    description,
    startTime,
    dir: sessionDir,
    eventCount: 0,
    frameCount: 0,
  };

  log(`[session-manager] Starting session: ${sessionId}`);
  log(`[session-manager] Session dir: ${sessionDir}`);

  // Start EventLogger
  eventLogger = new EventLogger();
  frameCapture = new FrameCapture();
  audioCapture = new AudioCapture();

  // Init frame capture
  frameCapture.init(sessionDir);

  // Wire screenshot triggers
  eventLogger.on('screenshot_trigger', (relativeMs: number) => {
    if (frameCapture) {
      frameCapture.captureFrame(relativeMs).then((framePath) => {
        if (framePath) {
          currentState.frameCount++;
          log(`[session-manager] Frame captured: ${framePath} (total: ${currentState.frameCount})`);
        }
      }).catch((err: unknown) => {
        logError(`[session-manager] Frame capture error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });

  // Track event count
  eventLogger.on('event', () => {
    currentState.eventCount++;
  });

  // Start audio capture
  const audioPath = path.join(sessionDir, 'audio.wav');
  const audioStarted = audioCapture.start(audioPath);
  if (!audioStarted) {
    log('[session-manager] Audio capture unavailable — continuing without audio');
  }

  // Start event logger (must be after wiring events)
  eventLogger.start(startTime);

  log(`[session-manager] Recording started (audio: ${audioStarted})`);
  return { ...currentState };
}

/**
 * Stop the current recording session.
 * Runs transcription and builds manifest.
 * Returns the final SessionState (status: 'complete' or 'error').
 */
export async function stopSession(): Promise<SessionState> {
  if (currentState.status !== 'recording') {
    throw new Error('No active recording session.');
  }

  const endTime = Date.now();
  currentState.status = 'processing';
  log(`[session-manager] Stopping session: ${currentState.id}`);

  // Stop event logger (flush pending burst)
  let events: RecordedEvent[] = [];
  if (eventLogger) {
    eventLogger.stop();
    events = eventLogger.getEvents();
    eventLogger = null;
  }

  // Stop audio capture
  let audioFile: string | null = null;
  if (audioCapture) {
    const savedPath = await audioCapture.stop();
    audioCapture = null;
    if (savedPath) {
      // Store relative path in manifest
      audioFile = 'audio.wav';
    }
  }

  log(`[session-manager] Captured ${events.length} events`);

  // Collect frame map from FrameCapture
  const frameMap = frameCapture ? frameCapture.getFrameMap() : new Map<number, string>();
  frameCapture = null;

  log(`[session-manager] Captured ${frameMap.size} frames`);
  currentState.eventCount = events.length;
  currentState.frameCount = frameMap.size;

  // Transcribe audio
  let transcription: TranscriptionSegment[] = [];
  if (audioFile) {
    const audioPath = path.join(currentState.dir, audioFile);
    log('[session-manager] Running transcription...');
    transcription = await transcribe(audioPath);
    log(`[session-manager] Transcription: ${transcription.length} segment(s)`);
  }

  // Build manifest
  try {
    buildManifest({
      sessionId: currentState.id,
      description: currentState.description,
      sessionDir: currentState.dir,
      startTime: currentState.startTime,
      endTime,
      events,
      frameMap,
      transcription,
      audioFile,
    });

    currentState.status = 'complete';
    log(`[session-manager] Session complete: ${currentState.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[session-manager] Manifest build failed: ${msg}`);
    currentState.status = 'error';
    currentState.errorMessage = msg;
  }

  return { ...currentState };
}

/**
 * Get the current session state.
 */
export function getStatus(): SessionState {
  return { ...currentState };
}

/**
 * List all session IDs in the recordings directory.
 * Returns [] if no recordings exist.
 */
export function listSessions(): string[] {
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) return [];
    return fs
      .readdirSync(RECORDINGS_DIR)
      .filter((name) => {
        try {
          return fs.statSync(path.join(RECORDINGS_DIR, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
}

/**
 * Read and return the manifest for a given session ID.
 * Returns null if not found.
 */
export function getSessionManifest(sessionId: string): Record<string, unknown> | null {
  const manifestPath = path.join(RECORDINGS_DIR, sessionId, 'manifest.json');
  try {
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
