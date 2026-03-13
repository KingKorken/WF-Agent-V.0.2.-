/**
 * Message Router — Routes incoming WebSocket messages to Zustand stores.
 *
 * Handles the server -> dashboard direction only. Outgoing messages
 * (dashboard -> server) are sent directly by stores via wsService.send()
 * to avoid circular dependencies.
 */

import type {
  WebSocketMessage,
  DashboardHello,
  ServerChatResponse,
  ServerAgentProgress,
  ServerAgentStatus,
  ServerWorkflowProgress,
  ServerActionPreview,
  ServerSubGoalProgress,
  ServerDebugLog,
  ServerCancelAck,
  AgentWorkflowParsed,
  AgentRecordingError,
  AgentWorkflowList,
  AgentWorkflowDetail,
  AgentWorkflowDeleted,
  ServerConversationCreated,
  ServerConversationList,
  ServerConversationMessages,
  ServerConversationDeleted,
  ServerSearchResults,
} from '@shared/types';
import { wsService } from './websocket';
import { useChatStore } from '../stores/chatStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useWorkflowStore } from '../stores/workflowStore';
import { useDebugStore } from '../stores/debugStore';
import { getRoomId } from '../config/room';

// ---------------------------------------------------------------------------
// Incoming message routing (server -> dashboard stores)
// ---------------------------------------------------------------------------

function handleMessage(message: WebSocketMessage): void {
  switch (message.type) {
    case 'server_chat_response': {
      const msg = message as ServerChatResponse;
      useChatStore.getState().receiveMessage(msg.conversationId, {
        id: msg.message.id,
        role: msg.message.role === 'agent' ? 'agent' : 'system',
        type: msg.message.type === 'error' ? 'error' : 'text',
        content: msg.message.content,
        timestamp: new Date(),
      });
      break;
    }

    case 'server_agent_progress': {
      const msg = message as ServerAgentProgress;
      const store = useChatStore.getState();
      // Add to the activity log
      store.addAgentLogEntry({
        phase: msg.phase,
        step: msg.step,
        maxSteps: msg.maxSteps,
        message: msg.message,
        detail: msg.detail,
        layer: msg.layer,
        timestamp: msg.timestamp,
      });
      // Also update the legacy agentProgress for backward compat
      store.setAgentProgress(msg.conversationId, {
        step: msg.step,
        maxSteps: msg.maxSteps,
        thinking: msg.message,
        action: msg.detail,
        layer: msg.layer,
      });
      break;
    }

    case 'server_action_preview': {
      const msg = message as ServerActionPreview;
      useChatStore.getState().receiveMessage(msg.conversationId, {
        id: `preview_${msg.previewId}`,
        role: 'agent',
        type: 'action-preview',
        content: msg.plan,
        previewId: msg.previewId,
        timestamp: new Date(),
      });
      break;
    }

    case 'server_agent_status': {
      const msg = message as ServerAgentStatus;
      useConnectionStore.getState().setAgentStatus(
        msg.agentConnected,
        msg.agentName ?? null,
        msg.supportedLayers ?? [],
      );
      break;
    }

    case 'server_workflow_progress': {
      const msg = message as ServerWorkflowProgress;
      const store = useWorkflowStore.getState();

      // Guard: ignore progress for workflows no longer in queue (e.g., cancelled)
      if (!store.queue.some((q) => q.workflowId === msg.workflowId)) break;

      if (msg.status === 'complete' || msg.status === 'error') {
        store.completeExecution(msg.workflowId);
      } else {
        store.updateQueueProgress(
          msg.workflowId,
          `${msg.step}/${msg.totalSteps}`,
          msg.currentStepName,
        );
      }
      break;
    }

    case 'server_subgoal_progress': {
      const msg = message as ServerSubGoalProgress;
      const store = useChatStore.getState();
      // Route sub-goal progress as an activity log entry
      const statusLabel = msg.status === 'active' ? 'Starting' : msg.status === 'completed' ? 'Completed' : msg.status === 'failed' ? 'Failed' : msg.status === 'skipped' ? 'Skipped' : 'Pending';
      store.addAgentLogEntry({
        phase: msg.status === 'active' ? 'step' : msg.status === 'completed' ? 'complete' : msg.status === 'failed' ? 'error' : 'step',
        step: msg.index + 1,
        maxSteps: msg.total,
        message: `Sub-goal ${msg.index + 1}/${msg.total}: ${statusLabel} — ${msg.subGoal.label}`,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'server_cancel_ack': {
      const msg = message as ServerCancelAck;
      const store = useChatStore.getState();
      const completedList = msg.completedSubGoals.length > 0
        ? `Completed: ${msg.completedSubGoals.join(', ')}`
        : 'No sub-goals were completed.';
      store.receiveMessage(msg.conversationId, {
        id: `cancel_ack_${Date.now()}`,
        role: 'system',
        type: 'text',
        content: `Task cancelled. ${completedList}`,
        timestamp: new Date(),
      });
      store.resetTypingState();
      break;
    }

    // --- Conversation persistence ---

    case 'server_conversation_created': {
      const msg = message as ServerConversationCreated;
      useChatStore.getState().replaceConversationId(
        msg.tempId,
        msg.id,
        msg.title,
        msg.createdAt,
      );
      break;
    }

    case 'server_conversation_list': {
      const msg = message as ServerConversationList;
      useChatStore.getState().hydrateConversations(msg.conversations);
      break;
    }

    case 'server_conversation_messages': {
      const msg = message as ServerConversationMessages;
      useChatStore.getState().loadConversationMessages(
        msg.conversationId,
        msg.messages,
      );
      break;
    }

    case 'server_conversation_deleted': {
      const msg = message as ServerConversationDeleted;
      useChatStore.getState().removeConversation(msg.conversationId);
      break;
    }

    case 'server_search_results': {
      // Search results can be handled by a future search UI component.
      // For now, log them to debug store.
      const msg = message as ServerSearchResults;
      useDebugStore.getState().addEntry({
        source: 'server',
        level: 'info',
        category: 'search',
        message: `Search for "${msg.query}" returned ${msg.results.length} results`,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    // --- Recording lifecycle ---

    case 'agent_recording_started': {
      useWorkflowStore.getState().setRecordingState('recording');
      break;
    }

    case 'agent_recording_stopped': {
      // Intermediate state — wait for parsing notification
      break;
    }

    case 'agent_recording_parsing': {
      useWorkflowStore.getState().setRecordingState('parsing');
      break;
    }

    case 'agent_workflow_parsed': {
      const msg = message as AgentWorkflowParsed;
      const store = useWorkflowStore.getState();
      store.setRecordingState('complete');
      store.addParsedWorkflow(msg.workflow);
      break;
    }

    case 'agent_recording_error': {
      const msg = message as AgentRecordingError;
      const store = useWorkflowStore.getState();
      store.setRecordingState('error');
      store.setRecordingError(msg.error);
      break;
    }

    // --- Workflow CRUD responses ---

    case 'agent_workflow_list': {
      const msg = message as AgentWorkflowList;
      useWorkflowStore.getState().setWorkflows(msg.workflows);
      break;
    }

    case 'agent_workflow_detail': {
      const msg = message as AgentWorkflowDetail;
      useWorkflowStore.getState().setWorkflowDetail(msg.workflow);
      break;
    }

    case 'agent_workflow_deleted': {
      const msg = message as AgentWorkflowDeleted;
      useWorkflowStore.getState().removeWorkflow(msg.workflowId);
      break;
    }

    // --- Debug logging ---

    case 'server_debug_log': {
      const msg = message as ServerDebugLog;
      useDebugStore.getState().addEntry({
        source: 'server',
        level: msg.level,
        category: msg.source,
        message: msg.message,
        detail: msg.detail,
        timestamp: msg.timestamp,
      });
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let initialized = false;

/** Initialize the message router. Call once on app startup. */
export function initMessageRouter(): void {
  if (initialized) return;
  initialized = true;

  // Store the room ID so the rest of the app can access it
  const roomId = getRoomId();
  useConnectionStore.getState().setRoomId(roomId);

  // Subscribe to incoming messages
  wsService.onMessage(handleMessage);

  // Connect to the bridge server
  wsService.connect();

  // Send dashboard hello once connected (including on reconnection)
  useConnectionStore.subscribe((state, prevState) => {
    if (state.status === 'connected' && prevState.status !== 'connected') {
      const hello: DashboardHello = {
        type: 'dashboard_hello',
        dashboardId: `dashboard_${Date.now()}`,
        version: '0.1.0',
        roomId: roomId ?? undefined,
      };
      wsService.send(hello as unknown as Record<string, unknown>);

      // Reset recording state on reconnect — we don't know if the agent
      // is still recording after a WS drop
      useWorkflowStore.getState().setRecordingState('idle');

      // Clear stale cancelled display on reconnect
      useWorkflowStore.getState().clearCancelledDisplay();

      // Reset typing state on reconnect — WS drop may have lost pending responses
      useChatStore.getState().resetTypingState();

      useDebugStore.getState().addEntry({
        source: 'client',
        level: 'info',
        category: 'reconnect',
        message: 'Reset typing state after reconnect',
        timestamp: new Date().toISOString(),
      });
    }
  });
}
