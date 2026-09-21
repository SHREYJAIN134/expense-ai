/**
 * DB-facing side of the financial-intelligence layer. Loads the user's transactions and settings, calls the pure
 * analytics functions in ../analytics/* and memoises the results until the next write (`bumpDataVersion`).
 *
 * Nothing here is stored: anomalies, insights, projections and safe-to-spend are recomputed deterministically from
 * the ledger, so they can never disagree with it. Every function is scoped to one user id.
 */
import { detectUnusualActivity, type UnusualActivity } from "../analytics/anomalies";
import { analyzeSpending, type ChangeThresholds, type PeriodUnit } from "../analytics/compare";
import { buildSnapshot, generateIntelInsights, type FinancialSnapshot, type IntelInsight } from "../analytics/intelligence";
import { buildUpcoming } from "../analytics/planning";
import { computeSafeToSpend, projectCashFlow, type CashFlowProjection, type ProjectionInput, type SafeToSpend } from "../analytics/projection";
import { addDays, todayISO, type ISODate } from "../util/dates";
import { round2, sum } from "../util/money";
import { currentBalance, loadAllTxns, memoize } from "./data";
import { detectSeries, getBudgetStatus, getCommitments, getDismissedKeys, getManualObligations } from "./planning";
import { getSettings, type UserSettings } from "./users";

export function thresholdsFor(s: UserSettings): ChangeThresholds {
  return { minPct: s.changeMinPct, minAmount: s.changeMinAmount, minTxns: s.changeMinTxns };
}

/** Everything the projection / safe-to-spend models need, read once. */
function projectionInput(userId: string, today: ISODate): ProjectionInput & { monthStartDay: number } {
  const s = getSettings(userId);
  const bal = currentBalance(userId);
  return {
    txns: loadAllTxns(userId),
    today,
    balance: bal?.balance ?? null,
    balanceAsOf: bal?.asOf ?? null,
    // Patterns are read as of the last statement date, so they describe what the data actually shows.
    series: detectSeries(userId, bal?.asOf ?? today),
    manual: getManualObligations(userId),
    dismissedKeys: getDismissedKeys(userId),
    safetyBuffer: s.safetyBuffer,
    includeDetectedRecurring: s.includeDetectedRecurring,
    reserveBudgets: s.reserveBudgets,
    monthStartDay: s.monthStartDay,
  };
}

export function getAnomalies(userId: string, today: ISODate = todayISO(), opts: { lookbackDays?: number } = {}): UnusualActivity[] {
  const s = getSettings(userId);
  return memoize(userId, `anomalies:${today}:${opts.lookbackDays ?? ""}:${s.anomalyMinAmount}`, () => {
    const txns = loadAllTxns(userId);
    const recurringIds = new Set([...txns.filter((t) => t.isRecurring).map((t) => t.id), ...detectSeries(userId, today).filter((r) => r.kind === "expense").flatMap((r) => r.txnIds)]);
    return detectUnusualActivity(txns, { asOf: today, lookbackDays: opts.lookbackDays, minAmount: s.anomalyMinAmount, recurringIds });
  });
}

/** txn id -> the strongest unusual-activity finding that references it (for badges in the transaction list). */
export function anomalyFlags(userId: string, today: ISODate = todayISO()): Map<string, { id: string; type: string; severity: string; reason: string }> {
  const map = new Map<string, { id: string; type: string; severity: string; reason: string }>();
  const rank = { high: 3, medium: 2, low: 1 } as const;
  for (const a of getAnomalies(userId, today, { lookbackDays: 3650 })) {
    for (const id of a.txnIds) {
      const cur = map.get(id);
      if (!cur || rank[a.severity] > rank[cur.severity as keyof typeof rank]) map.set(id, { id: a.id, type: a.type, severity: a.severity, reason: a.reason });
    }
  }
  return map;
}

export function getSpendingIntelligence(userId: string, unit: PeriodUnit = "month", today: ISODate = todayISO()) {
  const s = getSettings(userId);
  return memoize(userId, `spending:${unit}:${today}:${s.monthStartDay}:${s.changeMinPct}:${s.changeMinAmount}:${s.changeMinTxns}`, () =>
    analyzeSpending(loadAllTxns(userId), { asOf: today, unit, monthStartDay: s.monthStartDay, thresholds: thresholdsFor(s) }),
  );
}

export function getProjection(userId: string, today: ISODate = todayISO()): CashFlowProjection {
  const s = getSettings(userId);
  return memoize(userId, `projection:${today}:${s.safetyBuffer}:${s.includeDetectedRecurring}`, () => projectCashFlow(projectionInput(userId, today)));
}

export function getSafeToSpend(userId: string, today: ISODate = todayISO()): SafeToSpend {
  const s = getSettings(userId);
  return memoize(userId, `safe:${today}:${s.safetyBuffer}:${s.includeDetectedRecurring}:${s.reserveBudgets}`, () =>
    computeSafeToSpend({ ...projectionInput(userId, today), budgets: getBudgetStatus(userId, today) }),
  );
}

export function getSnapshot(userId: string, unit: PeriodUnit = "month", today: ISODate = todayISO()): FinancialSnapshot {
  const series = detectSeries(userId, today);
  const manual = getManualObligations(userId);
  const active = series.filter((r) => r.kind === "expense" && !r.possiblyEnded);
  const upcoming = buildUpcoming({ asOf: today, to: addDays(today, 30), series, manual, dismissedKeys: getDismissedKeys(userId) }).filter((u) => u.kind === "expense");
  return buildSnapshot({
    spending: getSpendingIntelligence(userId, unit, today),
    balance: currentBalance(userId),
    today,
    recurringMonthlyTotal: getCommitments(userId, today), // same figure as the Recurring page (detected + entered, no double counting)
    recurringCount: active.length + manual.filter((m) => m.kind === "expense").length,
    expectedNext30Days: round2(sum(upcoming.map((u) => u.amount))),
    safe: getSafeToSpend(userId, today),
    anomalies: getAnomalies(userId, today, { lookbackDays: 30 }),
  });
}

export function getInsights(userId: string, today: ISODate = todayISO()): IntelInsight[] {
  const s = getSettings(userId);
  return memoize(userId, `insights:${today}:${s.changeMinPct}:${s.changeMinAmount}:${s.changeMinTxns}:${s.anomalyMinAmount}:${s.safetyBuffer}:${s.includeDetectedRecurring}:${s.reserveBudgets}`, () => {
    const series = detectSeries(userId, today);
    const upcoming = buildUpcoming({ asOf: today, to: addDays(today, 7), series, manual: getManualObligations(userId), dismissedKeys: getDismissedKeys(userId) });
    return generateIntelInsights({
      txns: loadAllTxns(userId),
      asOf: today,
      monthStartDay: s.monthStartDay,
      spending: getSpendingIntelligence(userId, "month", today),
      anomalies: getAnomalies(userId, today, { lookbackDays: 60 }),
      series,
      upcoming,
      safe: getSafeToSpend(userId, today),
      budgets: getBudgetStatus(userId, today),
    });
  });
}
