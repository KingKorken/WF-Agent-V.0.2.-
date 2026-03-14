import { create } from 'zustand';
import type {
  AuditEventCompliance,
  AuditSession,
  AuditTerminalState,
} from '@shared/types';
import { getRoomId } from '../config/room';

// ---------------------------------------------------------------------------
// UI-facing AuditEntry (backward compatible with existing Logbook components)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  sessionId: string;
  userId: string;
  timestamp: Date;
  timezone: string;
  action: string;
  originalValue: string | null;
  newValue: string | null;
  justification: string;
  entityId: string;
  entityType: string;
  source: {
    ip: string;
    device: string;
    sessionId: string;
  };
  result: 'success' | 'failure';
  controlLayer: 'skill' | 'shell' | 'cdp' | 'accessibility' | 'vision';
  workflowId: string;
  workflowName: string;
  department: string;
  // New compliance fields
  eventType?: string;
  actionType?: string;
  previousHash?: string;
  entryHash?: string;
}

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

export interface AuditSessionState {
  id: string;
  workflowName: string;
  department: string;
  terminalState: AuditTerminalState;
  startTime: string;
  endTime: string | null;
  stepCount: number;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

interface FilterState {
  dateFrom: string | null;
  dateTo: string | null;
  workflow: string | null;
  department: string | null;
  status: string | null;
  employee: string | null;
  actionType: string | null;
}

const EMPTY_FILTERS: FilterState = {
  dateFrom: null,
  dateTo: null,
  workflow: null,
  department: null,
  status: null,
  employee: null,
  actionType: null,
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface LogbookState {
  entries: AuditEntry[];
  sessions: AuditSessionState[];
  filters: FilterState;
  isLive: boolean;
  isLoading: boolean;
  isGeneratingReport: boolean;

  // Legacy API (backward compat with existing UI components)
  addEntry: (entry: AuditEntry) => void;
  setFilter: (key: keyof FilterState, value: string | null) => void;
  clearFilters: () => void;
  setGeneratingReport: (value: boolean) => void;
  getFilteredEntries: () => AuditEntry[];

  // New API (real audit data from WebSocket + API)
  addComplianceEntry: (entry: AuditEventCompliance, sessionInfo: { workflowName: string; stepCount: number }) => void;
  addSession: (session: AuditSession) => void;
  updateSessionEnd: (sessionId: string, terminalState: AuditTerminalState, endTime: string, stepCount: number) => void;
  fetchHistoricalEntries: () => void;
}

// ---------------------------------------------------------------------------
// Compliance event → UI AuditEntry mapper
// ---------------------------------------------------------------------------

function complianceToAuditEntry(
  event: AuditEventCompliance,
  sessionInfo: { workflowName: string; stepCount: number },
): AuditEntry {
  return {
    id: event.id,
    sessionId: event.sessionId,
    userId: event.userPseudonymId,
    timestamp: new Date(event.timestamp),
    timezone: event.timezone,
    action: event.action,
    originalValue: null,
    newValue: null,
    justification: event.purpose,
    entityId: event.entityId || '',
    entityType: event.entityType || '',
    source: {
      ip: '',
      device: '',
      sessionId: event.sessionId,
    },
    result: event.result,
    controlLayer: (event.controlLayer || 'skill') as AuditEntry['controlLayer'],
    workflowId: '',
    workflowName: sessionInfo.workflowName,
    department: '',
    eventType: event.eventType,
    actionType: event.actionType,
    previousHash: event.previousHash,
    entryHash: event.entryHash,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLogbookStore = create<LogbookState>((set, get) => ({
  entries: [],
  sessions: [],
  filters: EMPTY_FILTERS,
  isLive: true,
  isLoading: false,
  isGeneratingReport: false,

  // --- Legacy API ---

  addEntry: (entry) =>
    set((state) => ({ entries: [entry, ...state.entries] })),

  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),

  clearFilters: () => set({ filters: EMPTY_FILTERS }),

  setGeneratingReport: (value) => set({ isGeneratingReport: value }),

  getFilteredEntries: () => {
    const { entries, filters } = get();
    return entries.filter((entry) => {
      if (filters.workflow && entry.workflowName !== filters.workflow) return false;
      if (filters.department && entry.department !== filters.department) return false;
      if (filters.status && entry.result !== filters.status) return false;
      if (filters.employee && !entry.entityId.includes(filters.employee)) return false;
      if (filters.dateFrom && entry.timestamp < new Date(filters.dateFrom)) return false;
      if (filters.dateTo && entry.timestamp > new Date(filters.dateTo)) return false;
      return true;
    });
  },

  // --- New real data API ---

  addComplianceEntry: (event, sessionInfo) => {
    const entry = complianceToAuditEntry(event, sessionInfo);
    set((state) => {
      // Deduplicate by ID
      if (state.entries.some((e) => e.id === entry.id)) return state;
      return { entries: [entry, ...state.entries] };
    });
  },

  addSession: (session) => {
    const sessionState: AuditSessionState = {
      id: session.id,
      workflowName: session.workflowName,
      department: session.department,
      terminalState: session.terminalState,
      startTime: session.startTime,
      endTime: session.endTime,
      stepCount: session.stepCount,
      eventCount: 0,
    };
    set((state) => {
      if (state.sessions.some((s) => s.id === session.id)) return state;
      return { sessions: [sessionState, ...state.sessions] };
    });
  },

  updateSessionEnd: (sessionId, terminalState, endTime, stepCount) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, terminalState, endTime, stepCount }
          : s,
      ),
    }));
  },

  fetchHistoricalEntries: () => {
    const roomId = getRoomId();
    if (!roomId) return;

    set({ isLoading: true });

    // Determine bridge server URL from WebSocket URL
    const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8765';
    const httpUrl = wsUrl.replace('wss://', 'https://').replace('ws://', 'http://');

    fetch(`${httpUrl}/audit/sessions?roomId=${encodeURIComponent(roomId)}&limit=50`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { sessions: AuditSession[] }) => {
        const state = get();
        const existingIds = new Set(state.sessions.map((s) => s.id));
        const newSessions = data.sessions
          .filter((s) => !existingIds.has(s.id))
          .map((s): AuditSessionState => ({
            id: s.id,
            workflowName: s.workflowName,
            department: s.department,
            terminalState: s.terminalState,
            startTime: s.startTime,
            endTime: s.endTime,
            stepCount: s.stepCount,
            eventCount: 0,
          }));

        if (newSessions.length > 0) {
          set((state) => ({ sessions: [...newSessions, ...state.sessions] }));
        }
      })
      .catch((err) => {
        console.error('[logbook] Failed to fetch historical entries:', err);
      })
      .finally(() => {
        set({ isLoading: false });
      });
  },
}));
