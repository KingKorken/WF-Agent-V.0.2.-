import { useState } from 'react';
import { useWorkflowStore } from '../../stores/workflowStore';
import { RecordingTip } from './RecordingTip';
import styles from './RecordView.module.css';

type RecordState = 'idle' | 'recording' | 'processing' | 'complete';

export function RecordView() {
  const [state, setState] = useState<RecordState>('idle');
  const [workflowName, setWorkflowName] = useState('');
  const executingWorkflow = useWorkflowStore((s) => s.executingWorkflow);

  const handleStart = () => {
    if (!workflowName.trim()) return;
    setState('recording');
    // TODO: Send WebSocket command to Local Agent to start recording
  };

  const handleStop = () => {
    setState('processing');
    // TODO: Send WebSocket command to stop recording
    // Simulate processing
    setTimeout(() => setState('complete'), 2000);
  };

  if (state === 'idle' && executingWorkflow) {
    return (
      <div className={styles.root}>
        <div className={styles.centered}>
          <h2 className={styles.title}>Recording unavailable</h2>
          <p className={styles.subtitle}>
            A workflow is currently running ({executingWorkflow.name}).
            Please wait for it to complete or cancel it before recording.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'idle') {
    return (
      <div className={styles.root}>
        <div className={styles.centered}>
          <h2 className={styles.title}>Record a new workflow</h2>
          <p className={styles.subtitle}>
            Name your workflow, then switch to your applications and perform the task.
          </p>
          <div className={styles.inputGroup}>
            <input
              className={styles.nameInput}
              type="text"
              placeholder="Workflow name"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
              autoFocus
            />
            <button
              className={styles.startButton}
              onClick={handleStart}
              disabled={!workflowName.trim()}
            >
              Start Recording
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'recording') {
    return (
      <div className={styles.root}>
        <div className={styles.centered}>
          <div className={styles.recordingDot} />
          <h2 className={styles.title}>Recording: {workflowName}</h2>
          <p className={styles.subtitle}>
            Switch to your applications and perform the workflow.
            Describe what you're doing as you go — it helps the agent learn faster.
          </p>
          <RecordingTip />
          <button className={styles.stopButton} onClick={handleStop}>
            Stop Recording
          </button>
        </div>
      </div>
    );
  }

  if (state === 'processing') {
    return (
      <div className={styles.root}>
        <div className={styles.centered}>
          <h2 className={styles.title}>Processing recording...</h2>
          <p className={styles.subtitle}>
            The agent is analyzing your workflow. This may take a moment.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.centered}>
        <h2 className={styles.title}>Workflow saved!</h2>
        <p className={styles.subtitle}>
          "{workflowName}" has been added to your library. You can now ask the agent to run it.
        </p>
        <button
          className={styles.startButton}
          onClick={() => { setState('idle'); setWorkflowName(''); }}
        >
          Record another
        </button>
      </div>
    </div>
  );
}
