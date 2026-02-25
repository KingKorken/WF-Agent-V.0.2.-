/**
 * Workflow Executor — Converts a WorkflowDefinition into a structured goal for the agent loop.
 *
 * For the prototype, this is a THIN wrapper: it formats the workflow as a detailed
 * goal string that gets passed to runAgentLoop(). The agent loop then executes with
 * full Claude reasoning per step, but with the structure and plan provided.
 *
 * In production, this would handle each step more mechanically, with the LLM only
 * involved for decision points and error handling.
 */

import type { WorkflowDefinition } from './workflow-types';

/**
 * Format a WorkflowDefinition into a structured goal string for the agent loop.
 *
 * @param workflow - The parsed workflow definition
 * @returns A formatted goal string ready for runAgentLoop()
 */
export function formatWorkflowAsGoal(workflow: WorkflowDefinition): string {
  const parts: string[] = [];

  // Header
  parts.push(`Execute the following workflow: "${workflow.name}"`);
  parts.push('');
  parts.push(workflow.description);
  parts.push('');

  // Applications
  if (workflow.applications.length > 0) {
    parts.push('Applications needed:');
    for (const app of workflow.applications) {
      const urlPart = app.url ? ` — ${app.url}` : '';
      parts.push(`  - ${app.name} (${app.type}, use ${app.preferredLayer} layer${urlPart})`);
    }
    parts.push('');
  }

  // Steps
  parts.push('Steps:');
  const loopStepIds = new Set(workflow.loops?.stepsInLoop ?? []);
  let inLoop = false;

  for (const step of workflow.steps) {
    const isLoopStep = loopStepIds.has(step.id);

    // Show loop header before first loop step
    if (isLoopStep && !inLoop && workflow.loops) {
      inLoop = true;
      parts.push(`  For each ${workflow.loops.variable} in ${workflow.loops.over} (from ${workflow.loops.source}):`);
    }
    if (!isLoopStep && inLoop) {
      inLoop = false; // exited loop
    }

    const indent = isLoopStep ? '    ' : '  ';
    const stepLabel = `${step.id}.`;
    parts.push(`${indent}${stepLabel} ${step.description} [${step.layer}/${step.action}]`);

    // Show key params
    const paramEntries = Object.entries(step.params);
    if (paramEntries.length > 0) {
      const paramStr = paramEntries
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(', ');
      parts.push(`${indent}   Params: ${paramStr}`);
    }

    if (step.output) {
      parts.push(`${indent}   → Store result in: ${step.output}`);
    }
    if (step.verification) {
      parts.push(`${indent}   Verify: ${step.verification}`);
    }
  }
  parts.push('');

  // Variables
  if (workflow.variables.length > 0) {
    parts.push('Variables:');
    for (const v of workflow.variables) {
      parts.push(`  - ${v.name} (${v.type}): ${v.description} — source: ${v.source}`);
    }
    parts.push('');
  }

  // Business rules
  if (workflow.rules && workflow.rules.length > 0) {
    parts.push('Business Rules:');
    for (const rule of workflow.rules) {
      parts.push(`  - If ${rule.condition} → ${rule.action}`);
    }
    parts.push('');
  }

  parts.push('Execute each step in order. Use the specified layer for each step. Report when complete.');

  return parts.join('\n');
}
