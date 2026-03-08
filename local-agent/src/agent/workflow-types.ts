/**
 * Workflow Types — Re-exported from shared package.
 *
 * These types were originally defined here but have been moved to @workflow-agent/shared
 * so both the server and local-agent can reference them without duplication.
 */

export type {
  WorkflowDefinition,
  ApplicationMapping,
  WorkflowVariable,
  WorkflowStep,
  LoopDefinition,
  BusinessRule,
} from '@workflow-agent/shared';
