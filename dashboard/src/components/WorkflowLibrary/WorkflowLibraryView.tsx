import { useEffect } from 'react';
import { useWorkflowStore } from '../../stores/workflowStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { WorkflowCard } from './WorkflowCard';
import { WorkflowDetail } from './WorkflowDetail';
import styles from './WorkflowLibraryView.module.css';

export function WorkflowLibraryView() {
  const workflows = useWorkflowStore((s) => s.workflows);
  const loading = useWorkflowStore((s) => s.loading);
  const selectedWorkflow = useWorkflowStore((s) => s.selectedWorkflow);
  const fetchWorkflows = useWorkflowStore((s) => s.fetchWorkflows);
  const fetchWorkflowDetail = useWorkflowStore((s) => s.fetchWorkflowDetail);
  const agentConnected = useConnectionStore((s) => s.agentConnected);

  useEffect(() => {
    if (agentConnected) {
      fetchWorkflows();
    }
  }, [agentConnected]);

  const selectedId = selectedWorkflow ? (selectedWorkflow as { id?: string }).id : null;

  // Agent not connected
  if (!agentConnected) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <h2 className={styles.title}>Workflow Library</h2>
          <p className={styles.subtitle}>
            Connect the local agent to view your workflows.
          </p>
        </div>
      </div>
    );
  }

  // Loading
  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <h2 className={styles.title}>Workflow Library</h2>
          <p className={styles.subtitle}>Loading workflows...</p>
        </div>
      </div>
    );
  }

  // Empty library
  if (workflows.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <h2 className={styles.title}>Workflow Library</h2>
          <p className={styles.subtitle}>
            No workflows yet — record your first workflow to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h2 className={styles.title}>Workflow Library</h2>
        <span className={styles.count}>{workflows.length} workflow{workflows.length !== 1 ? 's' : ''}</span>
      </div>
      <div className={styles.list}>
        {workflows.map((w) => (
          <WorkflowCard
            key={w.id}
            workflow={w}
            selected={w.id === selectedId}
            onClick={() => fetchWorkflowDetail(w.id)}
          />
        ))}
      </div>
      {selectedWorkflow && <WorkflowDetail />}
    </div>
  );
}
