import { useState, useCallback } from 'react';
import { FixedSizeList as List } from 'react-window';
import { useChatStore } from '../../stores/chatStore';
import type { Conversation } from '../../stores/chatStore';
import styles from './SidebarConversations.module.css';

function ConversationItem({
  conv,
  isActive,
  onSwitch,
  onDelete,
}: {
  conv: Conversation;
  isActive: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={styles.itemRow}
      data-active={isActive ? '' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        className={styles.item}
        data-active={isActive ? '' : undefined}
        onClick={() => onSwitch(conv.id)}
      >
        <span className={styles.itemTitle}>{conv.title || 'New conversation'}</span>
        {conv.status !== 'active' && (
          <span className={styles.statusBadge} data-status={conv.status}>
            {conv.status === 'complete' ? 'Done' : 'Interrupted'}
          </span>
        )}
      </button>
      {hovered && (
        <button
          className={styles.deleteButton}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(conv.id);
          }}
          aria-label="Delete conversation"
        >
          Delete
        </button>
      )}
    </div>
  );
}

export function SidebarConversations() {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeConversationId);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const newConversation = useChatStore((s) => s.newConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);

  const handleDelete = useCallback((id: string) => {
    deleteConversation(id);
  }, [deleteConversation]);

  // For small lists, render plainly
  if (conversations.length <= 50) {
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <p className={styles.title}>Recents</p>
          <button className={styles.newChatButton} onClick={newConversation}>
            New Chat
          </button>
        </div>
        <div className={styles.list}>
          {conversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              conv={conv}
              isActive={conv.id === activeId}
              onSwitch={switchConversation}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </div>
    );
  }

  // For large lists, virtualize
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <p className={styles.title}>Recents</p>
        <button className={styles.newChatButton} onClick={newConversation}>
          New Chat
        </button>
      </div>
      <List
        height={Math.min(conversations.length * 36, 400)}
        itemCount={conversations.length}
        itemSize={36}
        width="100%"
      >
        {({ index, style }: { index: number; style: React.CSSProperties }) => {
          const conv = conversations[index];
          if (!conv) return null;
          return (
            <div style={style}>
              <ConversationItem
                conv={conv}
                isActive={conv.id === activeId}
                onSwitch={switchConversation}
                onDelete={handleDelete}
              />
            </div>
          );
        }}
      </List>
    </div>
  );
}
