import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './SidebarWorkflows.module.css';

export function SidebarWorkflows() {
  const { workflows, queue, expandedWorkflowId, setExpandedWorkflow, runWorkflow } = useWorkflowStore();

  // Show the first 3 workflows
  const starredWorkflows = workflows.slice(0, 3);

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
              {w.name}
            </button>
            {isExpanded && (
              <div className={styles.workflowActions}>
                <p className={styles.workflowDescription}>{w.description}</p>
                <div className={styles.startRow}>
                  <button
                    type="button"
                    className={styles.startButton}
                    disabled={isQueued}
                    onClick={(e) => {
                      e.stopPropagation();
                      runWorkflow(w.id);
                    }}
                  >
                    {isQueued ? 'Running...' : 'Start'}
                    <span className={styles.startIndicator}>
                      <svg className={styles.startRing} viewBox="0 0 23 23" fill="none">
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
