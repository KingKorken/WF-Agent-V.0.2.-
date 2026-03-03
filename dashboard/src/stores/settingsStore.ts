import { create } from 'zustand';

interface SettingsState {
  userName: string;
  notificationsEnabled: boolean;
  executionPanelEnabled: boolean;
  connectedApps: string[];
  setUserName: (name: string) => void;
  setNotifications: (enabled: boolean) => void;
  setExecutionPanel: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  userName: 'Tim',
  notificationsEnabled: true,
  executionPanelEnabled: false,
  connectedApps: ['Microsoft Excel', 'Google Chrome', 'PayrollPro'],
  setUserName: (name) => set({ userName: name }),
  setNotifications: (enabled) => set({ notificationsEnabled: enabled }),
  setExecutionPanel: (enabled) => set({ executionPanelEnabled: enabled }),
}));
