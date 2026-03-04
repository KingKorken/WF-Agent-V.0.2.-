import { create } from 'zustand';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface ConnectionState {
  /** WebSocket connection to bridge server */
  status: ConnectionStatus;
  lastConnected: Date | null;
  reconnectAttempts: number;
  /** True once a successful connection has been made this session */
  hasConnectedOnce: boolean;
  /** True when running on a deployed host (Vercel) — no bridge server available */
  isDeployed: boolean;

  /** Whether the local agent is connected to the bridge */
  agentConnected: boolean;
  agentName: string | null;
  supportedLayers: string[];

  setStatus: (status: ConnectionStatus) => void;
  setDeployed: () => void;
  incrementReconnect: () => void;
  resetReconnect: () => void;
  setAgentStatus: (connected: boolean, name: string | null, layers: string[]) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  lastConnected: null,
  reconnectAttempts: 0,
  hasConnectedOnce: false,
  isDeployed: false,
  agentConnected: false,
  agentName: null,
  supportedLayers: [],

  setStatus: (status) =>
    set((state) => ({
      status,
      lastConnected: status === 'connected' ? new Date() : state.lastConnected,
      hasConnectedOnce: state.hasConnectedOnce || status === 'connected',
    })),
  setDeployed: () => set({ isDeployed: true, status: 'disconnected' }),
  incrementReconnect: () =>
    set((state) => ({ reconnectAttempts: state.reconnectAttempts + 1 })),
  resetReconnect: () => set({ reconnectAttempts: 0 }),
  setAgentStatus: (connected, name, layers) =>
    set({
      agentConnected: connected,
      agentName: name,
      supportedLayers: layers,
    }),
}));
