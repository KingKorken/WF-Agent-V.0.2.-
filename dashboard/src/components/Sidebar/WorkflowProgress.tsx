import styles from './WorkflowProgress.module.css';

export function WorkflowProgress() {
  const progress = 77; // Mock progress — will come from store

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Workflow Schedule Progress</span>
        <span className={styles.percentage}>{progress}%</span>
      </div>
      <div className={styles.trackOuter}>
        <div className={styles.trackFill} style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
