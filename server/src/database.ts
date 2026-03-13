/**
 * Conversation Persistence — SQLite database for chat history.
 *
 * Stores conversations and messages on the Fly.io persistent volume at /data.
 * Uses better-sqlite3 (synchronous API), WAL mode for concurrent read/write,
 * and FTS5 for full-text search across message content.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'conversations.db');
const MAX_CONVERSATIONS_PER_ROOM = 100;

let db: Database.Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: string;
  title: string;
  status: 'active' | 'complete' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  type: string;
  content: string;
  metadata: string | null;
  timestamp: string;
}

export interface SearchResult {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  snippet: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initDatabase(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  try {
    db = new Database(DB_PATH);
  } catch (err) {
    // Corrupt DB — rename and create fresh
    console.error('[database] Failed to open DB, creating fresh:', err);
    const backupPath = DB_PATH + '.corrupt.' + Date.now();
    if (fs.existsSync(DB_PATH)) {
      fs.renameSync(DB_PATH, backupPath);
    }
    db = new Database(DB_PATH);
  }

  // Performance and safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456'); // 256MB mmap for read performance
  db.pragma('cache_size = -8000');    // 8MB cache (negative = KB)

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New conversation',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_room
      ON conversations(room_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT NOT NULL,
      metadata TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, timestamp ASC);
  `);

  // FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, content='messages', content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2');

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  console.log('[database] Initialized at', DB_PATH);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.pragma('optimize');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('[database] Closed cleanly');
  } catch (err) {
    console.error('[database] Error closing:', err);
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID();
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
    insertConversation: db.prepare(`
      INSERT INTO conversations (id, room_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    insertMessage: db.prepare(`
      INSERT INTO messages (id, conversation_id, role, type, content, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),

    getConversationsByRoom: db.prepare(`
      SELECT c.id, c.title, c.status, c.created_at AS createdAt, c.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount,
        COALESCE(
          (SELECT SUBSTR(m2.content, 1, 100)
           FROM messages m2 WHERE m2.conversation_id = c.id
           ORDER BY m2.timestamp DESC LIMIT 1),
          ''
        ) AS lastMessagePreview
      FROM conversations c
      WHERE c.room_id = ?
      ORDER BY c.updated_at DESC
      LIMIT ?
    `),

    getMessagesByConversation: db.prepare(`
      SELECT id, conversation_id AS conversationId, role, type, content, metadata, timestamp
      FROM messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `),

    getConversation: db.prepare(`
      SELECT id, room_id AS roomId, title, status
      FROM conversations
      WHERE id = ?
    `),

    getConversationWithRoom: db.prepare(`
      SELECT id, room_id AS roomId, title, status
      FROM conversations
      WHERE id = ? AND room_id = ?
    `),

    updateConversationStatus: db.prepare(`
      UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?
    `),

    updateConversationTitle: db.prepare(`
      UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?
    `),

    updateConversationTimestamp: db.prepare(`
      UPDATE conversations SET updated_at = ? WHERE id = ?
    `),

    deleteConversation: db.prepare(`
      DELETE FROM conversations WHERE id = ? AND room_id = ?
    `),

    countConversationsByRoom: db.prepare(`
      SELECT COUNT(*) AS count FROM conversations WHERE room_id = ?
    `),

    getOldestConversation: db.prepare(`
      SELECT id FROM conversations WHERE room_id = ? ORDER BY updated_at ASC LIMIT 1
    `),

    searchMessages: db.prepare(`
      SELECT
        m.conversation_id AS conversationId,
        c.title AS conversationTitle,
        m.id AS messageId,
        snippet(messages_fts, 0, '<b>', '</b>', '...', 32) AS snippet,
        m.timestamp
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.room_id = ? AND messages_fts MATCH ?
      ORDER BY bm25(messages_fts)
      LIMIT 20
    `),
  };
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

export function createConversation(roomId: string, title: string = 'New conversation'): string {
  const id = generateId();
  const now = new Date().toISOString();
  stmts().insertConversation.run(id, roomId, title, 'active', now, now);
  enforceConversationLimit(roomId);
  return id;
}

/**
 * Ensure a conversation with the given ID exists for this room.
 * If it doesn't exist, creates it. If it does, this is a no-op.
 * Used when a message arrives for a conversation not yet in the DB
 * (e.g., created before persistence was deployed).
 */
export function ensureConversation(conversationId: string, roomId: string, title: string = 'New conversation'): void {
  if (conversationExistsForRoom(conversationId, roomId)) return;
  const now = new Date().toISOString();
  try {
    stmts().insertConversation.run(conversationId, roomId, title, 'active', now, now);
    enforceConversationLimit(roomId);
  } catch (err: unknown) {
    // Race condition: another call already inserted it — safe to ignore
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return;
    }
    throw err;
  }
}

export function saveMessage(msg: {
  id?: string;
  conversationId: string;
  role: string;
  type: string;
  content: string;
  metadata?: string | null;
  timestamp?: string;
}): string {
  const id = msg.id || generateId();
  const timestamp = msg.timestamp || new Date().toISOString();
  try {
    stmts().insertMessage.run(
      id,
      msg.conversationId,
      msg.role,
      msg.type,
      msg.content,
      msg.metadata || null,
      timestamp,
    );
    // Update conversation's updated_at
    stmts().updateConversationTimestamp.run(timestamp, msg.conversationId);
  } catch (err: unknown) {
    // Duplicate message ID — skip silently (idempotent)
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return id;
    }
    console.error('[database] saveMessage error:', err);
  }
  return id;
}

export function getConversationsByRoom(roomId: string, limit: number = 50): ConversationSummary[] {
  return stmts().getConversationsByRoom.all(roomId, limit) as ConversationSummary[];
}

export function getMessagesByConversation(conversationId: string): StoredMessage[] {
  return stmts().getMessagesByConversation.all(conversationId) as StoredMessage[];
}

export function getConversation(conversationId: string): { id: string; roomId: string; title: string; status: string } | undefined {
  return stmts().getConversation.get(conversationId) as { id: string; roomId: string; title: string; status: string } | undefined;
}

export function conversationExistsForRoom(conversationId: string, roomId: string): boolean {
  return !!stmts().getConversationWithRoom.get(conversationId, roomId);
}

export function deleteConversation(conversationId: string, roomId: string): boolean {
  const result = stmts().deleteConversation.run(conversationId, roomId);
  return result.changes > 0;
}

export function updateConversationStatus(conversationId: string, status: string): void {
  stmts().updateConversationStatus.run(status, new Date().toISOString(), conversationId);
}

export function updateConversationTitle(conversationId: string, title: string): void {
  stmts().updateConversationTitle.run(title, new Date().toISOString(), conversationId);
}

export function searchMessages(roomId: string, query: string): SearchResult[] {
  if (!query.trim()) return [];
  // Wrap in double quotes for literal matching to prevent FTS5 syntax injection
  const safeQuery = '"' + query.replace(/"/g, '""') + '"';
  try {
    return stmts().searchMessages.all(roomId, safeQuery) as SearchResult[];
  } catch (err) {
    console.error('[database] searchMessages error:', err);
    return [];
  }
}

export function enforceConversationLimit(roomId: string): void {
  const row = stmts().countConversationsByRoom.get(roomId) as { count: number };
  while (row && row.count > MAX_CONVERSATIONS_PER_ROOM) {
    const oldest = stmts().getOldestConversation.get(roomId) as { id: string } | undefined;
    if (!oldest) break;
    stmts().deleteConversation.run(oldest.id, roomId);
    row.count--;
  }
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Create a conversation and save the first message atomically.
 * Returns the server-assigned conversation ID.
 */
export function createConversationAndMessage(
  roomId: string,
  message: { id?: string; role: string; type: string; content: string; metadata?: string | null },
): { conversationId: string; messageId: string } {
  const conversationId = generateId();
  const now = new Date().toISOString();
  const messageId = message.id || generateId();
  const title = message.role === 'user' ? message.content.slice(0, 50) : 'New conversation';

  const txn = db.transaction(() => {
    stmts().insertConversation.run(conversationId, roomId, title, 'active', now, now);
    stmts().insertMessage.run(messageId, conversationId, message.role, message.type, message.content, message.metadata || null, now);
  });

  txn.immediate();
  enforceConversationLimit(roomId);
  return { conversationId, messageId };
}
