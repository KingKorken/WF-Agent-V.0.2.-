import type { QueuedWorkflow } from '../../stores/workflowStore';
import styles from './QueueTile.module.css';

interface QueueTileProps {
  item: QueuedWorkflow;
}

export function QueueTile({ item }: QueueTileProps) {
  const isExecuting = item.position === 0;

  return (
    <div className={`${styles.tile} ${isExecuting ? styles.executing : ''}`}>
      <p className={styles.name}>{item.name}</p>
      <p className={styles.progress}>{item.progress}</p>
      <p className={styles.step}>{item.currentStep}</p>
    </div>
  );
}
