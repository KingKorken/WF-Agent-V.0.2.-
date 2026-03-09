import type { ChatMessage as ChatMessageType } from '../../stores/chatStore';
import { useChatStore } from '../../stores/chatStore';
import styles from './ChatMessage.module.css';

interface ChatMessageProps {
  message: ChatMessageType;
  conversationId: string;
  onRetry?: (messageId: string) => void;
}

export function ChatMessage({ message, conversationId, onRetry }: ChatMessageProps) {
  const isUser = message.role === 'user';

  if (message.type === 'action-preview') {
    return (
      <div className={styles.message} data-type="action-preview">
        <div className={styles.previewCard}>
          <div className={styles.previewHeader}>
            Action plan
          </div>
          <p className={styles.previewBody}>{message.content}</p>
          <div className={styles.previewActions}>
            <button
              className={styles.previewProceed}
              onClick={() => {
                if (message.previewId) {
                  useChatStore.getState().confirmAction(message.previewId, conversationId);
                }
              }}
            >
              Proceed
            </button>
            <button
              className={styles.previewCancel}
              onClick={() => {
                if (message.previewId) {
                  useChatStore.getState().cancelAction(message.previewId, conversationId);
                }
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

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
