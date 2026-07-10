import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "pattson.db");

// Next.js dev mode hot-reloads modules on every save, which would otherwise
// re-run `new Database(...)` and open a second file handle on the same
// SQLite file each time -- stash the instance on globalThis so a reload
// reuses the existing connection instead.
const globalForDb = globalThis as unknown as { pattsonDb?: Database.Database };

function createDb(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'error')),
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      due_at TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

export const db = globalForDb.pattsonDb ?? createDb();
if (process.env.NODE_ENV !== "production") {
  globalForDb.pattsonDb = db;
}

export interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

/** Returns the new row's id, so a caller can delete it again if the turn
 * gets interrupted before a reply is ever produced (see streamAssistantReply). */
export function insertMessage(role: "user" | "assistant", content: string): number {
  const info = db.prepare("INSERT INTO conversations (role, content) VALUES (?, ?)").run(role, content);
  return Number(info.lastInsertRowid);
}

export function deleteMessage(id: number): void {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export function getRecentMessages(limit = 50): ConversationMessage[] {
  const rows = db
    .prepare("SELECT * FROM conversations ORDER BY id DESC LIMIT ?")
    .all(limit) as ConversationMessage[];
  return rows.reverse();
}

export interface ActivityLogEntry {
  id: number;
  tool_name: string;
  arguments: string;
  status: "success" | "error";
  result: string | null;
  created_at: string;
}

export function logActivity(
  toolName: string,
  args: unknown,
  status: "success" | "error",
  result: unknown
): void {
  db.prepare(
    "INSERT INTO activity_log (tool_name, arguments, status, result) VALUES (?, ?, ?, ?)"
  ).run(toolName, JSON.stringify(args), status, result === undefined ? null : JSON.stringify(result));
}

export function getRecentActivity(limit = 20): ActivityLogEntry[] {
  return db
    .prepare("SELECT * FROM activity_log ORDER BY id DESC LIMIT ?")
    .all(limit) as ActivityLogEntry[];
}

/** Count of activity_log rows for `toolName` within the last `windowMinutes`
 * -- used by posting tools' rate/sanity guard (config.py-equivalent limits
 * live in each tool module, not here). */
export function countRecentActivity(toolName: string, windowMinutes: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM activity_log
       WHERE tool_name = ? AND status = 'success'
       AND created_at >= datetime('now', ?)`
    )
    .get(toolName, `-${windowMinutes} minutes`) as { count: number };
  return row.count;
}

export interface Memory {
  id: number;
  content: string;
  created_at: string;
}

export function insertMemory(content: string): void {
  db.prepare("INSERT INTO memories (content) VALUES (?)").run(content);
}

/** Most recent memories first, capped -- same defensive limit as
 * getRecentMessages, so this can't silently balloon every request's
 * context the way unbounded conversation history once did. */
export function getAllMemories(limit = 60): Memory[] {
  return db.prepare("SELECT * FROM memories ORDER BY id DESC LIMIT ?").all(limit) as Memory[];
}

export function countMemories(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
  return row.count;
}

/** Deletes memories whose content contains `topic` (case-insensitive).
 * Returns how many were removed. */
export function deleteMemoriesMatching(topic: string): number {
  const info = db
    .prepare("DELETE FROM memories WHERE content LIKE ? COLLATE NOCASE")
    .run(`%${topic}%`);
  return info.changes;
}

/** Deletes a single memory by id, for the sidebar's manage-memories UI. */
export function deleteMemoryById(id: number): boolean {
  const info = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return info.changes > 0;
}

export interface Reminder {
  id: number;
  content: string;
  due_at: string | null;
  completed: 0 | 1;
  created_at: string;
}

export function insertReminder(content: string, dueAt: string | null): number {
  const info = db
    .prepare("INSERT INTO reminders (content, due_at) VALUES (?, ?)")
    .run(content, dueAt);
  return Number(info.lastInsertRowid);
}

/** Open reminders (or all, if `includeCompleted`), soonest due date first --
 * reminders with no due date sort last since there's nothing to order them by. */
export function listReminders(includeCompleted = false): Reminder[] {
  const query = includeCompleted
    ? "SELECT * FROM reminders ORDER BY (due_at IS NULL), due_at ASC"
    : "SELECT * FROM reminders WHERE completed = 0 ORDER BY (due_at IS NULL), due_at ASC";
  return db.prepare(query).all() as Reminder[];
}

export function completeReminder(id: number): boolean {
  const info = db.prepare("UPDATE reminders SET completed = 1 WHERE id = ?").run(id);
  return info.changes > 0;
}
