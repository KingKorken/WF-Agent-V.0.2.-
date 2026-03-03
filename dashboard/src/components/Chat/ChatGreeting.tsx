import { useGreeting } from '../../hooks/useGreeting';
import styles from './ChatGreeting.module.css';

export function ChatGreeting() {
  const greeting = useGreeting('Tim'); // Hardcoded for now, will come from settings

  return (
    <h1 className={styles.greeting}>{greeting}</h1>
  );
}
