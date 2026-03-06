/**
 * Workflow Manager — List, get, and delete workflow JSON files from disk.
 *
 * Workflows are stored at local-agent/workflows/<id>.json.
 * This module provides CRUD operations (minus create, which is handled by workflow-parser).
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkflowSummary } from '@workflow-agent/shared';
import { log, warn } from '../utils/logger';

// Compiled JS at local-agent/dist/src/workflows/workflow-manager.js
// Workflows dir at local-agent/workflows/
const WORKFLOWS_DIR = path.join(__dirname, '../../../workflows');

/**
 * List all workflows, returning a WorkflowSummary for each valid JSON file.
 * Skips files that fail to parse (logs a warning).
 */
export function listWorkflows(): WorkflowSummary[] {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    return [];
  }

  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'));
  const summaries: WorkflowSummary[] = [];

  for (const file of files) {
    const filePath = path.join(WORKFLOWS_DIR, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const workflow = JSON.parse(raw);

      if (!workflow.id || !workflow.name) {
        warn(`[workflow-manager] Skipping ${file}: missing id or name`);
        continue;
      }

      summaries.push({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description || '',
        createdAt: workflow.createdAt || '',
        applicationCount: Array.isArray(workflow.applications) ? workflow.applications.length : 0,
        stepCount: Array.isArray(workflow.steps) ? workflow.steps.length : 0,
      });
    } catch (err) {
      warn(`[workflow-manager] Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sort by createdAt descending (newest first)
  summaries.sort((a, b) => {
    if (!a.createdAt || !b.createdAt) return 0;
    return b.createdAt.localeCompare(a.createdAt);
  });

  log(`[workflow-manager] Listed ${summaries.length} workflows`);
  return summaries;
}

/**
 * Get a full workflow definition by ID.
 * Returns the parsed JSON object, or null if not found.
 */
export function getWorkflow(workflowId: string): Record<string, unknown> | null {
  const filePath = path.join(WORKFLOWS_DIR, `${workflowId}.json`);

  if (!fs.existsSync(filePath)) {
    warn(`[workflow-manager] Workflow not found: ${workflowId}`);
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    warn(`[workflow-manager] Failed to read ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Delete a workflow by ID.
 * Idempotent — returns true even if the file doesn't exist.
 */
export function deleteWorkflow(workflowId: string): boolean {
  const filePath = path.join(WORKFLOWS_DIR, `${workflowId}.json`);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log(`[workflow-manager] Deleted workflow: ${workflowId}`);
    } else {
      log(`[workflow-manager] Workflow already absent: ${workflowId}`);
    }
    return true;
  } catch (err) {
    warn(`[workflow-manager] Failed to delete ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
