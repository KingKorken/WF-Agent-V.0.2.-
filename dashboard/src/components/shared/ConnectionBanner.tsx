import { useConnectionStore } from '../../stores/connectionStore';
import styles from './ConnectionBanner.module.css';

export function ConnectionBanner() {
  const status = useConnectionStore((s) => s.status);
  const hasConnectedOnce = useConnectionStore((s) => s.hasConnectedOnce);

  // Don't show banner if connected
  if (status === 'connected') return null;

  // Don't show banner if we never connected (e.g. deployed on Vercel with no bridge server)
  if (!hasConnectedOnce) return null;

  const message =
    status === 'connecting'
      ? 'Reconnecting...'
      : status === 'error'
        ? 'Connection error. Retrying...'
        : 'Connection lost. Reconnecting...';

  return (
    <div className={styles.banner}>
      {message}
    </div>
  );
}
