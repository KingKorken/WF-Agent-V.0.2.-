import { DockIcon } from './DockIcon';
import { useTabStore } from '../../stores/tabStore';
import { LogbookIcon } from './icons/LogbookIcon';
import { RecordIcon } from './icons/RecordIcon';
import { EmailIcon } from './icons/EmailIcon';
import styles from './SidebarDock.module.css';

export function SidebarDock() {
  const openTab = useTabStore((s) => s.openTab);

  return (
    <div className={styles.dock}>
      <DockIcon
        icon={<LogbookIcon />}
        label="Logbook"
        onClick={() => openTab({ id: 'logbook', label: 'Logbook', closable: true })}
      />
      <DockIcon
        icon={<RecordIcon />}
        label="Record"
        onClick={() => openTab({ id: 'record', label: 'Record', closable: true })}
      />
      <DockIcon
        icon={<EmailIcon />}
        label="Email"
        onClick={() => openTab({ id: 'email', label: 'Email', closable: true })}
      />
    </div>
  );
}
