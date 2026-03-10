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
  AgentWorkflowParsed,
  AgentRecordingError,
  AgentWorkflowList,
  AgentWorkflowDetail,
  AgentWorkflowDeleted,
} from '@shared/types';
import { wsService } from './websocket';
import { useChatStore } from '../stores/chatStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useWorkflowStore } from '../stores/workflowStore';
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
    }
  });
}
