import { useTabStore } from '../../stores/tabStore';
import styles from './SidebarNewWorkflow.module.css';

export function SidebarNewWorkflow() {
  const openTab = useTabStore((s) => s.openTab);

  return (
    <div className={styles.wrapper}>
      <span className={styles.label}>Record a new Workflow</span>
      <button
        className={styles.button}
        onClick={() => openTab({ id: 'record', label: 'Record', closable: true })}
      >
        Start Recording
        <span className={styles.recordIndicator}>
          <svg className={styles.recordRing} viewBox="0 0 23 23" fill="none">
            <circle cx="11.5" cy="11.5" r="10.5" stroke="#EC8D00" strokeWidth="2" />
          </svg>
          <svg
            style={{ position: 'absolute', top: 5, left: 5 }}
            width="13"
            height="13"
            viewBox="0 0 13 13"
            fill="none"
          >
            <circle cx="6.5" cy="6.5" r="6.5" fill="#EC8D00" />
          </svg>
        </span>
      </button>
    </div>
  );
}
