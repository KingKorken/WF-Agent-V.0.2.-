import { useTabStore } from '../../stores/tabStore';
import { Tab } from './Tab';
import styles from './TabBar.module.css';

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useTabStore();

  // Hidden when only Workspace exists
  if (tabs.length <= 1) return null;

  return (
    <div className={styles.tabBar} role="tablist" aria-label="View tabs">
      <div className={styles.tabContainer}>
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            id={tab.id}
            label={tab.label}
            isActive={tab.id === activeTabId}
            closable={tab.closable}
            onClick={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
      </div>
    </div>
  );
}
