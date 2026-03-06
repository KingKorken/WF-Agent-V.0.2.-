import { useState } from 'react';
import { useWorkflowStore } from '../../stores/workflowStore';
import { useConnectionStore } from '../../stores/connectionStore';
import styles from './WorkflowDetail.module.css';

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export function WorkflowDetail() {
  const workflow = useWorkflowStore((s) => s.selectedWorkflow);
  const runWorkflow = useWorkflowStore((s) => s.runWorkflow);
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow);
  const agentConnected = useConnectionStore((s) => s.agentConnected);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (!workflow) return null;

  const id = workflow.id as string;
  const name = (workflow.name as string) || 'Untitled';
  const description = (workflow.description as string) || '';
  const createdAt = (workflow.createdAt as string) || '';
  const applications = Array.isArray(workflow.applications) ? workflow.applications : [];
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];

  const handleDelete = () => {
    deleteWorkflow(id);
    setConfirmingDelete(false);
  };

  return (
    <div className={styles.detail}>
      <h2 className={styles.name}>{name}</h2>
      {description && <p className={styles.description}>{description}</p>}
      {createdAt && <p className={styles.meta}>Created {formatDate(createdAt)}</p>}

      <div className={styles.stats}>
        <span className={styles.stat}>{steps.length} steps</span>
        {applications.length > 0 && (
          <span className={styles.stat}>
            {(applications as Array<{ name?: string }>).map((a) => a.name || 'Unknown').join(', ')}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        <button
          className={styles.runButton}
          onClick={() => runWorkflow(id)}
          disabled={!agentConnected}
        >
          {agentConnected ? 'Run workflow' : 'Agent not connected'}
        </button>
        {!confirmingDelete ? (
          <button
            className={styles.deleteButton}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
        ) : (
          <div className={styles.confirmDialog}>
            <p className={styles.confirmText}>
              Delete "{name}"? This action cannot be undone.
            </p>
            <div className={styles.confirmActions}>
              <button className={styles.confirmYes} onClick={handleDelete}>
                Delete
              </button>
              <button
                className={styles.confirmNo}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
