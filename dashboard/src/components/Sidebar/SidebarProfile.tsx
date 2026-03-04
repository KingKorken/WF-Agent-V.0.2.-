import { useTabStore } from '../../stores/tabStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useConnectionStore } from '../../stores/connectionStore';
import styles from './SidebarProfile.module.css';

export function SidebarProfile() {
  const openTab = useTabStore((s) => s.openTab);
  const userName = useSettingsStore((s) => s.userName);
  const status = useConnectionStore((s) => s.status);
  const agentConnected = useConnectionStore((s) => s.agentConnected);
  const agentName = useConnectionStore((s) => s.agentName);

  // Connection state: grey (disconnected), yellow (bridge only), green (agent online)
  let dotColor: string;
  let statusLabel: string;

  if (status !== 'connected') {
    dotColor = styles.grey;
    statusLabel = status === 'connecting' ? 'Connecting...' : 'Disconnected';
  } else if (!agentConnected) {
    dotColor = styles.yellow;
    statusLabel = 'Waiting for agent';
  } else {
    dotColor = styles.green;
    statusLabel = agentName ?? 'Agent online';
  }

  return (
    <button
      className={styles.profile}
      onClick={() => openTab({ id: 'settings', label: 'Settings', closable: true })}
    >
      <div className={styles.avatar}>
        <svg viewBox="0 0 33 33" fill="none" width="33" height="33">
          <circle cx="16.5" cy="16.5" r="16.5" fill="#FF7300" />
        </svg>
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{userName || 'User Name'}</span>
        <span className={styles.role}>Role Information</span>
      </div>
      <div className={styles.status}>
        <span className={styles.statusLabel}>{statusLabel}</span>
        <span className={`${styles.dot} ${dotColor}`} />
      </div>
    </button>
  );
}
