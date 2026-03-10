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
      set((state) => ({
        conversations: [conv, ...state.conversations],
        activeConversationId: conv.id,
        suggestionsVisible: true,
        agentProgress: null,
      }));
    },

    switchConversation: (id) => {
      set({ activeConversationId: id, suggestionsVisible: false, agentProgress: null });
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
              ? { ...c, messages: [...c.messages, ...logSnapshot, message] }
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
  };
});
