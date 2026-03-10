import { useRef, useEffect, useCallback } from 'react';
import { useDebugStore, type DebugEntry } from '../../stores/debugStore';
import styles from './DebugPanel.module.css';

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
  } catch {
    return iso;
  }
}

function levelClass(level: DebugEntry['level']): string {
  if (level === 'warn') return styles.warn;
  if (level === 'error') return styles.error;
  return '';
}

export function DebugPanel() {
  const entries = useDebugStore((s) => s.entries);
  const isOpen = useDebugStore((s) => s.isOpen);
  const clear = useDebugStore((s) => s.clear);
  const toggle = useDebugStore((s) => s.toggle);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  useEffect(() => {
    if (isNearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (!isOpen) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Debug log</span>
        <span className={styles.count}>{entries.length}</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} onClick={clear}>Clear</button>
          <button className={styles.actionBtn} onClick={toggle}>Close</button>
        </div>
      </div>
      <div className={styles.log} ref={scrollRef} onScroll={handleScroll}>
        {entries.length === 0 && (
          <div className={styles.empty}>No debug entries yet. Interact with the dashboard to generate events.</div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className={`${styles.entry} ${levelClass(entry.level)}`}>
            <span className={styles.time}>{formatTime(entry.timestamp)}</span>
            <span className={styles.level}>{entry.level.toUpperCase().padEnd(5)}</span>
            <span className={styles.source}>[{entry.source}:{entry.category}]</span>
            <span className={styles.message}>{entry.message}</span>
            {entry.detail && <span className={styles.detail}> | {entry.detail}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
