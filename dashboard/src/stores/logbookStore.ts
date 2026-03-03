import { create } from 'zustand';

export interface AuditEntry {
  id: string;
  userId: string;
  timestamp: Date;
  timezone: string;
  action: string;
  originalValue: string | null;
  newValue: string | null;
  justification: string;
  entityId: string;
  entityType: string; // e.g., "employee", "invoice"
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
}

interface FilterState {
  dateFrom: string | null;
  dateTo: string | null;
  workflow: string | null;
  department: string | null;
  status: string | null;
  employee: string | null;
  actionType: string | null;
}

interface LogbookState {
  entries: AuditEntry[];
  filters: FilterState;
  isLive: boolean;
  isGeneratingReport: boolean;
  addEntry: (entry: AuditEntry) => void;
  setFilter: (key: keyof FilterState, value: string | null) => void;
  clearFilters: () => void;
  setGeneratingReport: (value: boolean) => void;
  getFilteredEntries: () => AuditEntry[];
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

// Mock audit entries for development
const MOCK_ENTRIES: AuditEntry[] = [
  {
    id: 'ae-1',
    userId: 'user-tim',
    timestamp: new Date('2026-03-02T09:15:32Z'),
    timezone: 'Europe/Berlin',
    action: 'Read cell B3 from Excel',
    originalValue: null,
    newValue: '4200',
    justification: 'Payroll processing — reading gross salary',
    entityId: 'emp-maria-gonzalez',
    entityType: 'employee',
    source: { ip: '192.168.1.42', device: 'MacBook Pro', sessionId: 'sess-abc123' },
    result: 'success',
    controlLayer: 'accessibility',
    workflowId: 'wf-1',
    workflowName: 'Monthly Payroll',
    department: 'HR',
  },
  {
    id: 'ae-2',
    userId: 'user-tim',
    timestamp: new Date('2026-03-02T09:15:35Z'),
    timezone: 'Europe/Berlin',
    action: 'Get employee hours from TimeTracker',
    originalValue: null,
    newValue: '168',
    justification: 'Payroll processing — reading monthly hours',
    entityId: 'emp-maria-gonzalez',
    entityType: 'employee',
    source: { ip: '192.168.1.42', device: 'MacBook Pro', sessionId: 'sess-abc123' },
    result: 'success',
    controlLayer: 'cdp',
    workflowId: 'wf-1',
    workflowName: 'Monthly Payroll',
    department: 'HR',
  },
  {
    id: 'ae-3',
    userId: 'user-tim',
    timestamp: new Date('2026-03-02T09:15:41Z'),
    timezone: 'Europe/Berlin',
    action: 'Enter gross salary in PayrollPro',
    originalValue: '',
    newValue: '4200',
    justification: 'Payroll processing — entering calculated salary',
    entityId: 'emp-maria-gonzalez',
    entityType: 'employee',
    source: { ip: '192.168.1.42', device: 'MacBook Pro', sessionId: 'sess-abc123' },
    result: 'success',
    controlLayer: 'accessibility',
    workflowId: 'wf-1',
    workflowName: 'Monthly Payroll',
    department: 'HR',
  },
];

export const useLogbookStore = create<LogbookState>((set, get) => ({
  entries: MOCK_ENTRIES,
  filters: EMPTY_FILTERS,
  isLive: true,
  isGeneratingReport: false,

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
}));
