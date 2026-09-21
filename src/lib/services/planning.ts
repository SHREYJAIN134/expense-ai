/** Recurring obligations, budgets, goals, forecast and insights - the DB-facing side of analytics/planning. */
import { getDb, uid, withTransaction } from "../db/client";
import { generateInsights, type Insight } from "../analytics/insights";
import {
  buildForecast,
  buildUpcoming,
  calculateBudgetVariance,
  monthlyCommitments,
  type BudgetInput,
  type ManualObligation,
} from "../analytics/planning";
import { detectRecurringExpenses, type Frequency, type RecurringSeries } from "../analytics/recurring";
import { merchantKeyOf } from "../classification/merchants";
import { addDays, todayISO, type ISODate } from "../util/dates";
import { bumpDataVersion, currentBalance, loadAllTxns, memoize } from "./data";
import { getSettings } from "./users";
import type { TxnLite } from "../domain/types";

/* ------------------------------ recurring ------------------------------ */

export interface RecurringRow {
  id: string;
  name: string;
  merchantKey: string | null;
  category: string;
  subcategory: string | null;
  amount: number;
  frequency: Frequency;
  dueDay: number | null;
  startDate: string | null;
  kind: "expense" | "income";
  source: "manual" | "detected";
  status: "active" | "dismissed";
  notes: string | null;
}

function mapRecurring(r: any): RecurringRow {
  return {
    id: r.id,
    name: r.name,
    merchantKey: r.merchant_key,
    category: r.category,
    subcategory: r.subcategory,
    amount: r.amount,
    frequency: r.frequency,
    dueDay: r.due_day,
    startDate: r.start_date,
    kind: r.kind,
    source: r.source,
    status: r.status,
    notes: r.notes,
  };
}

export function listRecurringRows(userId: string): RecurringRow[] {
  return (getDb().prepare("SELECT * FROM recurring_expenses WHERE user_id = ? ORDER BY name").all(userId) as any[]).map(mapRecurring);
}

export function toObligation(r: RecurringRow): ManualObligation {
  return {
    id: r.id,
    name: r.name,
    amount: r.amount,
    frequency: r.frequency,
    dueDay: r.dueDay,
    startDate: r.startDate,
    category: r.category,
    kind: r.kind,
    merchantKey: r.merchantKey,
  };
}

export function getManualObligations(userId: string): ManualObligation[] {
  return listRecurringRows(userId).filter((r) => r.status === "active").map(toObligation);
}

export function getDismissedKeys(userId: string): Set<string> {
  return new Set(
    listRecurringRows(userId)
      .filter((r) => r.status === "dismissed" && r.merchantKey)
      .map((r) => r.merchantKey as string),
  );
}

export function detectSeries(userId: string, asOf: ISODate = todayISO()): RecurringSeries[] {
  return memoize(userId, `series:${asOf}`, () => detectRecurringExpenses(loadAllTxns(userId), { asOf, includeIncome: true }));
}

export function createRecurring(
  userId: string,
  input: {
    name: string;
    amount: number;
    frequency: Frequency;
    dueDay?: number | null;
    startDate?: string | null;
    category: string;
    kind?: "expense" | "income";
    merchantKey?: string | null;
    notes?: string | null;
    source?: "manual" | "detected";
    status?: "active" | "dismissed";
  },
) {
  const id = uid();
  getDb()
    .prepare(
      `INSERT INTO recurring_expenses (id, user_id, name, merchant_key, category, amount, frequency, due_day, start_date, kind, source, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, input.name, input.merchantKey ?? null, input.category, input.amount, input.frequency, input.dueDay ?? null, input.startDate ?? null, input.kind ?? "expense", input.source ?? "manual", input.status ?? "active", input.notes ?? null);
  bumpDataVersion(userId);
  return id;
}

export function updateRecurring(userId: string, id: string, patch: Partial<{ name: string; amount: number; frequency: Frequency; dueDay: number | null; startDate: string | null; category: string; status: "active" | "dismissed"; notes: string | null }>) {
  const cur = listRecurringRows(userId).find((r) => r.id === id);
  if (!cur) return false;
  const n = { ...cur, ...patch };
  getDb()
    .prepare("UPDATE recurring_expenses SET name = ?, amount = ?, frequency = ?, due_day = ?, start_date = ?, category = ?, status = ?, notes = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(n.name, n.amount, n.frequency, n.dueDay, n.startDate, n.category, n.status, n.notes, id, userId);
  bumpDataVersion(userId);
  return true;
}

export function deleteRecurring(userId: string, id: string) {
  const r = getDb().prepare("DELETE FROM recurring_expenses WHERE id = ? AND user_id = ?").run(id, userId);
  bumpDataVersion(userId);
  return r.changes > 0;
}

/**
 * Mark transactions that belong to a detected recurring series (is_recurring) and
 * promote unclassified-but-regular payments (step 3 of the classification pipeline:
 * "recurring transaction detection"). Runs after each import.
 */
export function refreshRecurringFlags(userId: string, asOf: ISODate = todayISO()) {
  const db = getDb();
  const txns = loadAllTxns(userId);

  // Promote regular unclassified rows: same merchant, same-ish amount, monthly cadence.
  const unclassified = txns
    .filter((t) => t.category === "OTHER" && !t.isRecurring)
    .map<TxnLite>((t) => ({
      ...t,
      category: t.direction === "credit" ? (t.amount >= 5000 ? "SALARY/INCOME" : "OTHER") : "BILLS",
      subcategory: t.direction === "credit" ? "Salary" : "Other Bill",
    }))
    .filter((t) => t.category !== "OTHER");
  const promoted = detectRecurringExpenses(unclassified, { asOf, includeIncome: true }).filter((s) => s.confidence >= 0.55 && s.amountPattern === "fixed");

  withTransaction(() => {
    for (const s of promoted) {
      const income = s.kind === "income";
      db.prepare(
        `UPDATE transactions SET category = ?, subcategory = ?, classification_confidence = 0.6, classification_source = 'recurring'
         WHERE user_id = ? AND category = 'OTHER' AND user_edited = 0 AND id IN (SELECT value FROM json_each(?))`,
      ).run(income ? "SALARY/INCOME" : "BILLS", income ? "Salary" : "Other Bill", userId, JSON.stringify(s.txnIds));
    }
  });
  if (promoted.length) bumpDataVersion(userId);

  const series = detectRecurringExpenses(loadAllTxns(userId), { asOf, includeIncome: true });
  const ids = series.flatMap((s) => s.txnIds);
  withTransaction(() => {
    db.prepare("UPDATE transactions SET is_recurring = 0 WHERE user_id = ? AND is_recurring = 1").run(userId);
    db.prepare("UPDATE transactions SET is_recurring = 1 WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))").run(userId, JSON.stringify(ids));
    // History-backed evidence: a confirmed pattern raises the candidate confidence (AUTOPAY alone stays a weak candidate).
    const upd = db.prepare(
      "UPDATE transactions SET is_recurring_candidate = 1, recurring_confidence = MAX(recurring_confidence, ?) WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))",
    );
    for (const sr of series) if (sr.kind === "expense") upd.run(sr.confidence, userId, JSON.stringify(sr.txnIds));
  });
  bumpDataVersion(userId);
  return { series: series.length, flagged: ids.length, promoted: promoted.length };
}

/* -------------------------------- budgets -------------------------------- */

export interface BudgetRow {
  id: string;
  category: string;
  amount: number;
  alertThreshold: number;
  isActive: boolean;
}

export function listBudgets(userId: string): BudgetRow[] {
  return (getDb().prepare("SELECT * FROM budgets WHERE user_id = ? ORDER BY category").all(userId) as any[]).map((r) => ({
    id: r.id,
    category: r.category,
    amount: r.amount,
    alertThreshold: r.alert_threshold,
    isActive: !!r.is_active,
  }));
}

export function upsertBudget(userId: string, input: { category: string; amount: number; alertThreshold?: number }) {
  const id = uid();
  getDb()
    .prepare(
      `INSERT INTO budgets (id, user_id, category, amount, alert_threshold) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, category) DO UPDATE SET amount = excluded.amount, alert_threshold = excluded.alert_threshold, is_active = 1, updated_at = datetime('now')`,
    )
    .run(id, userId, input.category, input.amount, input.alertThreshold ?? 0.8);
  bumpDataVersion(userId);
  return (getDb().prepare("SELECT id FROM budgets WHERE user_id = ? AND category = ?").get(userId, input.category) as { id: string }).id;
}

export function updateBudget(userId: string, id: string, patch: { amount?: number; alertThreshold?: number; isActive?: boolean }) {
  const cur = listBudgets(userId).find((b) => b.id === id);
  if (!cur) return false;
  const n = { ...cur, ...patch };
  getDb()
    .prepare("UPDATE budgets SET amount = ?, alert_threshold = ?, is_active = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(n.amount, n.alertThreshold, n.isActive ? 1 : 0, id, userId);
  bumpDataVersion(userId);
  return true;
}

export function deleteBudget(userId: string, id: string) {
  const r = getDb().prepare("DELETE FROM budgets WHERE id = ? AND user_id = ?").run(id, userId);
  bumpDataVersion(userId);
  return r.changes > 0;
}

export function getBudgetStatus(userId: string, asOf: ISODate = todayISO()) {
  const budgets: BudgetInput[] = listBudgets(userId)
    .filter((b) => b.isActive)
    .map((b) => ({ id: b.id, category: b.category, amount: b.amount, alertThreshold: b.alertThreshold }));
  return calculateBudgetVariance(budgets, loadAllTxns(userId), asOf, getSettings(userId).monthStartDay);
}

/* --------------------------------- goals --------------------------------- */

export function listGoals(userId: string) {
  return (getDb().prepare("SELECT * FROM financial_goals WHERE user_id = ? ORDER BY created_at").all(userId) as any[]).map((g) => ({
    id: g.id as string,
    name: g.name as string,
    targetAmount: g.target_amount as number,
    currentAmount: g.current_amount as number,
    targetDate: g.target_date as string | null,
    status: g.status as string,
    notes: g.notes as string | null,
    progress: Math.min(100, Math.round((g.current_amount / g.target_amount) * 1000) / 10),
  }));
}

export function createGoal(userId: string, g: { name: string; targetAmount: number; currentAmount?: number; targetDate?: string | null; notes?: string | null }) {
  const id = uid();
  getDb()
    .prepare("INSERT INTO financial_goals (id, user_id, name, target_amount, current_amount, target_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, g.name, g.targetAmount, g.currentAmount ?? 0, g.targetDate ?? null, g.notes ?? null);
  return id;
}

export function updateGoal(userId: string, id: string, patch: Partial<{ name: string; targetAmount: number; currentAmount: number; targetDate: string | null; status: string }>) {
  const cur = listGoals(userId).find((g) => g.id === id);
  if (!cur) return false;
  const n = { ...cur, ...patch };
  getDb()
    .prepare("UPDATE financial_goals SET name = ?, target_amount = ?, current_amount = ?, target_date = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(n.name, n.targetAmount, n.currentAmount, n.targetDate, n.status, id, userId);
  return true;
}

export function deleteGoal(userId: string, id: string) {
  return getDb().prepare("DELETE FROM financial_goals WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/* --------------------------- upcoming & forecast --------------------------- */

export function getUpcoming(userId: string, days = 30, asOf: ISODate = todayISO()) {
  const series = detectSeries(userId, asOf);
  const manual = getManualObligations(userId);
  const to = addDays(asOf, days);
  const items = buildUpcoming({ asOf, to, series, manual, dismissedKeys: getDismissedKeys(userId) });
  return { asOf, to, items, total: Math.round(items.reduce((a, i) => a + i.amount, 0) * 100) / 100 };
}

export function getForecast(userId: string, opts: { days?: number; to?: ISODate; planned?: number; asOf?: ISODate } = {}) {
  const asOf = opts.asOf ?? todayISO();
  const to = opts.to ?? addDays(asOf, (opts.days ?? 30) - 1);
  const bal = currentBalance(userId);
  return buildForecast({
    txns: loadAllTxns(userId),
    asOf,
    to,
    manual: getManualObligations(userId),
    series: detectSeries(userId, asOf),
    dismissedKeys: getDismissedKeys(userId),
    currentBalance: bal?.balance ?? null,
    balanceAsOf: bal?.asOf ?? null,
    planned: opts.planned,
    bufferOverride: getSettings(userId).safetyBuffer,
  });
}

export function getCommitments(userId: string, asOf: ISODate = todayISO()) {
  return monthlyCommitments(detectSeries(userId, asOf), getManualObligations(userId));
}

/* -------------------------------- insights -------------------------------- */

export function computeInsights(userId: string, asOf: ISODate = todayISO()): Insight[] {
  const series = detectSeries(userId, asOf);
  const manual = getManualObligations(userId);
  const upcoming = buildUpcoming({ asOf, to: addDays(asOf, 14), series, manual, dismissedKeys: getDismissedKeys(userId) });
  return generateInsights({
    txns: loadAllTxns(userId),
    asOf,
    monthStartDay: getSettings(userId).monthStartDay,
    budgets: getBudgetStatus(userId, asOf),
    series,
    manual,
    upcoming,
  });
}

/** Recompute and persist insights (called after imports and on demand). */
export function regenerateInsights(userId: string, asOf: ISODate = todayISO()): Insight[] {
  const insights = computeInsights(userId, asOf);
  const db = getDb();
  withTransaction(() => {
    db.prepare("DELETE FROM financial_insights WHERE user_id = ?").run(userId);
    const ins = db.prepare("INSERT INTO financial_insights (id, user_id, kind, severity, title, body, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const i of insights) ins.run(uid(), userId, i.kind, i.severity, i.title, i.body, i.data ? JSON.stringify(i.data) : null);
  });
  return insights;
}

export function storedInsights(userId: string): (Insight & { generatedAt: string })[] {
  return (getDb().prepare("SELECT kind, severity, title, body, data_json, generated_at FROM financial_insights WHERE user_id = ? ORDER BY rowid").all(userId) as any[]).map((r) => ({
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    body: r.body,
    data: r.data_json ? JSON.parse(r.data_json) : undefined,
    generatedAt: r.generated_at,
  }));
}

export { merchantKeyOf };
