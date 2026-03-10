import { create } from 'zustand';

export interface DebugEntry {
  id: string;
  source: 'client' | 'server';
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  detail?: string;
  timestamp: string;
}

interface DebugState {
  entries: DebugEntry[];
  isOpen: boolean;
  addEntry: (entry: Omit<DebugEntry, 'id'>) => void;
  clear: () => void;
  toggle: () => void;
}

const MAX_ENTRIES = 500;

export const useDebugStore = create<DebugState>((set) => ({
  entries: [],
  isOpen: false,

  addEntry: (entry) =>
    set((state) => {
      const newEntry: DebugEntry = {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      };
      const entries = [...state.entries, newEntry];
      if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
      }
      return { entries };
    }),

  clear: () => set({ entries: [] }),

  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
