/**
 * Audit Exporter — Multi-format export for compliance-grade audit data.
 *
 * Supports JSON and CSV exports with session + event data.
 * PDF export stays client-side (existing AuditReportExport.tsx via jsPDF).
 *
 * All exports include hash chain verification status per session.
 * Cache-Control: no-store on all responses (audit data must not be cached).
 */

import type {
  AuditSessionFilters,
  AuditSession,
  AuditEventCompliance,
  SHA256Hash,
} from '@workflow-agent/shared';
import {
  querySessionsFiltered,
  getSessionById,
  queryEventsBySession,
  getEventsForExport,
  getEventCountForSession,
} from './audit-database';

// ---------------------------------------------------------------------------
// JSON Export
// ---------------------------------------------------------------------------

export interface AuditExportJSON {
  exportedAt: string;
  filters: AuditSessionFilters;
  sessions: Array<{
    session: AuditSession;
    events: AuditEventCompliance[];
    hashChainValid: boolean;
    eventCount: number;
  }>;
}

/**
 * Export audit data as structured JSON.
 * Includes sessions with nested events and hash chain verification.
 */
export function exportJSON(filters: AuditSessionFilters): AuditExportJSON {
  const sessions = querySessionsFiltered(filters);

  const result: AuditExportJSON = {
    exportedAt: new Date().toISOString(),
    filters,
    sessions: sessions.map((session) => {
      const events = getEventsForExport(session.id);
      const hashChainValid = verifyHashChain(events);
      return {
        session,
        events,
        hashChainValid,
        eventCount: events.length,
      };
    }),
  };

  return result;
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'session_id', 'session_workflow_name', 'session_department', 'session_terminal_state',
  'session_start_time', 'session_end_time',
  'event_id', 'timestamp', 'event_type', 'action_type', 'action', 'result',
  'control_layer', 'duration_ms', 'input_hash', 'output_summary',
  'purpose', 'legal_basis', 'previous_hash', 'entry_hash',
];

/**
 * Export audit data as CSV string.
 * Flattened rows — one event per line, session fields denormalized onto each row.
 */
export function exportCSV(filters: AuditSessionFilters): string {
  const sessions = querySessionsFiltered(filters);
  const lines: string[] = [CSV_HEADERS.join(',')];

  for (const session of sessions) {
    const events = getEventsForExport(session.id);
    for (const event of events) {
      const row = [
        csvEscape(session.id),
        csvEscape(session.workflowName),
        csvEscape(session.department),
        csvEscape(session.terminalState),
        csvEscape(session.startTime),
        csvEscape(session.endTime || ''),
        csvEscape(event.id),
        csvEscape(event.timestamp),
        csvEscape(event.eventType),
        csvEscape(event.actionType),
        csvEscape(event.action),
        csvEscape(event.result),
        csvEscape(event.controlLayer || ''),
        String(event.durationMs || ''),
        csvEscape(event.inputHash || ''),
        csvEscape((event.outputSummary || '').substring(0, 200)),
        csvEscape(event.purpose),
        csvEscape(event.legalBasis),
        csvEscape(event.previousHash),
        csvEscape(event.entryHash),
      ];
      lines.push(row.join(','));
    }
  }

  return lines.join('\n');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Hash Chain Verification
// ---------------------------------------------------------------------------

/**
 * Verify the hash chain for a list of compliance events.
 * Returns true if the chain is valid (all hashes verify against their predecessors).
 *
 * An empty chain is considered valid.
 * A chain starting with genesis hash ('0'.repeat(64)) is expected.
 */
export function verifyHashChain(events: AuditEventCompliance[]): boolean {
  if (events.length === 0) return true;

  const genesisHash = '0'.repeat(64) as SHA256Hash;

  // First event should reference genesis
  if (events[0].previousHash !== genesisHash) {
    return false;
  }

  // Each subsequent event should reference the previous event's entry hash
  for (let i = 1; i < events.length; i++) {
    if (events[i].previousHash !== events[i - 1].entryHash) {
      return false;
    }
  }

  return true;
}

/**
 * Verify hash chain for a specific session.
 * Returns detailed result for API response.
 */
export function verifySessionHashChain(sessionId: string, roomId: string): {
  valid: boolean;
  sessionId: string;
  eventCount: number;
  firstEventTimestamp: string | null;
  lastEventTimestamp: string | null;
  brokenAt?: number;
} {
  const session = getSessionById(sessionId, roomId);
  if (!session) {
    return { valid: false, sessionId, eventCount: 0, firstEventTimestamp: null, lastEventTimestamp: null };
  }

  const events = getEventsForExport(sessionId);
  const valid = verifyHashChain(events);

  let brokenAt: number | undefined;
  if (!valid && events.length > 0) {
    const genesisHash = '0'.repeat(64) as SHA256Hash;
    if (events[0].previousHash !== genesisHash) {
      brokenAt = 0;
    } else {
      for (let i = 1; i < events.length; i++) {
        if (events[i].previousHash !== events[i - 1].entryHash) {
          brokenAt = i;
          break;
        }
      }
    }
  }

  return {
    valid,
    sessionId,
    eventCount: events.length,
    firstEventTimestamp: events.length > 0 ? events[0].timestamp : null,
    lastEventTimestamp: events.length > 0 ? events[events.length - 1].timestamp : null,
    brokenAt,
  };
}
