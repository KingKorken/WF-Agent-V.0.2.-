/**
 * Manifest Builder — Aligns events, frames, and narration into a session manifest.
 *
 * Output files written to the session directory:
 *   manifest.json  — array of (frame, event, narration) tuples
 *   events.json    — raw recorded events array
 *
 * Narration alignment: for each event, find the transcript segment where
 *   segment.startTime * 1000 <= event.timestamp <= segment.endTime * 1000
 * First matching segment wins; null if no match.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import { RecordedEvent } from './event-logger';
import { TranscriptionSegment } from './transcription';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  /** Relative path to the frame PNG, e.g. "frames/frame-00001234.png" (null if no frame) */
  frame: string | null;
  /** The recorded event */
  event: RecordedEvent;
  /** Narration text from Whisper for this event's timestamp (null if no match) */
  narration: string | null;
}

export interface SessionManifest {
  id: string;
  description: string;
  startTime: string;   // ISO string
  endTime: string;     // ISO string
  durationMs: number;
  frameCount: number;
  eventCount: number;
  audioFile: string | null;
  entries: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface BuildManifestOptions {
  sessionId: string;
  description: string;
  sessionDir: string;
  startTime: number;   // epoch ms
  endTime: number;     // epoch ms
  events: RecordedEvent[];
  /** Map of relativeMs → relative frame path (e.g. "frames/frame-00001234.png") */
  frameMap: Map<number, string>;
  transcription: TranscriptionSegment[];
  audioFile: string | null;  // relative path or null
}

/**
 * Build the session manifest, write manifest.json and events.json.
 * Returns the completed SessionManifest.
 */
export function buildManifest(opts: BuildManifestOptions): SessionManifest {
  const {
    sessionId,
    description,
    sessionDir,
    startTime,
    endTime,
    events,
    frameMap,
    transcription,
    audioFile,
  } = opts;

  log(`[manifest-builder] Building manifest for ${sessionId} (${events.length} events, ${frameMap.size} frames, ${transcription.length} narration segments)`);

  const entries: ManifestEntry[] = events.map((ev) => {
    // Find the closest frame at or before this event's relativeMs
    const frame = findFrame(ev.relativeMs, frameMap);

    // Find matching narration segment (Whisper segments are in seconds relative to audio start;
    // relativeMs is milliseconds relative to session start — findNarration converts with * 1000)
    const narration = findNarration(ev.relativeMs, transcription);

    return { frame, event: ev, narration };
  });

  const manifest: SessionManifest = {
    id: sessionId,
    description,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    durationMs: endTime - startTime,
    frameCount: frameMap.size,
    eventCount: events.length,
    audioFile,
    entries,
  };

  // Write manifest.json
  const manifestPath = path.join(sessionDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log(`[manifest-builder] Wrote manifest.json (${entries.length} entries)`);

  // Write events.json (raw events for debugging)
  const eventsPath = path.join(sessionDir, 'events.json');
  fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2), 'utf8');
  log(`[manifest-builder] Wrote events.json`);

  return manifest;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the frame path closest to (but not after) the given relativeMs.
 * Returns null if no frames exist before this timestamp.
 */
function findFrame(relativeMs: number, frameMap: Map<number, string>): string | null {
  if (frameMap.size === 0) return null;

  const times = Array.from(frameMap.keys()).sort((a, b) => a - b);
  let best: number | null = null;

  for (const t of times) {
    if (t <= relativeMs) {
      best = t;
    } else {
      break;
    }
  }

  return best !== null ? (frameMap.get(best) ?? null) : null;
}

/**
 * Find a transcript segment that covers the given absolute timestamp (ms).
 * Returns the segment text if found, null otherwise.
 */
function findNarration(
  timestampMs: number,
  segments: TranscriptionSegment[]
): string | null {
  for (const seg of segments) {
    const startMs = seg.startTime * 1000;
    const endMs = seg.endTime * 1000;
    if (timestampMs >= startMs && timestampMs <= endMs) {
      return seg.text;
    }
  }
  return null;
}
