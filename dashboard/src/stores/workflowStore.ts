import { create } from 'zustand';
import type { WorkflowSummary } from '@shared/types';
import { wsService } from '../services/websocket';

export type RecordingState = 'idle' | 'recording' | 'parsing' | 'complete' | 'error';

export interface QueuedWorkflow {
  workflowId: string;
  name: string;
  progress: string; // e.g., "29/47"
  currentStep: string;
  position: number; // 0 = currently executing
}

interface WorkflowState {
  // Workflow library
  workflows: WorkflowSummary[];
  selectedWorkflow: Record<string, unknown> | null;
  loading: boolean;

  // Recording
  recordingState: RecordingState;
  recordingError: string | null;

  // Execution queue
  queue: QueuedWorkflow[];
  executingWorkflow: QueuedWorkflow | null;
  expandedWorkflowId: string | null;

  // Actions — send WebSocket commands
  fetchWorkflows: () => void;
  fetchWorkflowDetail: (id: string) => void;
  deleteWorkflow: (id: string) => void;
  startRecording: (description: string) => void;
  stopRecording: () => void;
  runWorkflow: (workflowId: string) => void;

  // Handlers — called by message-router
  setWorkflows: (list: WorkflowSummary[]) => void;
  setWorkflowDetail: (def: Record<string, unknown>) => void;
  removeWorkflow: (id: string) => void;
  setRecordingState: (state: RecordingState) => void;
  setRecordingError: (error: string | null) => void;
  addParsedWorkflow: (workflow: WorkflowSummary) => void;

  // Queue actions
  setExpandedWorkflow: (id: string | null) => void;
  queueWorkflow: (workflow: QueuedWorkflow) => void;
  removeFromQueue: (workflowId: string) => void;
  updateQueueProgress: (workflowId: string, progress: string, currentStep: string) => void;
  startExecution: (workflowId: string) => void;
  completeExecution: (workflowId: string) => void;
  cancelQueued: (workflowId: string) => void;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  workflows: [],
  selectedWorkflow: null,
  loading: false,

  recordingState: 'idle',
  recordingError: null,

  queue: [],
  executingWorkflow: null,
  expandedWorkflowId: null,

  // --- WebSocket command senders ---

  fetchWorkflows: () => {
    set({ loading: true });
    wsService.send({ type: 'dashboard_list_workflows' });
  },

  fetchWorkflowDetail: (id) => {
    wsService.send({ type: 'dashboard_get_workflow', workflowId: id });
  },

  deleteWorkflow: (id) => {
    wsService.send({ type: 'dashboard_delete_workflow', workflowId: id });
  },

  startRecording: (description) => {
    set({ recordingState: 'recording', recordingError: null });
    wsService.send({ type: 'dashboard_start_recording', description });
  },

  stopRecording: () => {
    wsService.send({ type: 'dashboard_stop_recording' });
  },

  runWorkflow: (workflowId) => {
    const { workflows, queue } = useWorkflowStore.getState();
    const workflow = workflows.find((w) => w.id === workflowId);
    if (!workflow) return;
    if (queue.some((q) => q.workflowId === workflowId)) return;

    const queued: QueuedWorkflow = {
      workflowId,
      name: workflow.name,
      progress: '0/0',
      currentStep: 'Starting...',
      position: queue.length,
    };

    useWorkflowStore.getState().queueWorkflow(queued);
    wsService.send({
      type: 'dashboard_workflow_run',
      workflowId,
      workflowName: workflow.name,
    });
  },

  // --- Handlers called by message-router ---

  setWorkflows: (list) => set({ workflows: list, loading: false }),

  setWorkflowDetail: (def) => set({ selectedWorkflow: def }),

  removeWorkflow: (id) =>
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== id),
      selectedWorkflow:
        state.selectedWorkflow && (state.selectedWorkflow as { id?: string }).id === id
          ? null
          : state.selectedWorkflow,
    })),

  setRecordingState: (recordingState) => set({ recordingState }),

  setRecordingError: (error) => set({ recordingError: error }),

  addParsedWorkflow: (workflow) =>
    set((state) => ({
      workflows: [workflow, ...state.workflows],
    })),

  // --- Queue management (unchanged from before) ---

  setExpandedWorkflow: (id) => set({ expandedWorkflowId: id }),

  queueWorkflow: (workflow) =>
    set((state) => {
      const newQueue = [...state.queue, workflow];
      return {
        queue: newQueue,
        executingWorkflow: newQueue.find((q) => q.position === 0) ?? null,
      };
    }),

  removeFromQueue: (workflowId) =>
    set((state) => {
      const newQueue = state.queue.filter((q) => q.workflowId !== workflowId);
      return {
        queue: newQueue,
        executingWorkflow: newQueue.find((q) => q.position === 0) ?? null,
      };
    }),

  updateQueueProgress: (workflowId, progress, currentStep) =>
    set((state) => {
      const newQueue = state.queue.map((q) =>
        q.workflowId === workflowId ? { ...q, progress, currentStep } : q
      );
      return {
        queue: newQueue,
        executingWorkflow: newQueue.find((q) => q.position === 0) ?? null,
      };
    }),

  startExecution: (workflowId) =>
    set((state) => {
      const newQueue = state.queue.map((q) =>
        q.workflowId === workflowId ? { ...q, position: 0 } : q
      );
      return {
        queue: newQueue,
        executingWorkflow: newQueue.find((q) => q.position === 0) ?? null,
      };
    }),

  completeExecution: (workflowId) =>
    set((state) => {
      const newQueue = state.queue.filter((q) => q.workflowId !== workflowId);
      const nextQueue = newQueue.map((q, i) => ({ ...q, position: i }));
      return {
        queue: nextQueue,
        executingWorkflow: nextQueue.find((q) => q.position === 0) ?? null,
      };
    }),

  cancelQueued: (workflowId) =>
    set((state) => {
      const newQueue = state.queue
        .filter((q) => q.workflowId !== workflowId)
        .map((q, i) => ({ ...q, position: i }));
      return {
        queue: newQueue,
        executingWorkflow: newQueue.find((q) => q.position === 0) ?? null,
      };
    }),
}));
