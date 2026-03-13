import { useRef, useCallback } from 'react';
import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './SidebarWorkflows.module.css';

export function SidebarWorkflows() {
  const workflows = useWorkflowStore((s) => s.workflows);
  const queue = useWorkflowStore((s) => s.queue);
  const expandedWorkflowId = useWorkflowStore((s) => s.expandedWorkflowId);
  const setExpandedWorkflow = useWorkflowStore((s) => s.setExpandedWorkflow);
  const runWorkflow = useWorkflowStore((s) => s.runWorkflow);
  const cancelWorkflow = useWorkflowStore((s) => s.cancelWorkflow);

  // Cooldown ref to prevent rapid stop clicks
  const cooldownRef = useRef(false);

  const handleStop = useCallback((workflowId: string) => {
    if (cooldownRef.current) return;
    cooldownRef.current = true;
    cancelWorkflow(workflowId);
    setTimeout(() => { cooldownRef.current = false; }, 500);
  }, [cancelWorkflow]);

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
                  {isQueued ? (
                    <button
                      type="button"
                      className={`${styles.startButton} ${styles.stopButton}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStop(w.id);
                      }}
                    >
                      Stop
                      <span className={styles.startIndicator}>
                        <svg className={styles.startRing} viewBox="0 0 23 23" fill="none">
                          <circle cx="11.5" cy="11.5" r="10.5" stroke="var(--color-error)" strokeWidth="2" />
                        </svg>
                        <svg
                          style={{ position: 'absolute', top: 6, left: 6 }}
                          width="11"
                          height="11"
                          viewBox="0 0 11 11"
                          fill="none"
                        >
                          <rect width="11" height="11" rx="2" fill="var(--color-error)" />
                        </svg>
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.startButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        runWorkflow(w.id);
                      }}
                    >
                      Start
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
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
