import { useState } from 'react';
import styles from './Tab.module.css';

interface TabProps {
  id: string;
  label: string;
  isActive: boolean;
  closable: boolean;
  onClick: () => void;
  onClose: () => void;
}

export function Tab({ id, label, isActive, closable, onClick, onClose }: TabProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <button
      className={`${styles.tab} ${isActive ? styles.active : ''}`}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="tab"
      aria-selected={isActive}
      aria-controls={`panel-${id}`}
    >
      {label}
      {closable && isHovered && (
        <span
          className={styles.close}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ×
        </span>
      )}
    </button>
  );
}
