import { create } from 'zustand';
import { wsService } from '../services/websocket';

export type MessageRole = 'user' | 'agent' | 'system';
export type MessageType = 'text' | 'progress-card' | 'data-card' | 'error' | 'action-preview' | 'activity-log';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  suggestion?: string;
  previewId?: string;
  logEntries?: AgentLogEntry[];
  timestamp: Date;
}

export type AgentPhase =
  | 'step' | 'observing' | 'thinking' | 'parsed'
  | 'executing' | 'action_result' | 'complete' | 'needs_help' | 'error';

export interface AgentLogEntry {
  phase: AgentPhase;
  step: number;
  maxSteps: number;
  message: string;
  detail?: string;
  layer?: string;
  timestamp: string;
}

export interface AgentProgress {
  step: number;
  maxSteps: number;
  thinking: string;
  action?: string;
  layer?: string;
}

export type ConversationStatus = 'active' | 'complete' | 'interrupted';

export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  messages: ChatMessage[];
  messageCount: number;
  messagesLoaded: boolean;
  lastMessagePreview: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string;
  isAgentTyping: boolean;
  suggestionsVisible: boolean;
  drafts: Record<string, string>;
  agentProgress: AgentProgress | null;
  agentLog: AgentLogEntry[];

  getActiveConversation: () => Conversation | undefined;
  sendMessage: (content: string) => void;
  newConversation: () => void;
  switchConversation: (id: string) => void;
  setDraft: (conversationId: string, text: string) => void;
  getDraft: (conversationId: string) => string;
  receiveMessage: (conversationId: string, message: ChatMessage) => void;
  setAgentProgress: (conversationId: string, progress: AgentProgress) => void;
  addAgentLogEntry: (entry: AgentLogEntry) => void;
  clearAgentLog: () => void;
  resetTypingState: () => void;
  confirmAction: (previewId: string, conversationId: string) => void;
  cancelAction: (previewId: string, conversationId: string) => void;
  cancelTask: () => void;
  hydrateConversations: (serverConversations: Array<{
    id: string;
    title: string;
    status: ConversationStatus;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    lastMessagePreview: string;
  }>) => void;
  loadConversationMessages: (conversationId: string, messages: Array<{
    id: string;
    role: string;
    type: string;
    content: string;
    timestamp: string;
  }>) => void;
  replaceConversationId: (tempId: string, serverId: string, title: string, createdAt: string) => void;
  deleteConversation: (conversationId: string) => void;
  removeConversation: (conversationId: string) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createConversation(): Conversation {
  return {
    id: generateId(),
    title: 'New conversation',
    status: 'active',
    messages: [],
    messageCount: 0,
    messagesLoaded: true,
    lastMessagePreview: '',
    createdAt: new Date(),
    updatedAt: new Date(),
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
    agentProgress: null,
    agentLog: [],

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
                lastMessagePreview: content.slice(0, 100),
                updatedAt: new Date(),
              }
            : c
        ),
        isAgentTyping: true,
        agentProgress: null,
      }));

      // On deployed environments with no bridge, respond locally
      if (wsService.cloudPreview) {
        const systemReply: ChatMessage = {
          id: generateId(),
          role: 'system',
          type: 'text',
          content:
            'This is a cloud preview of the dashboard. To interact with the agent, run the app locally:\n\n' +
            '1. `npm run server:dev`  — start the bridge server\n' +
            '2. `npm run agent:dev`   — start the local agent\n' +
            '3. `npm run dashboard:dev` — open the dashboard\n\n' +
            'See the README for full setup instructions.',
          timestamp: new Date(),
        };
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === activeConversationId
              ? { ...c, messages: [...c.messages, systemReply] }
              : c
          ),
          isAgentTyping: false,
        }));
        return;
      }

      // Send to bridge server
      const DIRECT_PREFIXES = ['/shell ', '/browser ', '/ax ', '/vision '];
      const isDirect = DIRECT_PREFIXES.some((p) => content.trimStart().startsWith(p));
      wsService.send({
        type: 'dashboard_chat',
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        conversationId: activeConversationId,
        content,
        isDirect,
      });
    },

    newConversation: () => {
      const conv = createConversation();
      const tempId = conv.id;

      set((state) => ({
        conversations: [conv, ...state.conversations],
        activeConversationId: conv.id,
        suggestionsVisible: true,
        agentProgress: null,
      }));

      // Notify bridge to create a server-side conversation
      wsService.send({
        type: 'dashboard_new_conversation',
        tempId,
      });
    },

    switchConversation: (id) => {
      const conv = get().conversations.find((c) => c.id === id);
      set({ activeConversationId: id, suggestionsVisible: false, agentProgress: null });

      // Load messages from server if not yet loaded
      if (conv && !conv.messagesLoaded) {
        wsService.send({
          type: 'dashboard_load_conversation',
          conversationId: id,
        });
      }
    },

    setDraft: (conversationId, text) =>
      set((state) => ({
        drafts: { ...state.drafts, [conversationId]: text },
      })),

    getDraft: (conversationId) => get().drafts[conversationId] || '',

    receiveMessage: (conversationId, message) =>
      set((state) => {
        // Snapshot the activity log into a persistent message before clearing
        const logSnapshot: ChatMessage[] = state.agentLog.length > 0
          ? [{
              id: `activity-log-${Date.now()}`,
              role: 'system' as MessageRole,
              type: 'activity-log' as MessageType,
              content: `Agent executed ${state.agentLog[state.agentLog.length - 1]?.step || 0} steps`,
              logEntries: [...state.agentLog],
              timestamp: new Date(),
            }]
          : [];

        return {
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: [...c.messages, ...logSnapshot, message],
                  lastMessagePreview: message.content.slice(0, 100),
                  updatedAt: new Date(),
                }
              : c
          ),
          isAgentTyping: false,
          agentProgress: null,
          agentLog: [],
        };
      }),

    setAgentProgress: (_conversationId, progress) =>
      set({
        agentProgress: progress,
        isAgentTyping: true,
      }),

    addAgentLogEntry: (entry) =>
      set((state) => ({
        agentLog: [...state.agentLog, entry],
        isAgentTyping: true,
      })),

    clearAgentLog: () =>
      set({ agentLog: [], agentProgress: null }),

    resetTypingState: () =>
      set((state) => {
        // Snapshot any in-progress log before clearing (WS reconnect protection)
        if (state.agentLog.length === 0) {
          return { isAgentTyping: false, agentProgress: null, agentLog: [] };
        }
        const activeConvId = state.conversations.find((c) =>
          c.messages.some((m) => m.type === 'action-preview')
        )?.id ?? state.conversations[0]?.id;
        const logMessage: ChatMessage = {
          id: `activity-log-${Date.now()}`,
          role: 'system' as MessageRole,
          type: 'activity-log' as MessageType,
          content: `Agent interrupted (reconnect) after ${state.agentLog[state.agentLog.length - 1]?.step || 0} steps`,
          logEntries: [...state.agentLog],
          timestamp: new Date(),
        };
        return {
          conversations: activeConvId
            ? state.conversations.map((c) =>
                c.id === activeConvId
                  ? { ...c, messages: [...c.messages, logMessage] }
                  : c
              )
            : state.conversations,
          isAgentTyping: false,
          agentProgress: null,
          agentLog: [],
        };
      }),

    confirmAction: (previewId, conversationId) => {
      wsService.send({
        type: 'dashboard_action_confirm',
        previewId,
        conversationId,
      });
      // Update the preview message to disable buttons immediately
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.previewId === previewId
                    ? { ...m, type: 'text' as const, content: m.content + '\n\nConfirmed — executing...' }
                    : m
                ),
              }
            : c
        ),
        isAgentTyping: true,
      }));
    },

    cancelAction: (previewId, conversationId) => {
      wsService.send({
        type: 'dashboard_action_cancel',
        previewId,
        conversationId,
      });
      // Update the preview message to reflect cancellation
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.previewId === previewId
                    ? { ...m, type: 'text' as const, content: m.content + '\n\nCancelled.' }
                    : m
                ),
              }
            : c
        ),
      }));
    },

    cancelTask: () => {
      const { activeConversationId } = get();
      wsService.send({
        type: 'dashboard_cancel_task',
        conversationId: activeConversationId,
      });
    },

    hydrateConversations: (serverConversations) => {
      if (serverConversations.length === 0) return;

      const hydrated: Conversation[] = serverConversations.map((sc) => ({
        id: sc.id,
        title: sc.title,
        status: sc.status,
        messages: [],
        messageCount: sc.messageCount,
        messagesLoaded: false,
        lastMessagePreview: sc.lastMessagePreview,
        createdAt: new Date(sc.createdAt),
        updatedAt: new Date(sc.updatedAt),
      }));

      set((state) => {
        // Merge: keep any local conversations that have unsent messages,
        // replace/add server conversations
        const serverIds = new Set(hydrated.map((c) => c.id));
        const localOnly = state.conversations.filter(
          (c) => !serverIds.has(c.id) && c.messages.length > 0
        );

        const merged = [...localOnly, ...hydrated];
        const activeId = merged.find((c) => c.id === state.activeConversationId)
          ? state.activeConversationId
          : merged[0]?.id ?? state.activeConversationId;

        return {
          conversations: merged,
          activeConversationId: activeId,
        };
      });

      // Auto-load messages for the active conversation
      const activeId = get().activeConversationId;
      const active = get().conversations.find((c) => c.id === activeId);
      if (active && !active.messagesLoaded) {
        wsService.send({
          type: 'dashboard_load_conversation',
          conversationId: activeId,
        });
      }
    },

    loadConversationMessages: (conversationId, messages) => {
      const parsed: ChatMessage[] = messages.map((m) => ({
        id: m.id,
        role: (m.role === 'agent' ? 'agent' : m.role === 'user' ? 'user' : 'system') as MessageRole,
        type: (m.type === 'error' ? 'error' : m.type === 'action_preview' ? 'action-preview' : 'text') as MessageType,
        content: m.content,
        timestamp: new Date(m.timestamp),
      }));

      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, messages: parsed, messagesLoaded: true, messageCount: parsed.length }
            : c
        ),
      }));
    },

    replaceConversationId: (tempId, serverId, title, createdAt) => {
      set((state) => {
        const newActiveId = state.activeConversationId === tempId ? serverId : state.activeConversationId;

        // Move any draft from tempId to serverId
        const newDrafts = { ...state.drafts };
        if (newDrafts[tempId]) {
          newDrafts[serverId] = newDrafts[tempId];
          delete newDrafts[tempId];
        }

        return {
          conversations: state.conversations.map((c) =>
            c.id === tempId
              ? { ...c, id: serverId, title: title || c.title, createdAt: new Date(createdAt) }
              : c
          ),
          activeConversationId: newActiveId,
          drafts: newDrafts,
        };
      });
    },

    deleteConversation: (conversationId) => {
      wsService.send({
        type: 'dashboard_delete_conversation',
        conversationId,
      });
    },

    removeConversation: (conversationId) => {
      set((state) => {
        const remaining = state.conversations.filter((c) => c.id !== conversationId);
        // If we deleted the active conversation, switch to the first remaining
        // or create a new one if none left
        if (remaining.length === 0) {
          const fresh = createConversation();
          return {
            conversations: [fresh],
            activeConversationId: fresh.id,
            suggestionsVisible: true,
          };
        }
        const newActiveId = state.activeConversationId === conversationId
          ? remaining[0]!.id
          : state.activeConversationId;
        return {
          conversations: remaining,
          activeConversationId: newActiveId,
        };
      });
    },
  };
});
