/**
 * WebSocket Client — Persistent connection to the cloud server.
 *
 * Maintains a WebSocket connection to the cloud backend (or test server).
 * When a message arrives, it passes it to the command-handler for processing.
 * If the connection drops, it uses the ReconnectManager to automatically
 * reconnect with exponential backoff.
 *
 * Usage:
 *   const client = new WebSocketClient('ws://localhost:8765');
 *   client.connect();
 *   // ... later ...
 *   client.disconnect();
 */

import WebSocket from 'ws';
import {
  AgentHello,
  CommandLayer,
  APP_VERSION,
  AGENT_NAME,
  DEFAULT_WS_URL,
  SUPPORTED_LAYERS,
} from '@workflow-agent/shared';
import { ReconnectManager } from './reconnect';
import { handleIncomingMessage } from './command-handler';
import { log, warn, error as logError } from '../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/** Callback type for connection status changes */
export type ConnectionStatusCallback = (connected: boolean) => void;

export class WebSocketClient {
  /** The WebSocket connection (null when disconnected) */
  private ws: WebSocket | null = null;

  /** The server URL to connect to */
  private serverUrl: string;

  /** Manages reconnection with exponential backoff */
  private reconnectManager: ReconnectManager = new ReconnectManager();

  /** Whether the client has been intentionally disconnected (don't auto-reconnect) */
  private intentionalDisconnect: boolean = false;

  /** Callback for connection status changes (used by the tray icon) */
  private statusCallback: ConnectionStatusCallback | null = null;

  constructor(serverUrl: string = DEFAULT_WS_URL) {
    this.serverUrl = serverUrl;
  }

  /**
   * Register a callback that fires whenever the connection status changes.
   * Used by the system tray to show connected/disconnected status.
   */
  onStatusChange(callback: ConnectionStatusCallback): void {
    this.statusCallback = callback;
  }

  /** Whether the WebSocket is currently connected */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the WebSocket server.
   * Sets up all event handlers for messages, errors, and disconnections.
   */
  connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      log(`[${timestamp()}] [ws-client] Already connected`);
      return;
    }

    this.intentionalDisconnect = false;
    log(`[${timestamp()}] [ws-client] Connecting to ${this.serverUrl}...`);

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`[${timestamp()}] [ws-client] Failed to create WebSocket: ${message}`);
      this.scheduleReconnect();
      return;
    }

    // --- Connection opened successfully ---
    this.ws.on('open', () => {
      log(`[${timestamp()}] [ws-client] Connected to ${this.serverUrl}`);
      this.reconnectManager.reset();
      this.notifyStatus(true);

      // Send a "hello" registration message so the server knows who we are
      const hello: AgentHello = {
        type: 'hello',
        agentName: AGENT_NAME,
        version: APP_VERSION,
        platform: process.platform,
        supportedLayers: [...SUPPORTED_LAYERS] as CommandLayer[],
      };
      this.send(JSON.stringify(hello));
    });

    // --- Message received from server ---
    this.ws.on('message', async (data: WebSocket.Data) => {
      const raw = data.toString();
      log(`[${timestamp()}] [ws-client] Message received: ${raw.substring(0, 200)}${raw.length > 200 ? '...' : ''}`);

      // Pass to the command handler for parsing and execution
      const response = await handleIncomingMessage(raw);

      // If the handler returned a response, send it back to the server
      if (response) {
        this.send(response);
      }
    });

    // --- Connection closed ---
    this.ws.on('close', (code: number, reason: Buffer) => {
      log(`[${timestamp()}] [ws-client] Connection closed (code: ${code}, reason: ${reason.toString() || 'none'})`);
      this.ws = null;
      this.notifyStatus(false);

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    // --- Connection error ---
    this.ws.on('error', (error: Error) => {
      logError(`[${timestamp()}] [ws-client] WebSocket error: ${error.message}`);
      // The 'close' event will fire after this, which will trigger reconnection
    });
  }

  /**
   * Send a message through the WebSocket.
   * Silently fails if not connected (logs a warning).
   */
  send(message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      warn(`[${timestamp()}] [ws-client] Cannot send — not connected`);
      return;
    }
    this.ws.send(message);
  }

  /**
   * Intentionally disconnect from the server.
   * Does NOT trigger auto-reconnect.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.reconnectManager.cancel();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.notifyStatus(false);
    log(`[${timestamp()}] [ws-client] Disconnected intentionally`);
  }

  /** Schedule a reconnection attempt via the ReconnectManager */
  private scheduleReconnect(): void {
    this.reconnectManager.scheduleReconnect(() => {
      this.connect();
    });
  }

  /** Notify the status callback (if registered) of a connection status change */
  private notifyStatus(connected: boolean): void {
    if (this.statusCallback) {
      this.statusCallback(connected);
    }
  }
}
