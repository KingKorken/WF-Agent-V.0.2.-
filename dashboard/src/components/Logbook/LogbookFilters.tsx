import { useLogbookStore } from '../../stores/logbookStore';
import styles from './LogbookFilters.module.css';

export function LogbookFilters() {
  const { filters, setFilter, clearFilters } = useLogbookStore();

  return (
    <div className={styles.filters}>
      <input
        type="date"
        className={styles.input}
        value={filters.dateFrom || ''}
        onChange={(e) => setFilter('dateFrom', e.target.value || null)}
        placeholder="From"
      />
      <input
        type="date"
        className={styles.input}
        value={filters.dateTo || ''}
        onChange={(e) => setFilter('dateTo', e.target.value || null)}
        placeholder="To"
      />
      <select
        className={styles.select}
        value={filters.department || ''}
        onChange={(e) => setFilter('department', e.target.value || null)}
      >
        <option value="">All departments</option>
        <option value="HR">HR</option>
        <option value="Controlling">Controlling</option>
        <option value="Procurement">Procurement</option>
      </select>
      <select
        className={styles.select}
        value={filters.status || ''}
        onChange={(e) => setFilter('status', e.target.value || null)}
      >
        <option value="">All statuses</option>
        <option value="success">Success</option>
        <option value="failure">Failure</option>
      </select>
      {Object.values(filters).some(Boolean) && (
        <button className={styles.clear} onClick={clearFilters}>
          Clear
        </button>
      )}
    </div>
  );
}
