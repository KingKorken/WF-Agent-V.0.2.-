import type { WorkflowSummary } from '@shared/types';
import styles from './WorkflowCard.module.css';

interface WorkflowCardProps {
  workflow: WorkflowSummary;
  selected: boolean;
  onClick: () => void;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function WorkflowCard({ workflow, selected, onClick }: WorkflowCardProps) {
  return (
    <button
      className={`${styles.card} ${selected ? styles.selected : ''}`}
      onClick={onClick}
    >
      <span className={styles.name}>{workflow.name}</span>
      <span className={styles.date}>{formatDate(workflow.createdAt)}</span>
    </button>
  );
}
