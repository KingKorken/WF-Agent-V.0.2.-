import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './WorkflowProgress.module.css';

export function WorkflowProgress() {
  const queue = useWorkflowStore((s) => s.queue);
  const executingWorkflow = useWorkflowStore((s) => s.executingWorkflow);

  if (queue.length === 0) return null;

  // TODO: derive from executingWorkflow.progress when backend integration lands
  const progress = executingWorkflow ? 77 : 0;

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
