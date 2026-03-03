import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useTabStore } from '../stores/tabStore';

export function useKeyboardShortcuts() {
  const newConversation = useChatStore((s) => s.newConversation);
  const { openTab, closeTab, activeTabId } = useTabStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        // Exception: Escape should still work from inputs
        if (e.key !== 'Escape') return;
      }

      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + N → New conversation
      if (mod && e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        newConversation();
        // Ensure we're on the Workspace tab
        useTabStore.getState().setActiveTab('workspace');
      }

      // Cmd/Ctrl + Shift + R → New workflow (record)
      if (mod && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        openTab({ id: 'record', label: 'Record', closable: true });
      }

      // Escape → Close active tab (if not Workspace)
      if (e.key === 'Escape') {
        if (activeTabId !== 'workspace') {
          e.preventDefault();
          closeTab(activeTabId);
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [newConversation, openTab, closeTab, activeTabId]);
}
