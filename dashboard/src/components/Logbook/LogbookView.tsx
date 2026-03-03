import { useLogbookStore } from '../../stores/logbookStore';
import { LogbookFilters } from './LogbookFilters';
import { LogbookTimeline } from './LogbookTimeline';
import { AuditReportExport } from './AuditReportExport';
import styles from './LogbookView.module.css';

export function LogbookView() {
  const entries = useLogbookStore((s) => s.getFilteredEntries());

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <LogbookFilters />
        <AuditReportExport />
      </div>
      {entries.length === 0 ? (
        <div className={styles.empty}>
          <p>No activity recorded yet. Executed workflows will appear here.</p>
        </div>
      ) : (
        <LogbookTimeline entries={entries} />
      )}
    </div>
  );
}
