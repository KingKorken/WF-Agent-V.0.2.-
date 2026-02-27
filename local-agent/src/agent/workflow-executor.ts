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

import type { WorkflowDefinition, WorkflowStep } from './workflow-types';

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * Deep-clone a workflow and replace all {{variableName}} placeholders in
 * step params and descriptions with the provided runtime values.
 *
 * Throws if any {{variable}} is referenced but not provided in `values`.
 * Does NOT mutate the original workflow.
 */
export function resolveVariables(
  workflow: WorkflowDefinition,
  values: Record<string, string>
): WorkflowDefinition {
  // Deep clone so we never mutate the original
  const resolved: WorkflowDefinition = JSON.parse(JSON.stringify(workflow));

  // Collect all missing variables across the entire workflow before throwing
  const missing = new Set<string>();

  function replaceInString(str: string): string {
    return str.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
      if (varName in values) {
        return values[varName];
      }
      missing.add(varName);
      return `{{${varName}}}`; // leave as-is so error message shows all missing
    });
  }

  function replaceInValue(val: unknown): unknown {
    if (typeof val === 'string') return replaceInString(val);
    if (Array.isArray(val)) return val.map(replaceInValue);
    if (val !== null && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = replaceInValue(v);
      }
      return result;
    }
    return val;
  }

  for (const step of resolved.steps) {
    step.description = replaceInString(step.description);
    step.params = replaceInValue(step.params) as WorkflowStep['params'];
    if (step.verification) {
      step.verification = replaceInString(step.verification);
    }
  }

  if (missing.size > 0) {
    const names = Array.from(missing).sort().join(', ');
    throw new Error(
      `Missing variable values: ${names}. Provide these in the values map.`
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Goal formatting
// ---------------------------------------------------------------------------

/**
 * Format a WorkflowDefinition into a structured goal string for the agent loop.
 *
 * @param workflow - The parsed workflow definition
 * @param runtimeValues - Optional map of variable values to resolve before formatting
 * @returns A formatted goal string ready for runAgentLoop()
 */
export function formatWorkflowAsGoal(
  workflow: WorkflowDefinition,
  runtimeValues?: Record<string, string>
): string {
  const resolved = runtimeValues ? resolveVariables(workflow, runtimeValues) : workflow;
  const parts: string[] = [];

  // Header
  parts.push(`Execute the following workflow: "${resolved.name}"`);
  parts.push('');
  parts.push(resolved.description);
  parts.push('');

  // Applications
  if (resolved.applications.length > 0) {
    parts.push('Applications needed:');
    for (const app of resolved.applications) {
      const urlPart = app.url ? ` — ${app.url}` : '';
      parts.push(`  - ${app.name} (${app.type}, use ${app.preferredLayer} layer${urlPart})`);
    }
    parts.push('');
  }

  // Steps
  parts.push('Steps:');
  const loopStepIds = new Set(resolved.loops?.stepsInLoop ?? []);
  let inLoop = false;

  for (const step of resolved.steps) {
    const isLoopStep = loopStepIds.has(step.id);

    // Show loop header before first loop step
    if (isLoopStep && !inLoop && resolved.loops) {
      inLoop = true;
      parts.push(`  For each ${resolved.loops.variable} in ${resolved.loops.over} (from ${resolved.loops.source}):`);
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
  if (resolved.variables.length > 0) {
    parts.push('Variables:');
    for (const v of resolved.variables) {
      parts.push(`  - ${v.name} (${v.type}): ${v.description} — source: ${v.source}`);
    }
    parts.push('');
  }

  // Business rules
  if (resolved.rules && resolved.rules.length > 0) {
    parts.push('Business Rules:');
    for (const rule of resolved.rules) {
      parts.push(`  - If ${rule.condition} → ${rule.action}`);
    }
    parts.push('');
  }

  parts.push('Execute each step in order. Use the specified layer for each step. Report when complete.');

  return parts.join('\n');
}
