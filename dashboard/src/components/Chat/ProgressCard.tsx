import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './ProgressCard.module.css';

export function ProgressCard() {
  const queue = useWorkflowStore((s) => s.queue);
  const executing = queue.find((q) => q.position === 0);

  if (!executing) return null;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.name}>{executing.name}</span>
        <span className={styles.progress}>{executing.progress}</span>
      </div>
      <p className={styles.step}>{executing.currentStep}</p>
    </div>
  );
}
