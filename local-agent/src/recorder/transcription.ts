/**
 * Transcription — Transcribe an audio file using OpenAI Whisper API.
 *
 * If OPENAI_API_KEY is not set, logs a warning and returns [].
 * If the API call fails, logs the error and returns [].
 * Requires Node 18+ for built-in fetch.
 */

import * as fs from 'fs';
import * as https from 'https';
import { log, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionSegment {
  text: string;
  startTime: number; // seconds
  endTime: number;   // seconds
}

interface WhisperVerboseSegment {
  text: string;
  start: number;
  end: number;
}

interface WhisperVerboseResponse {
  text: string;
  segments?: WhisperVerboseSegment[];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Transcribe a WAV file using OpenAI Whisper API.
 * Returns an array of time-aligned transcript segments.
 */
export async function transcribe(audioPath: string): Promise<TranscriptionSegment[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log('[transcription] OPENAI_API_KEY not set — skipping transcription');
    return [];
  }

  if (!fs.existsSync(audioPath)) {
    log(`[transcription] Audio file not found: ${audioPath}`);
    return [];
  }

  const stat = fs.statSync(audioPath);
  if (stat.size === 0) {
    log('[transcription] Audio file is empty — skipping transcription');
    return [];
  }

  log(`[transcription] Transcribing ${audioPath} (${Math.round(stat.size / 1024)}KB)...`);

  try {
    const result = await postToWhisper(audioPath, apiKey);
    const segments = parseSegments(result);
    log(`[transcription] Got ${segments.length} segment(s)`);
    return segments;
  } catch (err) {
    logError(`[transcription] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * POST the audio file to OpenAI Whisper using multipart/form-data via https module.
 */
function postToWhisper(audioPath: string, apiKey: string): Promise<WhisperVerboseResponse> {
  return new Promise((resolve, reject) => {
    const audioData = fs.readFileSync(audioPath);
    const filename = 'audio.wav';
    const boundary = `----WFAgentBoundary${Date.now()}`;

    // Build multipart body
    const parts: Buffer[] = [];

    // model field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`
    ));

    // response_format field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
    ));

    // timestamp_granularities[] field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment\r\n`
    ));

    // file field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`
    ));
    parts.push(audioData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const options: https.RequestOptions = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Whisper API error ${res.statusCode}: ${raw.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw) as WhisperVerboseResponse);
        } catch (parseErr) {
          reject(new Error(`Failed to parse Whisper response: ${raw.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Convert Whisper verbose_json response into TranscriptionSegment array.
 * Falls back to a single segment from the full text if no segments present.
 */
function parseSegments(response: WhisperVerboseResponse): TranscriptionSegment[] {
  if (response.segments && response.segments.length > 0) {
    return response.segments.map((seg) => ({
      text: seg.text.trim(),
      startTime: seg.start,
      endTime: seg.end,
    }));
  }

  // Fallback: treat entire response as one segment
  if (response.text && response.text.trim()) {
    return [{ text: response.text.trim(), startTime: 0, endTime: 0 }];
  }

  return [];
}
