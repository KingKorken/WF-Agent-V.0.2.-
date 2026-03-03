import { create } from 'zustand';

const SETTINGS_KEY = 'wfa-settings';

interface Settings {
  userName: string;
  notificationsEnabled: boolean;
  executionPanelEnabled: boolean;
  connectedApps: string[];
}

interface SettingsState extends Settings {
  setUserName: (name: string) => void;
  setNotifications: (enabled: boolean) => void;
  setExecutionPanel: (enabled: boolean) => void;
}

const DEFAULTS: Settings = {
  userName: 'Tim',
  notificationsEnabled: true,
  executionPanelEnabled: false,
  connectedApps: ['Microsoft Excel', 'Google Chrome', 'PayrollPro'],
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // Corrupted data — use defaults
  }
  return DEFAULTS;
}

function saveSettings(state: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      userName: state.userName,
      notificationsEnabled: state.notificationsEnabled,
      executionPanelEnabled: state.executionPanelEnabled,
      connectedApps: state.connectedApps,
    }));
  } catch {
    // localStorage full or unavailable — fail silently
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...loadSettings(),

  setUserName: (name) =>
    set((state) => {
      const next = { ...state, userName: name };
      saveSettings(next);
      return { userName: name };
    }),

  setNotifications: (enabled) =>
    set((state) => {
      const next = { ...state, notificationsEnabled: enabled };
      saveSettings(next);
      return { notificationsEnabled: enabled };
    }),

  setExecutionPanel: (enabled) =>
    set((state) => {
      const next = { ...state, executionPanelEnabled: enabled };
      saveSettings(next);
      return { executionPanelEnabled: enabled };
    }),
}));
