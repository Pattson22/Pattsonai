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

export function insertMessage(role: "user" | "assistant", content: string): void {
  db.prepare("INSERT INTO conversations (role, content) VALUES (?, ?)").run(role, content);
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
