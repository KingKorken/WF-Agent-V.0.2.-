import { useResizable } from '../../hooks/useResizable';
import { SidebarNewWorkflow } from './SidebarNewWorkflow';
import { SidebarWorkflows } from './SidebarWorkflows';
import { SidebarConversations } from './SidebarConversations';
import { SidebarDock } from './SidebarDock';
import { SidebarProfile } from './SidebarProfile';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const { handleMouseDown } = useResizable(280, 220, 480);

  return (
    <nav className={styles.sidebar} aria-label="Main navigation">
      <div className={styles.top}>
        <SidebarNewWorkflow />
        <SidebarWorkflows />
      </div>
      <div className={styles.conversations}>
        <SidebarConversations />
      </div>
      <div className={styles.spacer} />
      <div className={styles.divider} />
      <SidebarDock />
      <SidebarProfile />
      <div className={styles.resizeHandle} onMouseDown={handleMouseDown} />
    </nav>
  );
}
