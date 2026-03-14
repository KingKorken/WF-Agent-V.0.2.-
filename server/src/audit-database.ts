/**
 * Audit Database — Compliance-grade SQLite persistence for audit trail.
 *
 * Separate from conversations.db per ISO 27001 separation requirement.
 * Uses two-layer architecture:
 *   - Layer 1 (audit_events_operational): Personal data, erasable for GDPR Art. 17
 *   - Layer 2 (audit_events_compliance): Pseudonymized, immutable, hash-chained
 *
 * Regulatory coverage: GDPR Art. 5(2), BDSG §76, EU AI Act Art. 12, ISO 27001 A.8.15
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  AuditSession,
  AuditEventOperational,
  AuditEventCompliance,
  AuditSessionFilters,
  AuditEventFilters,
  AuditTerminalState,
  SHA256Hash,
} from '@workflow-agent/shared';

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'audit.db');

let db: Database.Database;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initAuditDatabase(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  try {
    db = new Database(DB_PATH);
  } catch (err) {
    // Corrupt DB — rename and create fresh (data loss is better than crash loop)
    console.error('[audit-db] Failed to open DB, creating fresh:', err);
    const backupPath = DB_PATH + '.corrupt.' + Date.now();
    if (fs.existsSync(DB_PATH)) {
      fs.renameSync(DB_PATH, backupPath);
    }
    db = new Database(DB_PATH);
  }

  // CRITICAL: auto_vacuum must be set BEFORE table creation (cannot be changed retroactively)
  db.pragma('auto_vacuum = INCREMENTAL');

  // Performance and safety pragmas (same as database.ts)
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456'); // 256MB mmap for read performance
  db.pragma('cache_size = -8000');    // 8MB cache (negative = KB)

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_sessions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT,
      user_pseudonym_id TEXT NOT NULL,
      agent_id TEXT,
      workflow_id TEXT,
      workflow_name TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      terminal_state TEXT NOT NULL DEFAULT 'in_progress',
      start_time TEXT NOT NULL,
      end_time TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      model_versions TEXT,
      step_count INTEGER NOT NULL DEFAULT 0,
      human_oversight_events TEXT,
      risk_flags TEXT,
      recording_indicator_visible INTEGER NOT NULL DEFAULT 1,
      no_employee_comparison INTEGER NOT NULL DEFAULT 1,
      purpose_limitation_scope TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_sessions_room
      ON audit_sessions(room_id, start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_sessions_terminal_state
      ON audit_sessions(terminal_state);

    CREATE TABLE IF NOT EXISTS audit_events_operational (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      human_verifier_id TEXT,
      recipient_id TEXT,
      original_value TEXT,
      new_value TEXT,
      source_ip TEXT,
      source_device TEXT,
      source_session_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES audit_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_op_session
      ON audit_events_operational(session_id);

    CREATE TABLE IF NOT EXISTS audit_events_compliance (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_pseudonym_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      event_type TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT '',
      entity_id TEXT,
      entity_type TEXT,
      purpose TEXT NOT NULL DEFAULT '',
      legal_basis TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT 'success',
      input_hash TEXT,
      output_summary TEXT,
      reasoning_context TEXT,
      control_layer TEXT,
      authorization_scope TEXT,
      duration_ms INTEGER,
      llm_data_transfer_destination TEXT,
      llm_model_provider TEXT,
      llm_model_version TEXT,
      recording_indicator_visible INTEGER NOT NULL DEFAULT 1,
      no_employee_comparison INTEGER NOT NULL DEFAULT 1,
      purpose_limitation_scope TEXT NOT NULL DEFAULT '',
      previous_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES audit_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_comp_session_ts
      ON audit_events_compliance(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_events_comp_created
      ON audit_events_compliance(created_at);
  `);

  // Immutability triggers for compliance table
  // BEFORE UPDATE: always prevent modification
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_compliance_no_update
    BEFORE UPDATE ON audit_events_compliance
    BEGIN
      SELECT RAISE(ABORT, 'compliance entries are immutable');
    END;
  `);

  // BEFORE DELETE: prevent deletion unless entry is older than 13 months (395 days)
  // This allows retention cleanup to work while protecting recent entries
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_compliance_no_delete
    BEFORE DELETE ON audit_events_compliance
    WHEN julianday('now') - julianday(OLD.created_at) < 395
    BEGIN
      SELECT RAISE(ABORT, 'compliance entries cannot be deleted before retention period');
    END;
  `);

  // Startup diagnostics
  const auditSessionCount = (db.prepare('SELECT COUNT(*) as count FROM audit_sessions').get() as { count: number }).count;
  const auditEventCount = (db.prepare('SELECT COUNT(*) as count FROM audit_events_compliance').get() as { count: number }).count;
  let dbSizeKB = 0;
  try {
    const stat = fs.statSync(DB_PATH);
    dbSizeKB = Math.round(stat.size / 1024);
  } catch { /* non-critical */ }

  console.log(`[audit-db] Initialized at ${DB_PATH}`);
  console.log(`[audit-db] Sessions: ${auditSessionCount}, Events: ${auditEventCount}, Size: ${dbSizeKB}KB`);

  // Mark stale in_progress sessions as timeout (startup recovery)
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const staleResult = db.prepare(`
    UPDATE audit_sessions
    SET terminal_state = 'timeout', end_time = ?
    WHERE terminal_state = 'in_progress' AND start_time < ?
  `).run(new Date().toISOString(), thirtyMinutesAgo);
  if (staleResult.changes > 0) {
    console.log(`[audit-db] Recovered ${staleResult.changes} stale in_progress sessions (marked as timeout)`);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export function closeAuditDatabase(): void {
  if (!db) return;
  try {
    db.pragma('optimize');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('[audit-db] Closed cleanly');
  } catch (err) {
    console.error('[audit-db] Error closing:', err);
  }
}

// ---------------------------------------------------------------------------
// Prepared statements (lazily created)
// ---------------------------------------------------------------------------

let _stmts: ReturnType<typeof prepareStatements> | null = null;

function stmts() {
  if (!_stmts) _stmts = prepareStatements();
  return _stmts;
}

function prepareStatements() {
  return {
    insertSession: db.prepare(`
      INSERT INTO audit_sessions (
        id, room_id, user_id, user_pseudonym_id, agent_id,
        workflow_id, workflow_name, department, trigger_type, terminal_state,
        start_time, end_time, timezone, model_versions, step_count,
        human_oversight_events, risk_flags,
        recording_indicator_visible, no_employee_comparison, purpose_limitation_scope,
        created_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?
      )
    `),

    updateSessionEnd: db.prepare(`
      UPDATE audit_sessions
      SET terminal_state = ?, end_time = ?, step_count = ?
      WHERE id = ?
    `),

    updateSessionStepCount: db.prepare(`
      UPDATE audit_sessions SET step_count = ? WHERE id = ?
    `),

    insertEventOperational: db.prepare(`
      INSERT INTO audit_events_operational (
        id, session_id, user_id,
        human_verifier_id, recipient_id,
        original_value, new_value,
        source_ip, source_device, source_session_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    insertEventCompliance: db.prepare(`
      INSERT INTO audit_events_compliance (
        id, session_id, user_pseudonym_id, timestamp, timezone,
        event_type, action_type, action,
        entity_id, entity_type,
        purpose, legal_basis, result,
        input_hash, output_summary, reasoning_context,
        control_layer, authorization_scope, duration_ms,
        llm_data_transfer_destination, llm_model_provider, llm_model_version,
        recording_indicator_visible, no_employee_comparison, purpose_limitation_scope,
        previous_hash, entry_hash,
        created_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?
      )
    `),

    getSessionsByRoom: db.prepare(`
      SELECT * FROM audit_sessions
      WHERE room_id = ?
      ORDER BY start_time DESC
      LIMIT ?
    `),

    getSessionById: db.prepare(`
      SELECT * FROM audit_sessions WHERE id = ? AND room_id = ?
    `),

    getEventsBySession: db.prepare(`
      SELECT c.*, o.user_id, o.human_verifier_id, o.recipient_id,
             o.original_value, o.new_value,
             o.source_ip, o.source_device, o.source_session_id
      FROM audit_events_compliance c
      LEFT JOIN audit_events_operational o ON c.id = o.id
      WHERE c.session_id = ?
      ORDER BY c.timestamp ASC
      LIMIT ?
    `),

    getLastHashForSession: db.prepare(`
      SELECT entry_hash FROM audit_events_compliance
      WHERE session_id = ?
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `),

    getSessionsFiltered: db.prepare(`
      SELECT * FROM audit_sessions
      WHERE room_id = ?
        AND (? IS NULL OR start_time >= ?)
        AND (? IS NULL OR start_time <= ?)
        AND (? IS NULL OR department = ?)
        AND (? IS NULL OR terminal_state = ?)
        AND (? IS NULL OR workflow_id = ?)
      ORDER BY start_time DESC
      LIMIT ?
    `),

    getEventsForExport: db.prepare(`
      SELECT c.*, o.user_id, o.human_verifier_id, o.recipient_id,
             o.original_value, o.new_value,
             o.source_ip, o.source_device, o.source_session_id
      FROM audit_events_compliance c
      LEFT JOIN audit_events_operational o ON c.id = o.id
      WHERE c.session_id = ?
      ORDER BY c.timestamp ASC
    `),

    countEventsBySession: db.prepare(`
      SELECT COUNT(*) as count FROM audit_events_compliance WHERE session_id = ?
    `),
  };
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export function insertSession(session: AuditSession): void {
  stmts().insertSession.run(
    session.id,
    session.roomId,
    session.userId,
    session.userPseudonymId,
    session.agentId,
    session.workflowId,
    session.workflowName,
    session.department,
    session.triggerType,
    session.terminalState,
    session.startTime,
    session.endTime,
    session.timezone,
    session.modelVersions,
    session.stepCount,
    session.humanOversightEvents,
    session.riskFlags,
    session.recordingIndicatorVisible ? 1 : 0,
    session.noEmployeeComparison ? 1 : 0,
    session.purposeLimitationScope,
    session.createdAt,
  );
}

export function updateSessionEnd(
  sessionId: string,
  terminalState: AuditTerminalState,
  stepCount: number,
): void {
  stmts().updateSessionEnd.run(
    terminalState,
    new Date().toISOString(),
    stepCount,
    sessionId,
  );
}

export function updateSessionStepCount(sessionId: string, stepCount: number): void {
  stmts().updateSessionStepCount.run(stepCount, sessionId);
}

// ---------------------------------------------------------------------------
// Event CRUD (transactional L1 + L2 insert)
// ---------------------------------------------------------------------------

/**
 * Insert a paired L1 (operational) + L2 (compliance) event in a single transaction.
 * This prevents orphaned records and hash chain gaps.
 */
export function insertEventPair(
  operational: AuditEventOperational,
  compliance: AuditEventCompliance,
): void {
  const txn = db.transaction(() => {
    stmts().insertEventOperational.run(
      operational.id,
      operational.sessionId,
      operational.userId,
      operational.humanVerifierId,
      operational.recipientId,
      operational.originalValue,
      operational.newValue,
      operational.sourceIp,
      operational.sourceDevice,
      operational.sourceSessionId,
      operational.createdAt,
    );

    stmts().insertEventCompliance.run(
      compliance.id,
      compliance.sessionId,
      compliance.userPseudonymId,
      compliance.timestamp,
      compliance.timezone,
      compliance.eventType,
      compliance.actionType,
      compliance.action,
      compliance.entityId,
      compliance.entityType,
      compliance.purpose,
      compliance.legalBasis,
      compliance.result,
      compliance.inputHash,
      compliance.outputSummary,
      compliance.reasoningContext,
      compliance.controlLayer,
      compliance.authorizationScope,
      compliance.durationMs,
      compliance.llmDataTransferDestination,
      compliance.llmModelProvider,
      compliance.llmModelVersion,
      compliance.recordingIndicatorVisible ? 1 : 0,
      compliance.noEmployeeComparison ? 1 : 0,
      compliance.purposeLimitationScope,
      compliance.previousHash,
      compliance.entryHash,
      compliance.createdAt,
    );
  });

  txn.immediate();
}

// ---------------------------------------------------------------------------
// Query operations
// ---------------------------------------------------------------------------

export function getLastHashForSession(sessionId: string): SHA256Hash | null {
  const row = stmts().getLastHashForSession.get(sessionId) as { entry_hash: string } | undefined;
  return row ? (row.entry_hash as SHA256Hash) : null;
}

export function querySessionsFiltered(filters: AuditSessionFilters): AuditSession[] {
  const limit = filters.limit || 50;
  const rows = stmts().getSessionsFiltered.all(
    filters.roomId,
    filters.dateFrom || null, filters.dateFrom || null,
    filters.dateTo || null, filters.dateTo || null,
    filters.department || null, filters.department || null,
    filters.terminalState || null, filters.terminalState || null,
    filters.workflowId || null, filters.workflowId || null,
    limit,
  ) as Array<Record<string, unknown>>;

  return rows.map(rowToSession);
}

export function getSessionById(sessionId: string, roomId: string): AuditSession | null {
  const row = stmts().getSessionById.get(sessionId, roomId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function queryEventsBySession(sessionId: string, limit: number = 200): AuditEventCompliance[] {
  const rows = stmts().getEventsBySession.all(sessionId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToComplianceEvent);
}

export function getEventsForExport(sessionId: string): AuditEventCompliance[] {
  const rows = stmts().getEventsForExport.all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(rowToComplianceEvent);
}

export function getEventCountForSession(sessionId: string): number {
  const row = stmts().countEventsBySession.get(sessionId) as { count: number };
  return row.count;
}

// ---------------------------------------------------------------------------
// Retention cleanup (Phase 5 — merged into this module per simplification)
// ---------------------------------------------------------------------------

/**
 * Delete audit entries older than 13 months (395 days).
 * Deletes L1 before L2 (GDPR-favorable failure mode: personal data deleted first).
 * Deletes in batches of 500 to prevent WAL bloat.
 * Skips entries belonging to in_progress sessions.
 *
 * Returns the number of compliance events deleted.
 */
export function runRetentionCleanup(): number {
  const cutoffDate = new Date(Date.now() - 395 * 24 * 60 * 60 * 1000).toISOString();
  let totalDeleted = 0;

  // Find sessions eligible for cleanup
  const eligibleSessions = db.prepare(`
    SELECT id FROM audit_sessions
    WHERE created_at < ? AND terminal_state != 'in_progress'
  `).all(cutoffDate) as Array<{ id: string }>;

  for (const session of eligibleSessions) {
    // Delete L1 first (GDPR-favorable: personal data goes first)
    db.prepare(`
      DELETE FROM audit_events_operational WHERE session_id = ?
    `).run(session.id);

    // Delete L2 (trigger has age-based exemption for entries > 395 days)
    const result = db.prepare(`
      DELETE FROM audit_events_compliance WHERE session_id = ?
    `).run(session.id);
    totalDeleted += result.changes;

    // Delete the session itself
    db.prepare(`
      DELETE FROM audit_sessions WHERE id = ?
    `).run(session.id);
  }

  // Reclaim freed pages
  if (totalDeleted > 0) {
    try {
      db.pragma('incremental_vacuum(500)');
    } catch { /* non-critical */ }
  }

  return totalDeleted;
}

/**
 * Process a GDPR Art. 17 erasure request.
 * NULLs all PII fields in L1 operational data and session user_id.
 * L2 compliance data is preserved (pseudonymized, immutable).
 *
 * Returns the number of affected events.
 */
export function processErasureRequest(userId: string): number {
  const txn = db.transaction(() => {
    // NULL all PII fields in L1 events
    const eventResult = db.prepare(`
      UPDATE audit_events_operational
      SET user_id = NULL,
          human_verifier_id = NULL,
          recipient_id = NULL,
          source_ip = NULL,
          source_device = NULL,
          source_session_id = NULL
      WHERE user_id = ?
    `).run(userId);

    // NULL user_id in sessions
    db.prepare(`
      UPDATE audit_sessions SET user_id = NULL WHERE user_id = ?
    `).run(userId);

    return eventResult.changes;
  });

  return txn.immediate();
}

// ---------------------------------------------------------------------------
// Row mappers (SQLite row → TypeScript interface)
// ---------------------------------------------------------------------------

function rowToSession(row: Record<string, unknown>): AuditSession {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    userId: row.user_id as string | null,
    userPseudonymId: row.user_pseudonym_id as string,
    agentId: row.agent_id as string | null,
    workflowId: row.workflow_id as string | null,
    workflowName: row.workflow_name as string,
    department: row.department as string,
    triggerType: row.trigger_type as AuditSession['triggerType'],
    terminalState: row.terminal_state as AuditSession['terminalState'],
    startTime: row.start_time as string,
    endTime: row.end_time as string | null,
    timezone: row.timezone as string,
    modelVersions: row.model_versions as string | null,
    stepCount: row.step_count as number,
    humanOversightEvents: row.human_oversight_events as string | null,
    riskFlags: row.risk_flags as string | null,
    recordingIndicatorVisible: !!(row.recording_indicator_visible),
    noEmployeeComparison: !!(row.no_employee_comparison),
    purposeLimitationScope: row.purpose_limitation_scope as string,
    createdAt: row.created_at as string,
  };
}

function rowToComplianceEvent(row: Record<string, unknown>): AuditEventCompliance {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    userPseudonymId: row.user_pseudonym_id as string,
    timestamp: row.timestamp as string,
    timezone: row.timezone as string,
    eventType: row.event_type as AuditEventCompliance['eventType'],
    actionType: row.action_type as AuditEventCompliance['actionType'],
    action: row.action as string,
    entityId: row.entity_id as string | null,
    entityType: row.entity_type as string | null,
    purpose: row.purpose as string,
    legalBasis: row.legal_basis as string,
    result: row.result as 'success' | 'failure',
    inputHash: row.input_hash as string | null,
    outputSummary: row.output_summary as string | null,
    reasoningContext: row.reasoning_context as string | null,
    controlLayer: row.control_layer as AuditEventCompliance['controlLayer'],
    authorizationScope: row.authorization_scope as string | null,
    durationMs: row.duration_ms as number | null,
    llmDataTransferDestination: row.llm_data_transfer_destination as string | null,
    llmModelProvider: row.llm_model_provider as string | null,
    llmModelVersion: row.llm_model_version as string | null,
    recordingIndicatorVisible: !!(row.recording_indicator_visible),
    noEmployeeComparison: !!(row.no_employee_comparison),
    purposeLimitationScope: row.purpose_limitation_scope as string,
    previousHash: row.previous_hash as SHA256Hash,
    entryHash: row.entry_hash as SHA256Hash,
    createdAt: row.created_at as string,
  };
}
