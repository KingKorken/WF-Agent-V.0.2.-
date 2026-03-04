import type { WebSocketMessage } from '@shared/types';
import { useConnectionStore } from '../stores/connectionStore';

type MessageHandler = (message: WebSocketMessage) => void;

/**
 * Detect whether the dashboard is running on a deployed host (Vercel, Netlify, etc.)
 * vs. locally. On deployed hosts there is no bridge server to connect to, so we
 * skip WebSocket connections entirely and show "Cloud preview" status.
 */
function isDeployedEnvironment(): boolean {
  const host = window.location.hostname;
  return host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('192.168.');
}

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Set<MessageHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private maxReconnectDelay = 30000;
  private maxReconnectAttempts = 15;
  /** True when running on Vercel/deployed — skip all WS connections */
  readonly deployed: boolean;

  constructor(url: string) {
    this.url = url;
    this.deployed = isDeployedEnvironment();
  }

  connect(): void {
    // On deployed environments, don't attempt WebSocket connections at all.
    // There is no bridge server — ws://localhost would point at the visitor's machine.
    if (this.deployed) {
      useConnectionStore.getState().setDeployed();
      return;
    }

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

    // Stop retrying after max attempts
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
