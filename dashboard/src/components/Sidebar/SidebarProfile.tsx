import { useTabStore } from '../../stores/tabStore';
import styles from './SidebarProfile.module.css';

export function SidebarProfile() {
  const openTab = useTabStore((s) => s.openTab);

  return (
    <button
      className={styles.profile}
      onClick={() => openTab({ id: 'settings', label: 'Settings', closable: true })}
    >
      Profile & Settings
    </button>
  );
}
