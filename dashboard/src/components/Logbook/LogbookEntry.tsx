import type { AuditEntry } from '../../stores/logbookStore';
import styles from './LogbookEntry.module.css';

interface LogbookEntryProps {
  entry: AuditEntry;
  isExpanded: boolean;
  onToggle: () => void;
}

export function LogbookEntry({ entry, isExpanded, onToggle }: LogbookEntryProps) {
  const time = entry.timestamp.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const date = entry.timestamp.toLocaleDateString('en-GB');

  return (
    <div className={styles.entry} data-result={entry.result}>
      <button
        className={styles.summary}
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={`${entry.action} — ${entry.result}. Click to ${isExpanded ? 'collapse' : 'expand'} details.`}
      >
        <span className={styles.time}>{time}</span>
        <span className={styles.action}>{entry.action}</span>
        <span className={styles.entity}>{entry.entityId}</span>
        <span className={styles.layer}>{entry.controlLayer}</span>
        <span className={styles.result} data-result={entry.result}>
          {entry.result}
        </span>
      </button>
      {isExpanded && (
        <div className={styles.detail}>
          <div className={styles.field}>
            <span className={styles.label}>Date:</span> {date}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>User:</span> {entry.userId}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Timezone:</span> {entry.timezone}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Action:</span> {entry.action}
          </div>
          {entry.originalValue !== null && (
            <div className={styles.field}>
              <span className={styles.label}>Original value:</span>{' '}
              {entry.originalValue || '(empty)'}
            </div>
          )}
          {entry.newValue !== null && (
            <div className={styles.field}>
              <span className={styles.label}>New value:</span> {entry.newValue}
            </div>
          )}
          <div className={styles.field}>
            <span className={styles.label}>Justification:</span> {entry.justification}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Entity:</span> {entry.entityId} ({entry.entityType})
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Workflow:</span> {entry.workflowName} (
            {entry.department})
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Source:</span> {entry.source.device} (
            {entry.source.ip})
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Session:</span> {entry.source.sessionId}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Control layer:</span> {entry.controlLayer}
          </div>
        </div>
      )}
    </div>
  );
}
