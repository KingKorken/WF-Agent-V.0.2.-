import styles from './DockIcon.module.css';

interface DockIconProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  background?: string;
}

export function DockIcon({ icon, label, onClick, background }: DockIconProps) {
  return (
    <button
      className={styles.icon}
      onClick={onClick}
      title={label}
      aria-label={label}
      data-dock-icon
      style={background ? { background } : undefined}
    >
      {icon}
    </button>
  );
}
