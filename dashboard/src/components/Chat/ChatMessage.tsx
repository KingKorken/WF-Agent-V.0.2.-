import type { ChatMessage as ChatMessageType } from '../../stores/chatStore';
import styles from './ChatMessage.module.css';

interface ChatMessageProps {
  message: ChatMessageType;
  onRetry?: (messageId: string) => void;
}

export function ChatMessage({ message, onRetry }: ChatMessageProps) {
  const isUser = message.role === 'user';

  if (message.type === 'error') {
    return (
      <div className={styles.message} data-type="error">
        <div className={styles.errorCard}>
          <div className={styles.errorHeader}>
            Something went wrong
          </div>
          <p className={styles.errorBody}>{message.content}</p>
          {message.suggestion && (
            <div className={styles.errorSuggestion}>
              <span className={styles.errorSuggestionLabel}>Agent suggests:</span>
              <span>{message.suggestion}</span>
            </div>
          )}
          <div className={styles.errorActions}>
            <button
              className={styles.errorRetry}
              onClick={() => onRetry?.(message.id)}
            >
              Retry
            </button>
            <span className={styles.errorOr}>or type a different instruction below</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.message} ${isUser ? styles.user : styles.agent}`}>
      <div className={styles.content}>{message.content}</div>
    </div>
  );
}
