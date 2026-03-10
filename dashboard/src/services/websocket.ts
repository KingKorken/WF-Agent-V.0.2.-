import type { WebSocketMessage } from '@shared/types';
import { useConnectionStore } from '../stores/connectionStore';
import { isCloudPreview } from '../config/room';

type MessageHandler = (message: WebSocketMessage) => void;

/** Lazy debug log helper — avoids circular import with debugStore */
function debugLog(
  level: 'info' | 'warn' | 'error',
  category: string,
  message: string,
  detail?: string,
): void {
  try {
    // Lazy import to break circular dep (stores import from websocket)
    const { useDebugStore } = require('../stores/debugStore');
    useDebugStore.getState().addEntry({
      source: 'client' as const,
      level,
      category,
      message,
      detail,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // debugStore not yet available during init — ignore
  }
}

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Set<MessageHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private maxReconnectAttempts = 15;
  /** Set to true when disconnect() is called — prevents zombie reconnections */
  private disposed = false;
  /** True when running on Vercel with no bridge server configured */
  readonly cloudPreview: boolean;

  constructor(url: string) {
    this.url = url;
    this.cloudPreview = isCloudPreview();
  }

  connect(): void {
    // On cloud preview (Vercel, no bridge configured), skip WS entirely
    if (this.cloudPreview) {
      useConnectionStore.getState().setDeployed();
      return;
    }

    // Don't reconnect if we've been disposed
    if (this.disposed) return;

    const store = useConnectionStore.getState();
    store.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        if (this.disposed) { this.ws?.close(); return; }
        store.setStatus('connected');
        this.reconnectAttempts = 0;
        debugLog('info', 'websocket', 'Connected', this.url);
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          debugLog('info', 'ws-recv', message.type);
          this.handlers.forEach((handler) => handler(message));
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = (event) => {
        if (this.disposed) return;
        debugLog('warn', 'websocket', 'Disconnected', `code=${event.code} reason=${event.reason || 'none'}`);
        // Use CloseEvent.code to distinguish error vs clean close
        // 1000 = normal, 1001 = going away, 1006 = abnormal (error)
        if (event.code === 1006) {
          store.setStatus('error');
        } else {
          store.setStatus('disconnected');
        }
        this.scheduleReconnect();
      };

      // onerror only logs — onclose handles all status updates
      // (browser fires onerror then onclose, so updating status in both causes flicker)
      this.ws.onerror = () => {
        debugLog('error', 'websocket', 'WebSocket error');
        console.warn('[ws] WebSocket error — onclose will handle status');
      };
    } catch {
      store.setStatus('error');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;

    // Stop retrying after max attempts
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      useConnectionStore.getState().setStatus('disconnected');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    debugLog('info', 'websocket', `Reconnecting in ${delay}ms`, `attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      debugLog('info', 'ws-send', (message.type as string) || 'unknown', (message.conversationId as string) || undefined);
      this.ws.send(JSON.stringify(message));
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

// Singleton — URL comes from environment variable, production default, or local dev
function resolveWsUrl(): string {
  // 1. Explicit env var (set via Vercel or .env)
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  // 2. Production host → use production bridge
  const host = window.location.hostname;
  if (host.includes('vercel.app') || host.includes('wfa')) return 'wss://wfa-bridge.fly.dev';
  // 3. Local dev
  return 'ws://localhost:8765';
}
const WS_URL = resolveWsUrl();
export const wsService = new WebSocketService(WS_URL);
