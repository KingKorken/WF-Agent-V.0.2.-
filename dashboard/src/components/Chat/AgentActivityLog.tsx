import { useRef, useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import type { AgentLogEntry, AgentPhase } from '../../stores/chatStore';
import styles from './AgentActivityLog.module.css';

const PHASE_LABELS: Record<AgentPhase, string> = {
  step: 'STEP',
  observing: 'OBSERVE',
  thinking: 'THINK',
  parsed: 'DECIDE',
  executing: 'EXEC',
  action_result: 'RESULT',
  complete: 'DONE',
  needs_help: 'HELP',
  error: 'ERROR',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--:--';
  }
}

function LogEntry({ entry }: { entry: AgentLogEntry }) {
  const label = PHASE_LABELS[entry.phase] || entry.phase.toUpperCase();
  const isError = entry.phase === 'error';
  const isComplete = entry.phase === 'complete';

  return (
    <div
      className={`${styles.entry} ${isError ? styles.entryError : ''} ${isComplete ? styles.entryComplete : ''}`}
    >
      <span className={styles.time}>{formatTime(entry.timestamp)}</span>
      <span className={`${styles.label} ${styles[`label_${entry.phase}`] || ''}`}>{label}</span>
      <span className={styles.msg}>{entry.message}</span>
      {entry.detail && <span className={styles.detail}>{entry.detail}</span>}
    </div>
  );
}

export function AgentActivityLog() {
  const agentLog = useChatStore((s) => s.agentLog);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentLog.length]);

  if (agentLog.length === 0) return null;

  const latestEntry = agentLog[agentLog.length - 1] as AgentLogEntry;
  const stepInfo = latestEntry.maxSteps > 0
    ? `Step ${latestEntry.step}/${latestEntry.maxSteps}`
    : '';

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Agent activity</span>
        {stepInfo && <span className={styles.headerStep}>{stepInfo}</span>}
      </div>
      <div className={styles.log}>
        {agentLog.map((entry, i) => (
          <LogEntry key={i} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
