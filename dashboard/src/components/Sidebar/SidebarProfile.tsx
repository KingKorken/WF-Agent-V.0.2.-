import { useTabStore } from '../../stores/tabStore';
import { useSettingsStore } from '../../stores/settingsStore';
import styles from './SidebarProfile.module.css';

export function SidebarProfile() {
  const openTab = useTabStore((s) => s.openTab);
  const userName = useSettingsStore((s) => s.userName);

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
    </button>
  );
}
