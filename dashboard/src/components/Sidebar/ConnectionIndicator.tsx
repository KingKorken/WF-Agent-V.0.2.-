import { useConnectionStore } from '../../stores/connectionStore';
import styles from './ConnectionIndicator.module.css';

export function ConnectionIndicator() {
  const status = useConnectionStore((s) => s.status);
  const agentConnected = useConnectionStore((s) => s.agentConnected);
  const agentName = useConnectionStore((s) => s.agentName);

  // Determine state: grey (disconnected), yellow (bridge only), green (agent online)
  let color: 'grey' | 'yellow' | 'green';
  let label: string;

  if (status !== 'connected') {
    color = 'grey';
    label = status === 'connecting' ? 'Connecting...' : 'Disconnected';
  } else if (!agentConnected) {
    color = 'yellow';
    label = 'Waiting for agent';
  } else {
    color = 'green';
    label = agentName ?? 'Agent online';
  }

  return (
    <div className={styles.indicator}>
      <span className={`${styles.dot} ${styles[color]}`} />
      <span className={styles.label}>{label}</span>
    </div>
  );
}
