import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { OnboardingOverlay } from '../Onboarding/OnboardingOverlay';
import styles from './SettingsView.module.css';

export function SettingsView() {
  const {
    userName, setUserName,
    notificationsEnabled, setNotifications,
    executionPanelEnabled, setExecutionPanel,
    connectedApps,
  } = useSettingsStore();

  const [showOnboarding, setShowOnboarding] = useState(false);

  return (
    <div className={styles.root}>
      <h2 className={styles.heading}>Settings</h2>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Profile</h3>
        <label className={styles.label}>
          Name
          <input
            className={styles.input}
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
        </label>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Notifications</h3>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(e) => setNotifications(e.target.checked)}
          />
          <span>Enable notifications</span>
        </label>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Execution Panel</h3>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={executionPanelEnabled}
            onChange={(e) => setExecutionPanel(e.target.checked)}
          />
          <span>Show expanded execution panel during workflows</span>
        </label>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Connected Applications</h3>
        <ul className={styles.appList}>
          {connectedApps.map((app) => (
            <li key={app} className={styles.app}>{app}</li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Onboarding</h3>
        <button
          className={styles.replayButton}
          onClick={() => setShowOnboarding(true)}
        >
          Replay onboarding tour
        </button>
      </section>

      {showOnboarding && (
        <OnboardingOverlay forceShow onComplete={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}
