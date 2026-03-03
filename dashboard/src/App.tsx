import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TabBar } from './components/TabBar/TabBar';
import { QueuePanel } from './components/QueuePanel/QueuePanel';
import { ChatView } from './components/Chat/ChatView';
import { LogbookView } from './components/Logbook/LogbookView';
import { RecordView } from './components/Record/RecordView';
import { SettingsView } from './components/Settings/SettingsView';
import { ConnectionBanner } from './components/shared/ConnectionBanner';
import { OnboardingOverlay } from './components/Onboarding/OnboardingOverlay';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTabStore } from './stores/tabStore';
import { useWorkflowStore } from './stores/workflowStore';
import { wsService } from './services/websocket';
import styles from './App.module.css';

export function App() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const openTab = useTabStore((s) => s.openTab);
  const queue = useWorkflowStore((s) => s.queue);
  const hasQueue = queue.length >= 2;

  useKeyboardShortcuts();

  // Restore tab from URL hash on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1); // e.g. "#logbook"
    if (hash && hash !== 'workspace') {
      openTab({
        id: hash,
        label: hash.charAt(0).toUpperCase() + hash.slice(1),
        closable: true,
      });
    }
  }, []);

  // Persist active tab to URL hash
  useEffect(() => {
    window.location.hash = activeTabId === 'workspace' ? '' : activeTabId;
  }, [activeTabId]);

  // WebSocket auto-connect
  useEffect(() => {
    wsService.connect();
    return () => wsService.disconnect();
  }, []);

  return (
    <div className={styles.root} data-has-queue={hasQueue}>
      <Sidebar />
      {hasQueue && <QueuePanel />}
      <div className={styles.canvasWrapper}>
        <ConnectionBanner />
        <TabBar />
        <div className={styles.canvas}>
          {activeTabId === 'workspace' && <ChatView />}
          {activeTabId === 'logbook' && <LogbookView />}
          {activeTabId === 'record' && <RecordView />}
          {activeTabId === 'settings' && <SettingsView />}
          {activeTabId === 'email' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <p style={{ color: 'var(--color-text-secondary)', opacity: 0.6 }}>Email integration coming soon.</p>
            </div>
          )}
        </div>
      </div>
      <OnboardingOverlay />
    </div>
  );
}
