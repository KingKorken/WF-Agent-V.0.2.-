/**
 * Event Logger — Wraps the native event-monitor binary.
 *
 * Spawns event-monitor-darwin, parses its NDJSON stdout, coalesces rapid
 * keystrokes into typing bursts, and emits events for the session manager.
 *
 * Screenshot triggers (emitted as 'screenshot_trigger' events):
 *   - Every mouse click or double-click
 *   - End of a typing burst (500ms after last keypress)
 *   - App switch
 *   - Window focus change
 *   - Scroll cumulative delta > 500px (resets after trigger)
 *   - Heartbeat every 5 seconds if nothing else triggered
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { log, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClickEvent {
  type: 'click';
  button: 'left' | 'right';
  x: number;
  y: number;
  timestamp: number;
  relativeMs: number;
}

export interface DoubleClickEvent {
  type: 'doubleclick';
  x: number;
  y: number;
  timestamp: number;
  relativeMs: number;
}

export interface TypingBurst {
  type: 'typing';
  text: string;
  keyCount: number;
  startTime: number;  // absolute ms
  endTime: number;    // absolute ms
  relativeMs: number; // relative to session start
}

export interface HotkeyEvent {
  type: 'hotkey';
  keys: string[];
  timestamp: number;
  relativeMs: number;
}

export interface ScrollEvent {
  type: 'scroll';
  x: number;
  y: number;
  deltaY: number;
  timestamp: number;
  relativeMs: number;
}

export interface AppSwitchEvent {
  type: 'app_switch';
  fromApp: string;
  toApp: string;
  timestamp: number;
  relativeMs: number;
}

export interface WindowFocusEvent {
  type: 'window_focus';
  app: string;
  title: string;
  timestamp: number;
  relativeMs: number;
}

export type RecordedEvent =
  | ClickEvent
  | DoubleClickEvent
  | TypingBurst
  | HotkeyEvent
  | ScrollEvent
  | AppSwitchEvent
  | WindowFocusEvent;

// ---------------------------------------------------------------------------
// Binary path
// ---------------------------------------------------------------------------

// Compiled JS lives at local-agent/dist/src/recorder/event-logger.js
// Binary lives at  local-agent/bin/event-monitor-darwin
// Three levels up from dist/src/recorder → local-agent/
const BINARY_PATH = path.join(__dirname, '../../../bin/event-monitor-darwin');

const KEYSTROKE_COALESCE_MS = 500;
const SCROLL_TRIGGER_THRESHOLD = 500; // px cumulative
const HEARTBEAT_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// EventLogger class
// ---------------------------------------------------------------------------

export class EventLogger extends EventEmitter {
  private proc: ChildProcess | null = null;
  private sessionStartMs: number = 0;
  private events: RecordedEvent[] = [];

  // Keystroke coalescing state
  private burstKeys: string[] = [];
  private burstStartMs: number = 0;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;

  // Scroll accumulator
  private scrollAccumulator: number = 0;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastTriggerMs: number = 0;

  start(sessionStartMs: number): void {
    this.sessionStartMs = sessionStartMs;
    this.lastTriggerMs = sessionStartMs;

    log(`[event-logger] Spawning event monitor: ${BINARY_PATH}`);

    this.proc = spawn(BINARY_PATH, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout?.setEncoding('utf8');
    let lineBuffer = '';

    this.proc.stdout?.on('data', (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.handleLine(line.trim());
      }
    });

    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (data: string) => {
      logError(`[event-logger] monitor stderr: ${data.trim()}`);
    });

    this.proc.on('exit', (code) => {
      log(`[event-logger] Monitor exited (code ${code})`);
    });

    // Heartbeat
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastTriggerMs >= HEARTBEAT_INTERVAL_MS) {
        this.triggerScreenshot();
      }
    }, HEARTBEAT_INTERVAL_MS);

    log('[event-logger] Started');
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.flushBurst();
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
    log('[event-logger] Stopped');
  }

  getEvents(): RecordedEvent[] {
    return [...this.events];
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleLine(line: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON lines
    }

    const ts = (raw.timestamp as number) || Date.now();
    const relativeMs = ts - this.sessionStartMs;

    switch (raw.type) {
      case 'click': {
        const ev: ClickEvent = {
          type: 'click',
          button: (raw.button as 'left' | 'right') || 'left',
          x: (raw.x as number) || 0,
          y: (raw.y as number) || 0,
          timestamp: ts,
          relativeMs,
        };
        this.pushEvent(ev);
        this.emit('event', ev);
        this.triggerScreenshot();
        break;
      }

      case 'doubleclick': {
        const ev: DoubleClickEvent = {
          type: 'doubleclick',
          x: (raw.x as number) || 0,
          y: (raw.y as number) || 0,
          timestamp: ts,
          relativeMs,
        };
        this.pushEvent(ev);
        this.emit('event', ev);
        this.triggerScreenshot();
        break;
      }

      case 'keypress': {
        const key = (raw.key as string) || '';
        this.addKeyToBurst(key, ts);
        break;
      }

      case 'hotkey': {
        this.flushBurst(); // finalize any ongoing burst first
        const ev: HotkeyEvent = {
          type: 'hotkey',
          keys: (raw.keys as string[]) || [],
          timestamp: ts,
          relativeMs,
        };
        this.pushEvent(ev);
        this.emit('event', ev);
        break;
      }

      case 'scroll': {
        const dy = Math.abs((raw.deltaY as number) || 0);
        this.scrollAccumulator += dy;
        const ev: ScrollEvent = {
          type: 'scroll',
          x: (raw.x as number) || 0,
          y: (raw.y as number) || 0,
          deltaY: (raw.deltaY as number) || 0,
          timestamp: ts,
          relativeMs,
        };
        this.pushEvent(ev);
        this.emit('event', ev);
        if (this.scrollAccumulator >= SCROLL_TRIGGER_THRESHOLD) {
          this.scrollAccumulator = 0;
          this.triggerScreenshot();
        }
        break;
      }

      case 'app_switch': {
        const ev: AppSwitchEvent = {
          type: 'app_switch',
          fromApp: (raw.fromApp as string) || '',
          toApp: (raw.toApp as string) || '',
          timestamp: ts,
          relativeMs,
        };
        this.pushEvent(ev);
        this.emit('event', ev);
        this.triggerScreenshot();
        break;
      }

      case 'window_focus': {
        const ev: WindowFocusEvent = {
          type: 'window_focus',
          app: (raw.app as string) || '',
          title: (raw.title as string) || '',
          timestamp: ts,
          relativeMs,
        };
        this.pushEvent(ev);
        this.emit('event', ev);
        this.triggerScreenshot();
        break;
      }
    }
  }

  private addKeyToBurst(key: string, timestamp: number): void {
    if (this.burstKeys.length === 0) {
      this.burstStartMs = timestamp;
    }
    this.burstKeys.push(key);

    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => {
      this.flushBurst();
    }, KEYSTROKE_COALESCE_MS);
  }

  private flushBurst(): void {
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
    if (this.burstKeys.length === 0) return;

    const text = this.burstKeys
      .filter((k) => k.length === 1) // only printable chars
      .join('');
    const endMs = Date.now();

    const ev: TypingBurst = {
      type: 'typing',
      text,
      keyCount: this.burstKeys.length,
      startTime: this.burstStartMs,
      endTime: endMs,
      relativeMs: this.burstStartMs - this.sessionStartMs,
    };

    this.burstKeys = [];
    this.burstStartMs = 0;

    this.pushEvent(ev);
    this.emit('event', ev);
    this.triggerScreenshot();
  }

  private pushEvent(ev: RecordedEvent): void {
    this.events.push(ev);
    log(`[event-logger] ${ev.type}${ev.type === 'typing' ? ` "${(ev as TypingBurst).text.substring(0, 20)}"` : ''} @ ${ev.relativeMs}ms`);
  }

  private triggerScreenshot(): void {
    this.lastTriggerMs = Date.now();
    this.emit('screenshot_trigger', this.lastTriggerMs - this.sessionStartMs);
  }
}
