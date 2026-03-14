import { useMemo } from 'react';
import { useLogbookStore } from '../../stores/logbookStore';
import { LogbookFilters } from './LogbookFilters';
import { LogbookTimeline } from './LogbookTimeline';
import { AuditReportExport } from './AuditReportExport';
import styles from './LogbookView.module.css';

export function LogbookView() {
  const allEntries = useLogbookStore((s) => s.entries);
  const filters = useLogbookStore((s) => s.filters);
  const entries = useMemo(() => {
    return allEntries.filter((entry) => {
      if (filters.workflow && entry.workflowName !== filters.workflow) return false;
      if (filters.department && entry.department !== filters.department) return false;
      if (filters.status && entry.result !== filters.status) return false;
      if (filters.employee && !entry.entityId.includes(filters.employee)) return false;
      if (filters.dateFrom && entry.timestamp < new Date(filters.dateFrom)) return false;
      if (filters.dateTo && entry.timestamp > new Date(filters.dateTo)) return false;
      return true;
    });
  }, [allEntries, filters]);

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
