import { useConnectionStore } from '../../stores/connectionStore';
import styles from './ConnectionBanner.module.css';

export function ConnectionBanner() {
  const status = useConnectionStore((s) => s.status);

  if (status === 'connected') return null;

  const message =
    status === 'connecting'
      ? 'Connecting...'
      : status === 'error'
        ? 'Connection error. Retrying...'
        : 'Connection lost. Reconnecting...';

  return (
    <div className={styles.banner}>
      {message}
    </div>
  );
}
