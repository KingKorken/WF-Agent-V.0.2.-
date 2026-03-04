import { useRef, useCallback, useState, useEffect } from 'react';
import { VariableSizeList as List } from 'react-window';
import type { AuditEntry } from '../../stores/logbookStore';
import { LogbookEntry } from './LogbookEntry';
import styles from './LogbookTimeline.module.css';

interface LogbookTimelineProps {
  entries: AuditEntry[];
}

const COLLAPSED_HEIGHT = 36;
const EXPANDED_HEIGHT = 280;

export function LogbookTimeline({ entries }: LogbookTimelineProps) {
  const listRef = useRef<List>(null);
  const expandedSet = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(600);

  // Observe container so the virtual list always fills available space
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((observed) => {
      for (const entry of observed) {
        const h = entry.contentRect.height;
        if (h > 0) setContainerHeight(h);
      }
    });
    observer.observe(el);
    if (el.clientHeight > 0) setContainerHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const getItemSize = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return COLLAPSED_HEIGHT;
      return expandedSet.current.has(entry.id) ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
    },
    [entries],
  );

  const handleToggle = useCallback(
    (entryId: string, index: number) => {
      if (expandedSet.current.has(entryId)) {
        expandedSet.current.delete(entryId);
      } else {
        expandedSet.current.add(entryId);
      }
      listRef.current?.resetAfterIndex(index);
    },
    [],
  );

  return (
    <div className={styles.timeline} ref={containerRef}>
      <List
        ref={listRef}
        height={containerHeight}
        itemCount={entries.length}
        itemSize={getItemSize}
        width="100%"
        overscanCount={5}
      >
        {({ index, style }: { index: number; style: React.CSSProperties }) => {
          const entry = entries[index];
          if (!entry) return null;
          return (
            <div style={style}>
              <LogbookEntry
                entry={entry}
                isExpanded={expandedSet.current.has(entry.id)}
                onToggle={() => handleToggle(entry.id, index)}
              />
            </div>
          );
        }}
      </List>
    </div>
  );
}
