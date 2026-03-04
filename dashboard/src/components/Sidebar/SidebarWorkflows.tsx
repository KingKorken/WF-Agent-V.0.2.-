import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './SidebarWorkflows.module.css';

export function SidebarWorkflows() {
  const { workflows, expandedWorkflowId, setExpandedWorkflow } = useWorkflowStore();

  // Get starred workflows (active ones)
  const starredWorkflows = workflows.filter((w) => w.status === 'active').slice(0, 3);

  return (
    <div className={styles.starredCard}>
      <p className={styles.starredTitle}>Starred Workflows</p>
      {starredWorkflows.map((w) => (
        <button
          key={w.id}
          type="button"
          className={`${styles.starredItem} ${expandedWorkflowId === w.id ? styles.starredItemHighlight : ''}`}
          onClick={() => setExpandedWorkflow(expandedWorkflowId === w.id ? null : w.id)}
        >
          {w.department} - {w.name}
        </button>
      ))}
    </div>
  );
}
