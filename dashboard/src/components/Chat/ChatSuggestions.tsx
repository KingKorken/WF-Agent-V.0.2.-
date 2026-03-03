import styles from './ChatSuggestions.module.css';

const SUGGESTIONS = [
  'Do my payroll',
  'Show recent activity',
  'What workflows do I have?',
  'Run the monthly closing',
];

interface ChatSuggestionsProps {
  onSelect: (suggestion: string) => void;
}

export function ChatSuggestions({ onSelect }: ChatSuggestionsProps) {
  return (
    <div className={styles.suggestions}>
      {SUGGESTIONS.map((s) => (
        <button key={s} className={styles.suggestion} onClick={() => onSelect(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}
