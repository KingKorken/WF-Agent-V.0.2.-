import { useState } from 'react';
import { useWorkflowStore } from '../../stores/workflowStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { RecordingTip } from './RecordingTip';
import styles from './RecordView.module.css';

export function RecordView() {
  const [workflowName, setWorkflowName] = useState('');

  const recordingState = useWorkflowStore((s) => s.recordingState);
  const recordingError = useWorkflowStore((s) => s.recordingError);
  const startRecording = useWorkflowStore((s) => s.startRecording);
  const stopRecording = useWorkflowStore((s) => s.stopRecording);
  const setRecordingState = useWorkflowStore((s) => s.setRecordingState);
  const executingWorkflow = useWorkflowStore((s) => s.executingWorkflow);
  const agentConnected = useConnectionStore((s) => s.agentConnected);

  const handleStart = () => {
    if (!workflowName.trim() || !agentConnected) return;
    startRecording(workflowName.trim());
  };

  const handleStop = () => {
    stopRecording();
  };

  const handleRecordAnother = () => {
    setRecordingState('idle');
    setWorkflowName('');
  };

  if (recordingState === 'idle' && executingWorkflow) {
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

  if (recordingState === 'idle') {
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
              disabled={!workflowName.trim() || !agentConnected}
            >
              {agentConnected ? 'Start Recording' : 'Connect local agent to record'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (recordingState === 'recording') {
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

  if (recordingState === 'parsing') {
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

  if (recordingState === 'error') {
    return (
      <div className={styles.root}>
        <div className={styles.centered}>
          <h2 className={styles.title}>Processing failed</h2>
          <p className={styles.subtitle}>
            {recordingError || 'Recording saved — try again later.'}
          </p>
          <button className={styles.startButton} onClick={handleRecordAnother}>
            Record another
          </button>
        </div>
      </div>
    );
  }

  // recordingState === 'complete'
  return (
    <div className={styles.root}>
      <div className={styles.centered}>
        <h2 className={styles.title}>Workflow saved!</h2>
        <p className={styles.subtitle}>
          "{workflowName}" has been added to your library. You can now ask the agent to run it.
        </p>
        <button className={styles.startButton} onClick={handleRecordAnother}>
          Record another
        </button>
      </div>
    </div>
  );
}
