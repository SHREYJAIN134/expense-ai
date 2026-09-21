/**
 * Where persistent data lives.
 *
 * Source code may sit in a cloud-synced folder (OneDrive / Dropbox / Google Drive / iCloud) but a live
 * SQLite database must NOT: sync clients upload/lock/rewrite files mid-transaction, and SQLite's WAL mode
 * uses three files (`.db`, `-wal`, `-shm`) that must stay consistent - a classic recipe for corruption
 * and for financial data being copied to a cloud account. So when the project is inside a synced folder
 * the default data directory is a per-user local application-data folder instead.
 *
 * Resolution order:
 *   1. DATABASE_URL            explicit file (":memory:" for tests)
 *   2. EXPENSE_AI_DATA_DIR     explicit directory
 *   3. project is cloud-synced -> per-user local app-data directory (outside the project)
 *   4. otherwise               <project>/data
 */
import os from "node:os";
import path from "node:path";

const SYNCED_RE = /[\\/](onedrive[^\\/]*|dropbox[^\\/]*|google\s?drive[^\\/]*|icloud\s?drive[^\\/]*|mobile documents|box sync|sync\.com)([\\/]|$)/i;

export function isCloudSyncedPath(p: string): boolean {
  return SYNCED_RE.test(path.resolve(p) + path.sep);
}

/** Per-user application-data folder that is not cloud-synced by default. */
export function localAppDataDir(): string {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ExpenseAI");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ExpenseAI");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "expense-ai");
}

export interface DataLocation {
  dir: string;
  dbFile: string;
  /** Why this location was chosen. */
  source: "DATABASE_URL" | "EXPENSE_AI_DATA_DIR" | "local-app-data (project is cloud-synced)" | "project ./data";
  /** True if the resolved database file is inside a cloud-synced folder (warn the user). */
  insideSyncedFolder: boolean;
}

export function resolveDataLocation(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): DataLocation {
  let url = env.DATABASE_URL?.trim();
  if (url === ":memory:") return { dir: ":memory:", dbFile: ":memory:", source: "DATABASE_URL", insideSyncedFolder: false };
  if (url) {
    if (process.platform !== "win32") {
      url = url.replace(/\\/g, "/");
    }
    const dbFile = path.resolve(cwd, url.replace(/^file:/, ""));
    return { dir: path.dirname(dbFile), dbFile, source: "DATABASE_URL", insideSyncedFolder: isCloudSyncedPath(dbFile) };
  }
  const explicit = env.EXPENSE_AI_DATA_DIR?.trim();
  if (explicit) {
    let dirPath = explicit;
    if (process.platform !== "win32") dirPath = dirPath.replace(/\\/g, "/");
    const dir = path.resolve(cwd, dirPath);
    return { dir, dbFile: path.join(dir, "expense-ai.db"), source: "EXPENSE_AI_DATA_DIR", insideSyncedFolder: isCloudSyncedPath(dir) };
  }
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME) {
    const dir = "/tmp";
    return { dir, dbFile: path.join(dir, "expense-ai.db"), source: "EXPENSE_AI_DATA_DIR", insideSyncedFolder: false };
  }
  if (isCloudSyncedPath(cwd)) {
    const dir = localAppDataDir();
    return { dir, dbFile: path.join(dir, "expense-ai.db"), source: "local-app-data (project is cloud-synced)", insideSyncedFolder: false };
  }
  const dir = path.join(cwd, "data");
  return { dir, dbFile: path.join(dir, "expense-ai.db"), source: "project ./data", insideSyncedFolder: false };
}
