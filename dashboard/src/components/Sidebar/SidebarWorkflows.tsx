import { useSidebarStore } from '../../stores/sidebarStore';
import { useWorkflowStore } from '../../stores/workflowStore';
import styles from './SidebarWorkflows.module.css';

export function SidebarWorkflows() {
  const { isWorkflowsExpanded, toggleWorkflows, expandedDepartments, toggleDepartment } = useSidebarStore();
  const { workflows, expandedWorkflowId, setExpandedWorkflow } = useWorkflowStore();

  // Group workflows by department
  const departments = [...new Set(workflows.map((w) => w.department))];

  return (
    <div>
      <button className={styles.toggle} onClick={toggleWorkflows}>
        <span className={styles.arrow}>
          {isWorkflowsExpanded ? '▾' : '▸'}
        </span>
        Workflows
      </button>
      {isWorkflowsExpanded && (
        <div className={styles.content}>
          {workflows.length === 0 ? (
            <p className={styles.empty}>No workflows yet. Click + New Workflow to teach the agent its first task.</p>
          ) : (
            departments.map((dept) => (
              <div key={dept} className={styles.department}>
                <button
                  className={styles.departmentToggle}
                  onClick={() => toggleDepartment(dept)}
                >
                  <span className={styles.arrow}>
                    {expandedDepartments.includes(dept) ? '▾' : '▸'}
                  </span>
                  {dept}
                </button>
                {expandedDepartments.includes(dept) && (
                  <div className={styles.cards}>
                    {workflows
                      .filter((w) => w.department === dept)
                      .map((workflow) => (
                        <div key={workflow.id} className={styles.card}>
                          <button
                            className={styles.cardHeader}
                            onClick={() =>
                              setExpandedWorkflow(
                                expandedWorkflowId === workflow.id ? null : workflow.id
                              )
                            }
                          >
                            <span className={styles.statusDot} data-status={workflow.status} />
                            <span className={styles.workflowName}>{workflow.name}</span>
                          </button>
                          {expandedWorkflowId === workflow.id && (
                            <div className={styles.cardDetail}>
                              <p className={styles.description}>{workflow.description}</p>
                              {workflow.lastRun && (
                                <p className={styles.lastRun}>
                                  Last run: {workflow.lastRun.toLocaleDateString()}
                                  {workflow.lastRunSuccess === false && ' (failed)'}
                                </p>
                              )}
                              <button className={styles.runAction}>Run</button>
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
