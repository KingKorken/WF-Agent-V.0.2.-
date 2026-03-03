import { create } from 'zustand';

export interface Tab {
  id: string;
  label: string;
  closable: boolean;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string;
  recentTabIds: string[]; // tracks order for fallback on close
  openTab: (tab: Tab) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
}

const WORKSPACE_TAB: Tab = { id: 'workspace', label: 'Workspace', closable: false };

export const useTabStore = create<TabState>((set, get) => ({
  tabs: [WORKSPACE_TAB],
  activeTabId: 'workspace',
  recentTabIds: ['workspace'],

  openTab: (tab) => {
    const { tabs, setActiveTab } = get();
    // If tab already exists, just switch to it (deduplication)
    if (tabs.some((t) => t.id === tab.id)) {
      setActiveTab(tab.id);
      return;
    }
    set((state) => ({ tabs: [...state.tabs, tab] }));
    setActiveTab(tab.id);
  },

  closeTab: (tabId) => {
    if (tabId === 'workspace') return; // Cannot close workspace
    const { tabs, activeTabId, recentTabIds } = get();
    const newTabs = tabs.filter((t) => t.id !== tabId);
    const newRecent = recentTabIds.filter((id) => id !== tabId);

    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      // Fall back to most recently active tab, then workspace
      newActiveId = newRecent.find((id) => id !== tabId && newTabs.some((t) => t.id === id)) || 'workspace';
    }

    set({
      tabs: newTabs,
      activeTabId: newActiveId,
      recentTabIds: newRecent,
    });
  },

  setActiveTab: (tabId) => {
    set((state) => ({
      activeTabId: tabId,
      recentTabIds: [tabId, ...state.recentTabIds.filter((id) => id !== tabId)],
    }));
  },
}));
