import { create } from 'zustand';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface ConnectionState {
  /** WebSocket connection to bridge server */
  status: ConnectionStatus;
  lastConnected: Date | null;
  reconnectAttempts: number;

  /** Whether the local agent is connected to the bridge */
  agentConnected: boolean;
  agentName: string | null;
  supportedLayers: string[];

  setStatus: (status: ConnectionStatus) => void;
  incrementReconnect: () => void;
  resetReconnect: () => void;
  setAgentStatus: (connected: boolean, name: string | null, layers: string[]) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  lastConnected: null,
  reconnectAttempts: 0,
  agentConnected: false,
  agentName: null,
  supportedLayers: [],

  setStatus: (status) =>
    set({
      status,
      lastConnected: status === 'connected' ? new Date() : null,
    }),
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
