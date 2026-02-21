/**
 * Reconnect Logic — Exponential backoff for WebSocket reconnection.
 *
 * When the WebSocket connection drops (network issue, server restart, etc.),
 * this module manages automatic reconnection with exponential backoff:
 *   1s → 2s → 4s → 8s → 16s → 30s (capped)
 *
 * The agent will keep trying forever — it should always attempt to reconnect
 * since the user expects it to stay connected.
 */

import {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_BACKOFF_MULTIPLIER,
} from '@workflow-agent/shared';
import { log } from '../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

export class ReconnectManager {
  /** Current delay before next reconnection attempt (grows with backoff) */
  private currentDelay: number = RECONNECT_INITIAL_DELAY_MS;

  /** How many reconnection attempts we've made since last successful connection */
  private attempts: number = 0;

  /** The pending reconnect timer (so we can cancel it if needed) */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedule a reconnection attempt.
   * Calls the provided function after the current backoff delay.
   *
   * @param connectFn - The function to call to attempt reconnection
   */
  scheduleReconnect(connectFn: () => void): void {
    this.attempts++;
    log(
      `[${timestamp()}] [reconnect] Scheduling reconnect attempt #${this.attempts} in ${this.currentDelay}ms`
    );

    this.timer = setTimeout(() => {
      connectFn();
    }, this.currentDelay);

    // Increase delay for next time (exponential backoff, capped at max)
    this.currentDelay = Math.min(
      this.currentDelay * RECONNECT_BACKOFF_MULTIPLIER,
      RECONNECT_MAX_DELAY_MS
    );
  }

  /**
   * Reset the backoff delay back to the initial value.
   * Call this when a connection is successfully established.
   */
  reset(): void {
    log(`[${timestamp()}] [reconnect] Connection established — resetting backoff`);
    this.currentDelay = RECONNECT_INITIAL_DELAY_MS;
    this.attempts = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Cancel any pending reconnection attempt */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Get how many reconnect attempts have been made */
  getAttempts(): number {
    return this.attempts;
  }
}
