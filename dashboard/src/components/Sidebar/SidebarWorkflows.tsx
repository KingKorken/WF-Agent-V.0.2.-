import { useWorkflowStore } from '../../stores/workflowStore';
import { useConnectionStore } from '../../stores/connectionStore';
import styles from './SidebarWorkflows.module.css';

export function SidebarWorkflows() {
  const { workflows, queue, expandedWorkflowId, setExpandedWorkflow, runWorkflow } = useWorkflowStore();
  const agentConnected = useConnectionStore((s) => s.agentConnected);

  // Get starred workflows (active ones)
  const starredWorkflows = workflows.filter((w) => w.status === 'active').slice(0, 3);

  return (
    <div className={styles.starredCard}>
      <p className={styles.starredTitle}>Starred Workflows</p>
      {starredWorkflows.map((w) => {
        const isExpanded = expandedWorkflowId === w.id;
        const isQueued = queue.some((q) => q.workflowId === w.id);

        return (
          <div key={w.id}>
            <button
              type="button"
              className={`${styles.starredItem} ${isExpanded ? styles.starredItemHighlight : ''}`}
              onClick={() => setExpandedWorkflow(isExpanded ? null : w.id)}
            >
              {w.department} - {w.name}
            </button>
            {isExpanded && (
              <div className={styles.workflowActions}>
                <p className={styles.workflowDescription}>{w.description}</p>
                <button
                  type="button"
                  className={styles.runButton}
                  disabled={!agentConnected || isQueued}
                  onClick={(e) => {
                    e.stopPropagation();
                    runWorkflow(w.id);
                  }}
                >
                  {isQueued ? 'Running...' : 'Run'}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
