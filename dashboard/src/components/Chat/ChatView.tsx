import { useRef, useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { ProgressCard } from './ProgressCard';
import { ChatGreeting } from './ChatGreeting';
import { ChatSuggestions } from './ChatSuggestions';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { LoadingDots } from '../shared/LoadingDots';
import styles from './ChatView.module.css';

export function ChatView() {
  // Derive conversation directly in selector instead of calling getActiveConversation()
  // which creates a new object reference on every store update, defeating Zustand memoization
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  );
  const isAgentTyping = useChatStore((s) => s.isAgentTyping);
  const suggestionsVisible = useChatStore((s) => s.suggestionsVisible);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = conversation?.messages ?? [];
  const isEmpty = messages.length === 0;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isAgentTyping]);

  return (
    <div className={styles.root}>
      <div className={styles.messagesArea}>
        <ProgressCard />
        {isEmpty && (
          <div className={styles.emptyState}>
            <ChatGreeting />
            {suggestionsVisible && <ChatSuggestions onSelect={sendMessage} />}
            <ChatInput onSend={sendMessage} disabled={isAgentTyping} />
          </div>
        )}
        {!isEmpty && (
          <div className={styles.messages}>
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            {isAgentTyping && (
              <div className={styles.typingIndicator}>
                <LoadingDots />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      {!isEmpty && (
        <div className={styles.inputArea}>
          <ChatInput onSend={sendMessage} disabled={isAgentTyping} />
        </div>
      )}
    </div>
  );
}
