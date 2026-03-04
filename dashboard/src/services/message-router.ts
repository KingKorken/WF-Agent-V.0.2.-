/**
 * Message Router — Routes incoming WebSocket messages to Zustand stores.
 *
 * Handles the server → dashboard direction only. Outgoing messages
 * (dashboard → server) are sent directly by stores via wsService.send()
 * to avoid circular dependencies.
 */

import type {
  WebSocketMessage,
  DashboardHello,
  ServerChatResponse,
  ServerAgentProgress,
  ServerAgentStatus,
  ServerWorkflowProgress,
} from '@shared/types';
import { wsService } from './websocket';
import { useChatStore } from '../stores/chatStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useWorkflowStore } from '../stores/workflowStore';

// ---------------------------------------------------------------------------
// Incoming message routing (server → dashboard stores)
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
      useChatStore.getState().setAgentProgress(msg.conversationId, {
        step: msg.step,
        maxSteps: msg.maxSteps,
        thinking: msg.thinking,
        action: msg.action,
        layer: msg.layer,
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

    // Ignore messages not meant for the dashboard (agent protocol messages)
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

  // Subscribe to incoming messages
  wsService.onMessage(handleMessage);

  // Connect to the bridge server
  wsService.connect();

  // Send dashboard hello once connected
  useConnectionStore.subscribe((state) => {
    if (state.status === 'connected') {
      const hello: DashboardHello = {
        type: 'dashboard_hello',
        dashboardId: `dashboard_${Date.now()}`,
        version: '0.1.0',
      };
      wsService.send(hello as unknown as Record<string, unknown>);
    }
  });
}
