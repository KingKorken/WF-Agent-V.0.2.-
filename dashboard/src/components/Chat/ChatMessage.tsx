import { useState } from 'react';
import type { ChatMessage as ChatMessageType, AgentLogEntry, AgentPhase } from '../../stores/chatStore';
import { useChatStore } from '../../stores/chatStore';
import styles from './ChatMessage.module.css';

const PHASE_LABELS: Record<AgentPhase, string> = {
  step: 'STEP',
  observing: 'OBSERVE',
  thinking: 'THINK',
  parsed: 'DECIDE',
  executing: 'EXEC',
  action_result: 'RESULT',
  complete: 'DONE',
  needs_help: 'HELP',
  error: 'ERROR',
};

function formatElapsed(entryTimestamp: string, firstTimestamp: string): string {
  const elapsed = (new Date(entryTimestamp).getTime() - new Date(firstTimestamp).getTime()) / 1000;
  return `+${elapsed.toFixed(1)}s`;
}

function formatDuration(entries: AgentLogEntry[]): string {
  if (entries.length < 2) return '';
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const totalMs = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
  return `${(totalMs / 1000).toFixed(1)}s`;
}

interface ChatMessageProps {
  message: ChatMessageType;
  conversationId: string;
  onRetry?: (messageId: string) => void;
}

export function ChatMessage({ message, conversationId, onRetry }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const [logExpanded, setLogExpanded] = useState(false);

  if (message.type === 'activity-log' && message.logEntries) {
    const entries = message.logEntries;
    const firstTimestamp = entries[0]?.timestamp ?? '';
    const duration = formatDuration(entries);
    const stepCount = entries[entries.length - 1]?.step || 0;
    const iterationCount = entries.filter((e) => e.phase === 'step').length;
    const totalMs = entries.length >= 2
      ? new Date(entries[entries.length - 1]!.timestamp).getTime() - new Date(entries[0]!.timestamp).getTime()
      : 0;
    const avgPerIteration = iterationCount > 0 ? (totalMs / 1000 / iterationCount).toFixed(1) : '0';

    return (
      <div className={styles.message} data-type="activity-log">
        <div className={styles.activityLogCard}>
          <button
            className={styles.activityLogHeader}
            onClick={() => setLogExpanded(!logExpanded)}
            type="button"
          >
            <span className={styles.activityLogTitle}>
              Agent activity — {stepCount} steps{duration ? ` in ${duration}` : ''}
            </span>
            <span className={styles.activityLogToggle}>{logExpanded ? 'Collapse' : 'Expand'}</span>
          </button>
          {logExpanded && (
            <div className={styles.activityLogBody}>
              {entries.map((entry, i) => {
                const label = PHASE_LABELS[entry.phase] || entry.phase.toUpperCase();
                const isError = entry.phase === 'error';
                const isComplete = entry.phase === 'complete';
                return (
                  <div
                    key={i}
                    className={`${styles.activityLogEntry} ${isError ? styles.activityLogEntryError : ''} ${isComplete ? styles.activityLogEntryComplete : ''}`}
                  >
                    <span className={styles.activityLogTime}>{formatElapsed(entry.timestamp, firstTimestamp)}</span>
                    <span className={styles.activityLogLabel}>{label}</span>
                    <span className={styles.activityLogMsg}>{entry.message}</span>
                    {entry.detail && <span className={styles.activityLogDetail}>{entry.detail}</span>}
                  </div>
                );
              })}
              <div className={styles.activityLogSummary}>
                Total: {duration || '0s'} | {iterationCount} iterations | {avgPerIteration} s/iteration avg
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.type === 'action-preview') {
    return (
      <div className={styles.message} data-type="action-preview">
        <div className={styles.previewCard}>
          <div className={styles.previewHeader}>
            Action plan
          </div>
          <p className={styles.previewBody}>{message.content}</p>
          <div className={styles.previewActions}>
            <button
              className={styles.previewProceed}
              onClick={() => {
                if (message.previewId) {
                  useChatStore.getState().confirmAction(message.previewId, conversationId);
                }
              }}
            >
              Proceed
            </button>
            <button
              className={styles.previewCancel}
              onClick={() => {
                if (message.previewId) {
                  useChatStore.getState().cancelAction(message.previewId, conversationId);
                }
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (message.type === 'error') {
    return (
      <div className={styles.message} data-type="error">
        <div className={styles.errorCard}>
          <div className={styles.errorHeader}>
            Something went wrong
          </div>
          <p className={styles.errorBody}>{message.content}</p>
          {message.suggestion && (
            <div className={styles.errorSuggestion}>
              <span className={styles.errorSuggestionLabel}>Agent suggests:</span>
              <span>{message.suggestion}</span>
            </div>
          )}
          <div className={styles.errorActions}>
            <button
              className={styles.errorRetry}
              onClick={() => onRetry?.(message.id)}
            >
              Retry
            </button>
            <span className={styles.errorOr}>or type a different instruction below</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.message} ${isUser ? styles.user : styles.agent}`}>
      <div className={styles.content}>{message.content}</div>
    </div>
  );
}
