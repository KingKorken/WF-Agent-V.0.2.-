import type { WebSocketMessage } from '@shared/types';
import { useConnectionStore } from '../stores/connectionStore';

type MessageHandler = (message: WebSocketMessage) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Set<MessageHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private maxReconnectDelay = 30000;
  // Allow more reconnect attempts locally (services may start at different times)
  // On Vercel/deployed, we'll detect "never connected" and show appropriate status
  private maxReconnectAttempts = 15;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    const store = useConnectionStore.getState();
    store.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        store.setStatus('connected');
        store.resetReconnect();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.handlers.forEach((handler) => handler(message));
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        store.setStatus('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        store.setStatus('error');
      };
    } catch {
      store.setStatus('error');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const store = useConnectionStore.getState();

    // Stop retrying after max attempts (prevents infinite reconnect on Vercel/deployed)
    if (store.reconnectAttempts >= this.maxReconnectAttempts) {
      store.setStatus('disconnected');
      return;
    }

    store.incrementReconnect();
    const delay = Math.min(
      1000 * Math.pow(2, store.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

// Singleton — URL will come from environment variable
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8765';
export const wsService = new WebSocketService(WS_URL);
