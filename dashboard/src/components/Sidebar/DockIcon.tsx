import styles from './DockIcon.module.css';

interface DockIconProps {
  icon: React.ReactNode; // SVG element
  label: string;
  onClick: () => void;
}

export function DockIcon({ icon, label, onClick }: DockIconProps) {
  return (
    <button
      className={styles.icon}
      onClick={onClick}
      title={label}
      aria-label={label}
      data-dock-icon
    >
      {icon}
    </button>
  );
}
