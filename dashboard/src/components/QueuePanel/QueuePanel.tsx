import { useRef, useEffect, useState } from 'react';
import { useWorkflowStore } from '../../stores/workflowStore';
import { QueueTile } from './QueueTile';
import styles from './QueuePanel.module.css';

export function QueuePanel() {
  const queue = useWorkflowStore((s) => s.queue);
  const [collapsed, setCollapsed] = useState(false);
  const prevLength = useRef(queue.length);

  // Auto-expand when a new workflow is added
  useEffect(() => {
    if (queue.length > prevLength.current && collapsed) {
      setCollapsed(false);
    }
    prevLength.current = queue.length;
  }, [queue.length, collapsed]);

  if (queue.length <= 1) return null;

  return (
    <div className={styles.panel} data-collapsed={collapsed ? '' : undefined}>
      <button
        className={styles.collapseButton}
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? 'Expand queue' : 'Collapse queue'}
      >
        {collapsed ? '+' : '\u2212'}
      </button>
      {!collapsed && (
        <div className={styles.stack}>
          {[...queue].reverse().map((item) => (
            <QueueTile key={item.workflowId} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
