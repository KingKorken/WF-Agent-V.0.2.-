import { create } from 'zustand';

export type MessageRole = 'user' | 'agent' | 'system';
export type MessageType = 'text' | 'progress-card' | 'data-card' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  suggestion?: string;
  timestamp: Date;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string;
  isAgentTyping: boolean;
  suggestionsVisible: boolean;
  drafts: Record<string, string>;

  getActiveConversation: () => Conversation | undefined;
  sendMessage: (content: string) => void;
  newConversation: () => void;
  switchConversation: (id: string) => void;
  setDraft: (conversationId: string, text: string) => void;
  getDraft: (conversationId: string) => string;
  receiveMessage: (conversationId: string, message: ChatMessage) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createConversation(): Conversation {
  return {
    id: generateId(),
    title: 'New conversation',
    messages: [],
    createdAt: new Date(),
  };
}

export const useChatStore = create<ChatState>((set, get) => {
  const initial = createConversation();

  return {
    conversations: [initial],
    activeConversationId: initial.id,
    isAgentTyping: false,
    suggestionsVisible: true,
    drafts: {},

    getActiveConversation: () => {
      const { conversations, activeConversationId } = get();
      return conversations.find((c) => c.id === activeConversationId);
    },

    sendMessage: (content) => {
      const { activeConversationId } = get();
      const userMessage: ChatMessage = {
        id: generateId(),
        role: 'user',
        type: 'text',
        content,
        timestamp: new Date(),
      };

      set((state) => ({
        suggestionsVisible: false,
        conversations: state.conversations.map((c) =>
          c.id === activeConversationId
            ? {
                ...c,
                title: c.messages.length === 0 ? content.slice(0, 50) : c.title,
                messages: [...c.messages, userMessage],
              }
            : c
        ),
        isAgentTyping: true,
      }));

      // Mock agent response after a delay
      setTimeout(() => {
        const agentMessage: ChatMessage = {
          id: generateId(),
          role: 'agent',
          type: 'text',
          content: `I received your message: "${content}". This is a mock response. WebSocket integration will be connected in Phase 4.`,
          timestamp: new Date(),
        };
        set((state) => ({
          isAgentTyping: false,
          conversations: state.conversations.map((c) =>
            c.id === activeConversationId
              ? { ...c, messages: [...c.messages, agentMessage] }
              : c
          ),
        }));
      }, 1000 + Math.random() * 1000);
    },

    newConversation: () => {
      const conv = createConversation();
      set((state) => ({
        conversations: [conv, ...state.conversations],
        activeConversationId: conv.id,
        suggestionsVisible: true,
      }));
    },

    switchConversation: (id) => {
      set({ activeConversationId: id, suggestionsVisible: false });
    },

    setDraft: (conversationId, text) =>
      set((state) => ({
        drafts: { ...state.drafts, [conversationId]: text },
      })),

    getDraft: (conversationId) => get().drafts[conversationId] || '',

    receiveMessage: (conversationId, message) =>
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: [...c.messages, message] }
            : c
        ),
        isAgentTyping: false,
      })),
  };
});
