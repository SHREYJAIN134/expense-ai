import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { migrations } from "./migrations";
import { resolveDataLocation } from "./paths";

export type DB = Database.Database;

const globalForDb = globalThis as unknown as { __expenseAiDb?: DB };

let warned = false;
function resolveDbPath(): string {
  const loc = resolveDataLocation();
  if (loc.insideSyncedFolder && !warned) {
    warned = true;
    // Path only - no financial data. Tell the user once.
    console.warn(`[db] WARNING: the database file (${loc.dbFile}) is inside a cloud-synced folder. SQLite + sync clients can corrupt data; set DATABASE_URL to a local path.`);
  }
  return loc.dbFile;
}

export function runMigrations(db: DB): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id),
  );
  let count = 0;
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(m.id, m.name);
    })();
    count++;
  }
  return count;
}

export function openDatabase(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  return db;
}

/** Process-wide singleton (survives Next.js dev hot reloads). */
export function getDb(): DB {
  if (!globalForDb.__expenseAiDb) globalForDb.__expenseAiDb = openDatabase(resolveDbPath());
  return globalForDb.__expenseAiDb;
}

/** Run `fn` inside a single SQLite transaction (rolls back on throw). */
export function withTransaction<T>(fn: (db: DB) => T): T {
  const db = getDb();
  return db.transaction(() => fn(db))();
}

export const uid = () => crypto.randomUUID();
export const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);
