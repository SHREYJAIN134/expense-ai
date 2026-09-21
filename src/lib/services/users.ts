import { CATEGORIES } from "../domain/categories";
import { getDb, uid, withTransaction } from "../db/client";
import { hashPassword } from "../auth/password";

export interface UserSettings {
  currency: string;
  monthStartDay: number;
  aiClassification: boolean;
  aiNarration: boolean;
  /** null = automatic (10% of typical monthly spending). */
  safetyBuffer: number | null;
  changeMinPct: number;
  changeMinAmount: number;
  changeMinTxns: number;
  anomalyMinAmount: number;
  includeDetectedRecurring: boolean;
  reserveBudgets: boolean;
}

export function countUsers(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function seedCategories(userId: string) {
  const db = getDb();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO transaction_categories (id, user_id, category, subcategory, color, is_system) VALUES (?, ?, ?, ?, ?, 1)",
  );
  for (const c of CATEGORIES) {
    ins.run(uid(), userId, c.name, "", c.color);
    for (const s of c.subcategories) ins.run(uid(), userId, c.name, s, c.color);
  }
}

export async function createUser(input: { email: string; name: string; password: string }) {
  const hash = await hashPassword(input.password);
  const id = uid();
  withTransaction((db) => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run(id, input.email.trim().toLowerCase(), input.name.trim(), hash);
    db.prepare("INSERT INTO user_settings (user_id) VALUES (?)").run(id);
    seedCategories(id);
  });
  return { id, email: input.email.trim().toLowerCase(), name: input.name.trim() };
}

export function getUserByEmail(email: string) {
  return getDb().prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?").get(email.trim().toLowerCase()) as
    | { id: string; email: string; name: string; password_hash: string }
    | undefined;
}

export function getUserById(id: string) {
  return getDb().prepare("SELECT id, email, name, password_hash, created_at FROM users WHERE id = ?").get(id) as
    | { id: string; email: string; name: string; password_hash: string; created_at: string }
    | undefined;
}

export function getSettings(userId: string): UserSettings {
  const db = getDb();
  let row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) as any;
  if (!row) {
    db.prepare("INSERT INTO user_settings (user_id) VALUES (?)").run(userId);
    row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId);
  }
  return {
    currency: row.currency,
    monthStartDay: row.month_start_day,
    aiClassification: !!row.ai_classification,
    aiNarration: !!row.ai_narration,
    safetyBuffer: row.safety_buffer ?? null,
    changeMinPct: row.change_min_pct,
    changeMinAmount: row.change_min_amount,
    changeMinTxns: row.change_min_txns,
    anomalyMinAmount: row.anomaly_min_amount,
    includeDetectedRecurring: !!row.include_detected_recurring,
    reserveBudgets: !!row.reserve_budgets,
  };
}

export function updateSettings(userId: string, patch: Partial<UserSettings>) {
  const cur = getSettings(userId);
  const next = { ...cur, ...patch };
  getDb()
    .prepare(
      `UPDATE user_settings SET currency = ?, month_start_day = ?, ai_classification = ?, ai_narration = ?,
         safety_buffer = ?, change_min_pct = ?, change_min_amount = ?, change_min_txns = ?, anomaly_min_amount = ?,
         include_detected_recurring = ?, reserve_budgets = ?, updated_at = datetime('now') WHERE user_id = ?`,
    )
    .run(
      next.currency, next.monthStartDay, next.aiClassification ? 1 : 0, next.aiNarration ? 1 : 0,
      next.safetyBuffer, next.changeMinPct, next.changeMinAmount, next.changeMinTxns, next.anomalyMinAmount,
      next.includeDetectedRecurring ? 1 : 0, next.reserveBudgets ? 1 : 0, userId,
    );
  return next;
}

const ensured = new Set<string>();

/** Accounts created before a taxonomy addition get the new built-in categories on first read. */
export function ensureSystemCategories(userId: string) {
  if (ensured.has(userId)) return;
  seedCategories(userId); // INSERT OR IGNORE: only missing rows are added
  ensured.add(userId);
}

export function getUserCategories(userId: string) {
  ensureSystemCategories(userId);
  const rows = getDb()
    .prepare("SELECT category, subcategory, color, is_system FROM transaction_categories WHERE user_id = ? ORDER BY category, subcategory")
    .all(userId) as { category: string; subcategory: string; color: string | null; is_system: number }[];
  const map = new Map<string, { name: string; color: string; isSystem: boolean; subcategories: { name: string; isSystem: boolean }[] }>();
  for (const r of rows) {
    const c = map.get(r.category) ?? { name: r.category, color: r.color ?? "#64748b", isSystem: !!r.is_system, subcategories: [] };
    if (r.subcategory === "") {
      c.color = r.color ?? c.color;
      c.isSystem = !!r.is_system;
    } else c.subcategories.push({ name: r.subcategory, isSystem: !!r.is_system });
    map.set(r.category, c);
  }
  return [...map.values()];
}
