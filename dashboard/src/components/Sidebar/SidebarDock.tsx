import { DockIcon } from './DockIcon';
import { useTabStore } from '../../stores/tabStore';
import { CalendarIcon } from './icons/CalendarIcon';
import { LogbookIcon } from './icons/LogbookIcon';
import { EmailIcon } from './icons/EmailIcon';
import { WorkflowLibraryIcon } from './icons/WorkflowLibraryIcon';
import styles from './SidebarDock.module.css';

export function SidebarDock() {
  const openTab = useTabStore((s) => s.openTab);

  return (
    <div className={styles.dock}>
      <DockIcon
        icon={<CalendarIcon />}
        label="Calendar"
        background="linear-gradient(to bottom, #fdfefe, #ecebeb)"
        onClick={() => openTab({ id: 'record', label: 'Record', closable: true })}
      />
      <DockIcon
        icon={<LogbookIcon />}
        label="Logbook"
        background="linear-gradient(to bottom, #ff8f00, #ff5a00)"
        onClick={() => openTab({ id: 'logbook', label: 'Logbook', closable: true })}
      />
      <DockIcon
        icon={<EmailIcon />}
        label="Email"
        background="linear-gradient(to bottom, #11c0fb, #0071ff)"
        onClick={() => openTab({ id: 'email', label: 'Email', closable: true })}
      />
      <DockIcon
        icon={<WorkflowLibraryIcon />}
        label="Workflow Library"
        background="linear-gradient(to bottom, #ffffff, #ecebeb)"
        onClick={() => openTab({ id: 'settings', label: 'Settings', closable: true })}
      />
    </div>
  );
}
