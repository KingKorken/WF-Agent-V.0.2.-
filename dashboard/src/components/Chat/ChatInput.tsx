import { type KeyboardEvent } from 'react';
import { useChatStore } from '../../stores/chatStore';
import styles from './ChatInput.module.css';

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled = false }: ChatInputProps) {
  const activeId = useChatStore((s) => s.activeConversationId);
  const getDraft = useChatStore((s) => s.getDraft);
  const setDraft = useChatStore((s) => s.setDraft);

  const inputValue = getDraft(activeId);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(activeId, e.target.value);
  };

  const handleSubmit = () => {
    if (!inputValue.trim() || disabled) return;
    onSend(inputValue.trim());
    setDraft(activeId, '');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={styles.wrapper}>
      <button className={styles.plusButton} type="button" aria-label="Add attachment">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M4.16667 10H15.8333" stroke="#4A5565" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.67" />
          <path d="M10 4.16667V15.8333" stroke="#4A5565" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.67" />
        </svg>
      </button>
      <textarea
        className={styles.input}
        value={inputValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="How can I help you today?"
        rows={1}
        disabled={disabled}
        autoFocus
        aria-label="Message input"
      />
      <button
        className={styles.sendButton}
        onClick={handleSubmit}
        disabled={disabled || !inputValue.trim()}
        type="button"
        aria-label="Send message"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M5.83337 10H14.1667" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.67" />
          <path d="M10 4.16667L15.8334 10L10 15.8333" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.67" />
        </svg>
      </button>
    </div>
  );
}
