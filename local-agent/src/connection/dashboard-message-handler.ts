/**
 * Dashboard Message Handler — Handles recording and workflow CRUD messages
 * from the dashboard (relayed through the server).
 *
 * These messages have their own type field (e.g. 'dashboard_start_recording')
 * and are distinct from AgentCommand messages handled by command-handler.ts.
 */

import {
  DashboardStartRecording,
  DashboardStopRecording,
  DashboardListWorkflows,
  DashboardGetWorkflow,
  DashboardDeleteWorkflow,
  ServerRequestWorkflow,
  AgentRecordingStarted,
  AgentRecordingStopped,
  AgentRecordingParsing,
  AgentWorkflowParsed,
  AgentWorkflowData,
  AgentRecordingError,
  WorkflowSummary,
  WorkflowDefinition,
} from '@workflow-agent/shared';
import { startSession, stopSession, getStatus } from '../recorder/session-manager';
import { listWorkflows, getWorkflow, deleteWorkflow } from '../workflows/workflow-manager';
import { parseRecordingToWorkflow } from '../agent/workflow-parser';
import { log, error as logError } from '../utils/logger';

/** Maximum recording duration: 30 minutes */
const MAX_RECORDING_MS = 30 * 60 * 1000;

/** Grace period before auto-stopping on disconnect: 30 seconds */
const DISCONNECT_GRACE_MS = 30 * 1000;

/** Active recording timeout timer */
let recordingTimeout: ReturnType<typeof setTimeout> | null = null;

/** Disconnect grace period timer */
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Reference to the send function for auto-stop scenarios */
let activeSendFn: ((msg: string) => void) | null = null;

type SendFn = (message: string) => void;

/**
 * Handle a raw WebSocket message if it's a dashboard message type.
 * Returns true if the message was handled, false if it should fall through
 * to the command handler.
 */
export async function handleDashboardMessage(
  rawMessage: string,
  send: SendFn
): Promise<boolean> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }

  const type = parsed.type as string;

  switch (type) {
    case 'dashboard_start_recording':
      await handleStartRecording(parsed as unknown as DashboardStartRecording, send);
      return true;

    case 'dashboard_stop_recording':
      await handleStopRecording(send);
      return true;

    case 'dashboard_list_workflows':
      handleListWorkflows(send);
      return true;

    case 'dashboard_get_workflow':
      handleGetWorkflow(parsed as unknown as DashboardGetWorkflow, send);
      return true;

    case 'dashboard_delete_workflow':
      handleDeleteWorkflow(parsed as unknown as DashboardDeleteWorkflow, send);
      return true;

    case 'server_request_workflow':
      handleWorkflowRequest(parsed as unknown as ServerRequestWorkflow, send);
      return true;

    default:
      return false;
  }
}

/**
 * Called when the WebSocket connection to the server drops.
 * Starts a grace period timer — if not reconnected, auto-stops recording.
 */
export function onConnectionLost(): void {
  const status = getStatus();
  if (status.status !== 'recording') return;

  log('[dashboard-msg] Connection lost during recording — starting 30s grace period');
  disconnectTimer = setTimeout(async () => {
    const current = getStatus();
    if (current.status === 'recording') {
      log('[dashboard-msg] Grace period expired — auto-stopping recording');
      await autoStopRecording();
    }
  }, DISCONNECT_GRACE_MS);
}

/**
 * Called when the WebSocket connection is re-established.
 * Cancels the disconnect grace period.
 */
export function onConnectionRestored(): void {
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
    log('[dashboard-msg] Connection restored — cancelled auto-stop timer');
  }
}

// ---------------------------------------------------------------------------
// Recording handlers
// ---------------------------------------------------------------------------

async function handleStartRecording(msg: DashboardStartRecording, send: SendFn): Promise<void> {
  const status = getStatus();
  if (status.status === 'recording') {
    const errorMsg: AgentRecordingError = {
      type: 'agent_recording_error',
      error: 'A recording is already in progress.',
    };
    send(JSON.stringify(errorMsg));
    return;
  }

  try {
    const session = await startSession(msg.description || 'Untitled recording');
    activeSendFn = send;

    // Set 30-minute recording timeout
    recordingTimeout = setTimeout(async () => {
      log('[dashboard-msg] Recording timeout (30 min) — auto-stopping');
      await autoStopRecording();
    }, MAX_RECORDING_MS);

    const response: AgentRecordingStarted = {
      type: 'agent_recording_started',
      sessionId: session.id,
    };
    send(JSON.stringify(response));
  } catch (err) {
    const errorMsg: AgentRecordingError = {
      type: 'agent_recording_error',
      error: `Failed to start recording: ${err instanceof Error ? err.message : String(err)}`,
    };
    send(JSON.stringify(errorMsg));
  }
}

async function handleStopRecording(send: SendFn): Promise<void> {
  clearRecordingTimeout();

  const status = getStatus();
  if (status.status !== 'recording') {
    const errorMsg: AgentRecordingError = {
      type: 'agent_recording_error',
      error: 'No active recording to stop.',
    };
    send(JSON.stringify(errorMsg));
    return;
  }

  try {
    const session = await stopSession();

    const stoppedMsg: AgentRecordingStopped = {
      type: 'agent_recording_stopped',
      sessionId: session.id,
    };
    send(JSON.stringify(stoppedMsg));

    // Auto-parse the recording into a workflow
    await triggerAutoParse(session.id, session.dir, send);
  } catch (err) {
    const errorMsg: AgentRecordingError = {
      type: 'agent_recording_error',
      error: `Failed to stop recording: ${err instanceof Error ? err.message : String(err)}`,
    };
    send(JSON.stringify(errorMsg));
  }
}

async function triggerAutoParse(sessionId: string, sessionDir: string, send: SendFn): Promise<void> {
  // Notify dashboard that parsing has started
  const parsingMsg: AgentRecordingParsing = {
    type: 'agent_recording_parsing',
  };
  send(JSON.stringify(parsingMsg));

  try {
    log(`[dashboard-msg] Auto-parsing recording: ${sessionId}`);
    const workflow = await parseRecordingToWorkflow(sessionDir);

    const summary: WorkflowSummary = {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      createdAt: workflow.createdAt,
      applicationCount: workflow.applications.length,
      stepCount: workflow.steps.length,
    };

    const parsedMsg: AgentWorkflowParsed = {
      type: 'agent_workflow_parsed',
      workflow: summary,
    };
    send(JSON.stringify(parsedMsg));
    log(`[dashboard-msg] Workflow parsed successfully: ${workflow.id} (${workflow.name})`);
  } catch (err) {
    logError(`[dashboard-msg] Auto-parse failed: ${err instanceof Error ? err.message : String(err)}`);
    const errorMsg: AgentRecordingError = {
      type: 'agent_recording_error',
      error: `Workflow parsing failed: ${err instanceof Error ? err.message : String(err)}. Raw recording is preserved on disk.`,
    };
    send(JSON.stringify(errorMsg));
  }
}

async function autoStopRecording(): Promise<void> {
  clearRecordingTimeout();

  try {
    const session = await stopSession();

    if (activeSendFn) {
      const stoppedMsg: AgentRecordingStopped = {
        type: 'agent_recording_stopped',
        sessionId: session.id,
      };
      activeSendFn(JSON.stringify(stoppedMsg));

      await triggerAutoParse(session.id, session.dir, activeSendFn);
    }
  } catch (err) {
    logError(`[dashboard-msg] Auto-stop failed: ${err instanceof Error ? err.message : String(err)}`);
    if (activeSendFn) {
      const errorMsg: AgentRecordingError = {
        type: 'agent_recording_error',
        error: `Auto-stop failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      activeSendFn(JSON.stringify(errorMsg));
    }
  } finally {
    activeSendFn = null;
  }
}

function clearRecordingTimeout(): void {
  if (recordingTimeout) {
    clearTimeout(recordingTimeout);
    recordingTimeout = null;
  }
}

// ---------------------------------------------------------------------------
// Workflow CRUD handlers
// ---------------------------------------------------------------------------

function handleListWorkflows(send: SendFn): void {
  const workflows = listWorkflows();
  send(JSON.stringify({
    type: 'agent_workflow_list',
    workflows,
  }));
}

function handleGetWorkflow(msg: DashboardGetWorkflow, send: SendFn): void {
  const workflow = getWorkflow(msg.workflowId);
  if (workflow) {
    send(JSON.stringify({
      type: 'agent_workflow_detail',
      workflow,
    }));
  } else {
    send(JSON.stringify({
      type: 'agent_recording_error',
      error: `Workflow not found: ${msg.workflowId}`,
    }));
  }
}

function handleDeleteWorkflow(msg: DashboardDeleteWorkflow, send: SendFn): void {
  deleteWorkflow(msg.workflowId);
  send(JSON.stringify({
    type: 'agent_workflow_deleted',
    workflowId: msg.workflowId,
  }));
}

// ---------------------------------------------------------------------------
// Workflow fetch handler (server requests workflow definition for execution)
// ---------------------------------------------------------------------------

function handleWorkflowRequest(msg: ServerRequestWorkflow, send: SendFn): void {
  const { requestId, workflowId } = msg;
  log(`[dashboard-msg] Workflow data requested: ${workflowId} (requestId: ${requestId.slice(0, 8)})`);

  const workflow = getWorkflow(workflowId);

  if (workflow) {
    const response: AgentWorkflowData = {
      type: 'agent_workflow_data',
      requestId,
      workflowId,
      found: true,
      workflow: workflow as unknown as WorkflowDefinition,
    };
    send(JSON.stringify(response));
    log(`[dashboard-msg] Sent workflow data: ${workflowId}`);
  } else {
    const response: AgentWorkflowData = {
      type: 'agent_workflow_data',
      requestId,
      workflowId,
      found: false,
      error: `Workflow not found: ${workflowId}`,
    };
    send(JSON.stringify(response));
    log(`[dashboard-msg] Workflow not found: ${workflowId}`);
  }
}
