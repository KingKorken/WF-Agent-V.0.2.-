import { create } from 'zustand';

export type WorkflowStatus = 'active' | 'failed-last-run' | 'never-run';

export interface Workflow {
  id: string;
  name: string;
  department: string;
  description: string;
  lastRun: Date | null;
  lastRunSuccess: boolean | null;
  status: WorkflowStatus;
}

export interface QueuedWorkflow {
  workflowId: string;
  name: string;
  progress: string; // e.g., "29/47"
  currentStep: string;
  position: number; // 0 = currently executing
}

interface WorkflowState {
  workflows: Workflow[];
  queue: QueuedWorkflow[];
  executingWorkflow: QueuedWorkflow | null;
  expandedWorkflowId: string | null;
  setExpandedWorkflow: (id: string | null) => void;
  queueWorkflow: (workflow: QueuedWorkflow) => void;
  removeFromQueue: (workflowId: string) => void;
  updateQueueProgress: (workflowId: string, progress: string, currentStep: string) => void;
  startExecution: (workflowId: string) => void;
  completeExecution: (workflowId: string) => void;
  cancelQueued: (workflowId: string) => void;
}

// Mock data for development — remove when connecting to real API
const MOCK_WORKFLOWS: Workflow[] = [
  { id: '1', name: 'Monthly Payroll', department: 'HR', description: 'Process monthly payroll for all employees', lastRun: new Date('2026-02-28'), lastRunSuccess: true, status: 'active' },
  { id: '2', name: 'Employee Onboarding', department: 'HR', description: 'New employee onboarding checklist and setup', lastRun: new Date('2026-02-15'), lastRunSuccess: true, status: 'active' },
  { id: '3', name: 'Monthly Closing', department: 'Controlling', description: 'End-of-month financial closing process', lastRun: new Date('2026-02-28'), lastRunSuccess: false, status: 'failed-last-run' },
  { id: '4', name: 'Invoice Processing', department: 'Controlling', description: 'Process and verify incoming invoices', lastRun: null, lastRunSuccess: null, status: 'never-run' },
  { id: '5', name: 'Vendor Evaluation', department: 'Procurement', description: 'Quarterly vendor performance evaluation', lastRun: new Date('2026-01-15'), lastRunSuccess: true, status: 'active' },
];

export const useWorkflowStore = create<WorkflowState>((set) => ({
  workflows: MOCK_WORKFLOWS,
  queue: [],
  executingWorkflow: null,
  expandedWorkflowId: null,

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
      // Promote next in queue to position 0
      const nextQueue = newQueue.map((q, i) => ({
        ...q,
        position: i,
      }));
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
