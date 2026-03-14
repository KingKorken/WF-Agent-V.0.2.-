/**
 * Audit Logger — Event capture, compliance enrichment, hash chaining, and WebSocket emission.
 *
 * Intercepts AgentLoopCallbacks in bridge.ts, enriches events with compliance fields,
 * splits into L1 (operational) + L2 (compliance) layers, computes per-session SHA-256
 * hash chains, persists to audit.db, and emits server_audit_entry WebSocket messages.
 *
 * Safety: All operations use the safe wrapper pattern — audit failures never interrupt
 * the agent execution relay path. A missing audit entry is better than a crashed workflow.
 *
 * Regulatory coverage: GDPR Art. 5(2), BDSG §76, EU AI Act Art. 12/14, ISO 27001 A.8.15
 */

import * as crypto from 'crypto';
import type {
  AuditSession,
  AuditEventOperational,
  AuditEventCompliance,
  AuditTerminalState,
  AuditEventType,
  AuditActionType,
  AuditControlLayer,
  SHA256Hash,
  ServerAuditEntry,
  ServerAuditSessionStart,
  ServerAuditSessionEnd,
} from '@workflow-agent/shared';
import {
  insertSession,
  updateSessionEnd,
  updateSessionStepCount,
  insertEventPair,
  getLastHashForSession,
} from './audit-database';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Genesis hash — start of every per-session hash chain */
const GENESIS_HASH: SHA256Hash = '0'.repeat(64) as SHA256Hash;

/** Hardcoded compliance defaults (no per-workflow metadata system exists yet) */
const COMPLIANCE_DEFAULTS = {
  purpose: 'Workflow automation — task execution',
  legalBasis: 'Art. 6(1)(b) contract',
  department: '',
  llmDataTransferDestination: process.env.LLM_API_REGION || 'us-east',
  llmModelProvider: 'Anthropic',
  llmModelVersion: 'claude-sonnet-4-20250514',
  purposeLimitationScope: 'Automated workflow execution',
} as const;

// ---------------------------------------------------------------------------
// Pseudonymization (HMAC-SHA256 with Fly.io secret salt)
// ---------------------------------------------------------------------------

const PSEUDONYM_SALT = process.env.AUDIT_PSEUDONYM_SALT || '';

if (!PSEUDONYM_SALT) {
  console.warn('[audit-logger] WARNING: AUDIT_PSEUDONYM_SALT not set — pseudonymization is degraded (plain SHA-256 fallback)');
}

/** Compute pseudonymized user ID using HMAC-SHA256 */
function pseudonymize(userId: string): string {
  if (PSEUDONYM_SALT) {
    return crypto.createHmac('sha256', PSEUDONYM_SALT).update(userId).digest('hex');
  }
  // Fallback: plain SHA-256 (degraded, but functional)
  return crypto.createHash('sha256').update(userId).digest('hex');
}

// ---------------------------------------------------------------------------
// Per-session caches (in-memory, cleared on session end)
// ---------------------------------------------------------------------------

/** Last hash per session — eliminates 1 SELECT per event */
const hashCache = new Map<string, SHA256Hash>();

/** Pseudonymized user ID per session — avoids recomputation */
const pseudonymCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Hash chain computation
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash for a compliance event entry.
 * Includes all semantic fields to prevent field-swapping attacks.
 * Uses deterministic JSON serialization for reproducibility.
 */
function computeEntryHash(
  previousHash: SHA256Hash,
  id: string,
  timestamp: string,
  sessionId: string,
  eventType: AuditEventType,
  actionType: AuditActionType,
  action: string,
  result: string,
  userPseudonymId: string,
  inputHash: string | null,
  outputSummary: string | null,
): SHA256Hash {
  const fields = {
    action,
    actionType,
    eventType,
    id,
    inputHash: inputHash || '',
    outputSummary: outputSummary || '',
    previousHash,
    result,
    sessionId,
    timestamp,
    userPseudonymId,
  };
  // Deterministic serialization: keys are already sorted alphabetically above
  const payload = JSON.stringify(fields, Object.keys(fields).sort());
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  return hash as SHA256Hash;
}

// ---------------------------------------------------------------------------
// Public API — Session lifecycle
// ---------------------------------------------------------------------------

/** Room broadcast function type — injected from bridge.ts to avoid circular deps */
export type BroadcastFn = (message: ServerAuditEntry | ServerAuditSessionStart | ServerAuditSessionEnd) => void;

/**
 * Start a new audit session for a workflow execution.
 * Creates the session record and caches the genesis hash.
 *
 * @returns sessionId (UUID) for use in subsequent logAuditEvent calls
 */
export function startAuditSession(
  roomId: string,
  userId: string | null,
  workflowId: string | null,
  workflowName: string,
  triggerType: 'manual' | 'scheduled' | 'event',
  broadcastFn: BroadcastFn,
): string {
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userPseudonymId = userId ? pseudonymize(userId) : pseudonymize('anonymous');

  // Cache pseudonym for this session
  pseudonymCache.set(sessionId, userPseudonymId);
  // Initialize hash chain with genesis hash
  hashCache.set(sessionId, GENESIS_HASH);

  const session: AuditSession = {
    id: sessionId,
    roomId,
    userId,
    userPseudonymId,
    agentId: null,
    workflowId,
    workflowName,
    department: COMPLIANCE_DEFAULTS.department,
    triggerType,
    terminalState: 'in_progress',
    startTime: now,
    endTime: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    modelVersions: null,
    stepCount: 0,
    humanOversightEvents: null,
    riskFlags: null,
    recordingIndicatorVisible: true,
    noEmployeeComparison: true,
    purposeLimitationScope: COMPLIANCE_DEFAULTS.purposeLimitationScope,
    createdAt: now,
  };

  try {
    insertSession(session);

    // Emit session start to dashboard
    broadcastFn({
      type: 'server_audit_session_start',
      session,
    });

    console.log(`[audit-logger] Session started: ${sessionId} (workflow: ${workflowName})`);
  } catch (err) {
    console.error(`[audit-logger] Failed to start session: ${err instanceof Error ? err.message : String(err)}`);
    // Safe wrapper: clean up caches but don't throw
    hashCache.delete(sessionId);
    pseudonymCache.delete(sessionId);
  }

  return sessionId;
}

/**
 * End an audit session with a terminal state.
 * Clears per-session caches.
 */
export function endAuditSession(
  sessionId: string,
  terminalState: AuditTerminalState,
  stepCount: number,
  broadcastFn: BroadcastFn,
): void {
  try {
    updateSessionEnd(sessionId, terminalState, stepCount);

    broadcastFn({
      type: 'server_audit_session_end',
      sessionId,
      terminalState,
      endTime: new Date().toISOString(),
      stepCount,
    });

    console.log(`[audit-logger] Session ended: ${sessionId} (state: ${terminalState}, steps: ${stepCount})`);
  } catch (err) {
    console.error(`[audit-logger] Failed to end session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Always clean up caches
    hashCache.delete(sessionId);
    pseudonymCache.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Public API — Event logging
// ---------------------------------------------------------------------------

export interface AuditEventData {
  sessionId: string;
  roomId: string;
  userId: string | null;
  eventType: AuditEventType;
  actionType: AuditActionType;
  action: string;
  result: 'success' | 'failure';
  controlLayer?: AuditControlLayer | null;
  inputHash?: string | null;
  outputSummary?: string | null;
  reasoningContext?: string | null;
  durationMs?: number | null;
  entityId?: string | null;
  entityType?: string | null;
  originalValue?: string | null;
  newValue?: string | null;
  workflowName: string;
  stepCount: number;
}

/**
 * Log a single audit event — the core function called from bridge.ts callbacks.
 *
 * Creates paired L1 + L2 entries in a single transaction, computes hash chain,
 * and emits a WebSocket message to the dashboard. All in a safe wrapper.
 */
export function logAuditEvent(
  data: AuditEventData,
  broadcastFn: BroadcastFn,
): void {
  try {
    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    // Get cached pseudonym (or compute fresh)
    let userPseudonymId = pseudonymCache.get(data.sessionId);
    if (!userPseudonymId) {
      userPseudonymId = data.userId ? pseudonymize(data.userId) : pseudonymize('anonymous');
      pseudonymCache.set(data.sessionId, userPseudonymId);
    }

    // Get previous hash from cache (or fall back to DB query)
    let previousHash = hashCache.get(data.sessionId);
    if (!previousHash) {
      previousHash = getLastHashForSession(data.sessionId) || GENESIS_HASH;
    }

    // Compute entry hash
    const entryHash = computeEntryHash(
      previousHash,
      eventId,
      now,
      data.sessionId,
      data.eventType,
      data.actionType,
      data.action,
      data.result,
      userPseudonymId,
      data.inputHash || null,
      data.outputSummary || null,
    );

    // Build L1 (operational) entry
    const operational: AuditEventOperational = {
      id: eventId,
      sessionId: data.sessionId,
      userId: data.userId,
      humanVerifierId: null,
      recipientId: null,
      originalValue: data.originalValue || null,
      newValue: data.newValue || null,
      sourceIp: null,
      sourceDevice: null,
      sourceSessionId: null,
      createdAt: now,
    };

    // Build L2 (compliance) entry
    const compliance: AuditEventCompliance = {
      id: eventId,
      sessionId: data.sessionId,
      userPseudonymId,
      timestamp: now,
      timezone,
      eventType: data.eventType,
      actionType: data.actionType,
      action: data.action,
      entityId: data.entityId || null,
      entityType: data.entityType || null,
      purpose: COMPLIANCE_DEFAULTS.purpose,
      legalBasis: COMPLIANCE_DEFAULTS.legalBasis,
      result: data.result,
      inputHash: data.inputHash || null,
      outputSummary: data.outputSummary || null,
      reasoningContext: data.reasoningContext || null,
      controlLayer: data.controlLayer || null,
      authorizationScope: null,
      durationMs: data.durationMs || null,
      llmDataTransferDestination: COMPLIANCE_DEFAULTS.llmDataTransferDestination,
      llmModelProvider: COMPLIANCE_DEFAULTS.llmModelProvider,
      llmModelVersion: COMPLIANCE_DEFAULTS.llmModelVersion,
      recordingIndicatorVisible: true,
      noEmployeeComparison: true,
      purposeLimitationScope: COMPLIANCE_DEFAULTS.purposeLimitationScope,
      previousHash,
      entryHash,
      createdAt: now,
    };

    // Persist both layers in a single transaction
    insertEventPair(operational, compliance);

    // Update cache AFTER successful transaction commit
    hashCache.set(data.sessionId, entryHash);

    // Emit to dashboard
    broadcastFn({
      type: 'server_audit_entry',
      entry: compliance,
      sessionInfo: {
        workflowName: data.workflowName,
        stepCount: data.stepCount,
      },
    });
  } catch (err) {
    // Safe wrapper: log error, never throw
    console.error(`[audit-logger] Failed to log event for session ${data.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Update the step count for an active session.
 * Safe wrapper — never throws.
 */
export function updateAuditSessionStepCount(sessionId: string, stepCount: number): void {
  try {
    updateSessionStepCount(sessionId, stepCount);
  } catch (err) {
    console.error(`[audit-logger] Failed to update step count for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
