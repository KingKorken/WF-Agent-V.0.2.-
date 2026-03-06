import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TabBar } from './components/TabBar/TabBar';
import { QueuePanel } from './components/QueuePanel/QueuePanel';
import { ChatView } from './components/Chat/ChatView';
import { LogbookView } from './components/Logbook/LogbookView';
import { RecordView } from './components/Record/RecordView';
import { SettingsView } from './components/Settings/SettingsView';
import { CalendarView } from './components/Calendar/CalendarView';
import { EmailView } from './components/Email/EmailView';
import { WorkflowLibraryView } from './components/WorkflowLibrary/WorkflowLibraryView';
import { ConnectionBanner } from './components/shared/ConnectionBanner';
import { OnboardingOverlay } from './components/Onboarding/OnboardingOverlay';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTabStore } from './stores/tabStore';
import { useWorkflowStore } from './stores/workflowStore';
import { initMessageRouter } from './services/message-router';
import styles from './App.module.css';

export function App() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const openTab = useTabStore((s) => s.openTab);
  const queue = useWorkflowStore((s) => s.queue);
  const hasQueue = queue.length >= 2;
  const [sidebarVisible, setSidebarVisible] = useState(true);

  useKeyboardShortcuts();

  // Restore tab from URL hash on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1);
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

  // Initialize WebSocket connection and message routing
  useEffect(() => {
    initMessageRouter();
  }, []);

  return (
    <>
      {/* Top navigation bar spanning full width */}
      <div className={styles.navBar}>
        <div className={styles.navControls}>
          {/* Sidebar collapse toggle */}
          <button
            className={styles.navButton}
            onClick={() => setSidebarVisible(!sidebarVisible)}
            aria-label={sidebarVisible ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
              <rect x="0.5" y="0.5" width="15" height="11" rx="1.5" stroke="black" />
              <line x1="5.21" x2="5.21" y1="12" y2="0" stroke="black" />
            </svg>
          </button>
          {/* Back */}
          <button
            className={styles.navButton}
            onClick={() => window.history.back()}
            aria-label="Go back"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M12.5 15L7.5 10L12.5 5" stroke="black" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.67" strokeOpacity="0.9" />
            </svg>
          </button>
          {/* Forward */}
          <button
            className={styles.navButton}
            onClick={() => window.history.forward()}
            aria-label="Go forward"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M7.5 15L12.5 10L7.5 5" stroke="#838383" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.67" strokeOpacity="0.9" />
            </svg>
          </button>
        </div>
        <div className={styles.navTabArea}>
          <TabBar />
        </div>
      </div>

      {/* Main content area */}
      <div
        className={styles.root}
        data-has-queue={hasQueue}
        data-sidebar-hidden={!sidebarVisible || undefined}
      >
        {sidebarVisible && <Sidebar />}
        {hasQueue && <QueuePanel />}
        <div className={styles.canvasWrapper}>
          <ConnectionBanner />
          <div className={styles.canvas}>
            {activeTabId === 'workspace' && <ChatView />}
            {activeTabId === 'logbook' && <LogbookView />}
            {activeTabId === 'record' && <RecordView />}
            {activeTabId === 'settings' && <SettingsView />}
            {activeTabId === 'calendar' && <CalendarView />}
            {activeTabId === 'email' && <EmailView />}
            {activeTabId === 'workflow-library' && <WorkflowLibraryView />}
          </div>
        </div>
        <OnboardingOverlay />
      </div>
    </>
  );
}
