import { FixedSizeList as List } from 'react-window';
import { useChatStore } from '../../stores/chatStore';
import styles from './SidebarConversations.module.css';

export function SidebarConversations() {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeConversationId);
  const switchConversation = useChatStore((s) => s.switchConversation);

  // For small lists, render plainly
  if (conversations.length <= 50) {
    return (
      <div className={styles.list}>
        {conversations.map((conv) => (
          <button
            key={conv.id}
            className={styles.item}
            data-active={conv.id === activeId ? '' : undefined}
            onClick={() => switchConversation(conv.id)}
          >
            {conv.title || 'New conversation'}
          </button>
        ))}
      </div>
    );
  }

  // For large lists, virtualize
  return (
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
          <button
            key={conv.id}
            className={styles.item}
            data-active={conv.id === activeId ? '' : undefined}
            onClick={() => switchConversation(conv.id)}
            style={style}
          >
            {conv.title || 'New conversation'}
          </button>
        );
      }}
    </List>
  );
}
