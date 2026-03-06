import { create } from 'zustand';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface ConnectionState {
  /** WebSocket connection to bridge server */
  status: ConnectionStatus;
  lastConnected: Date | null;
  /** True once a successful connection has been made this session */
  hasConnectedOnce: boolean;
  /** True when running on a deployed host with no bridge configured */
  isDeployed: boolean;

  /** Whether the local agent is connected to the bridge */
  agentConnected: boolean;
  agentName: string | null;
  supportedLayers: string[];

  /** Room token from URL (populated by message-router on init) */
  roomId: string | null;

  setStatus: (status: ConnectionStatus) => void;
  setDeployed: () => void;
  setAgentStatus: (connected: boolean, name: string | null, layers: string[]) => void;
  setRoomId: (roomId: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  lastConnected: null,
  hasConnectedOnce: false,
  isDeployed: false,
  agentConnected: false,
  agentName: null,
  supportedLayers: [],
  roomId: null,

  setStatus: (status) =>
    set((state) => ({
      status,
      lastConnected: status === 'connected' ? new Date() : state.lastConnected,
      hasConnectedOnce: state.hasConnectedOnce || status === 'connected',
    })),
  setDeployed: () => set({ isDeployed: true, status: 'disconnected' }),
  setAgentStatus: (connected, name, layers) =>
    set({
      agentConnected: connected,
      agentName: name,
      supportedLayers: layers,
    }),
  setRoomId: (roomId) => set({ roomId }),
}));
