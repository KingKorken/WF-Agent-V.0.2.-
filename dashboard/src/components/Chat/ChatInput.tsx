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
      <textarea
        className={styles.input}
        value={inputValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        rows={1}
        disabled={disabled}
        aria-label="Message input"
      />
    </div>
  );
}
