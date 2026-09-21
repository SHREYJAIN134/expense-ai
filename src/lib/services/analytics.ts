/** Assembles structured analytics payloads for the API. All maths lives in ../analytics/*. */
import {
  calculateCashFlow,
  calculateCategorySpend,
  calculateCategoryTrend,
  calculateIncomeSources,
  calculateMerchantSpend,
  calculatePatterns,
  calculatePeriods,
  calculateSummary,
  detectAnomalies,
  isSpending,
} from "../analytics/engine";
import { monthlyCommitments } from "../analytics/planning";
import { spendingSeries } from "../analytics/compare";
import { addDays, financialMonthRange, todayISO, type Granularity, type ISODate } from "../util/dates";
import { round2, sum } from "../util/money";
import { currentBalance, dataRange, loadAllTxns, loadTxns, memoize, type TxnFilter } from "./data";
import { detectSeries, getBudgetStatus, getManualObligations, getUpcoming, storedInsights, regenerateInsights, getForecast } from "./planning";
import { getSettings } from "./users";
import { hasDemoData } from "./demo";

export interface AnalyticsFilter extends TxnFilter {
  granularity?: Granularity;
}

export function parseFilter(sp: URLSearchParams): TxnFilter {
  const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    from: iso(sp.get("from")),
    to: iso(sp.get("to")),
    category: sp.get("category") || null,
    merchant: sp.get("merchant") || null,
    basis: sp.get("basis") === "value" ? "value" : "transaction",
  };
}

function downsampleCashflow(points: ReturnType<typeof calculateCashFlow>) {
  if (points.length <= 500) return points;
  const step = Math.ceil(points.length / 500);
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

export function getPeriodSeries(userId: string, g: Granularity, f: TxnFilter) {
  const msd = getSettings(userId).monthStartDay;
  const txns = loadTxns(userId, f);
  let points = calculatePeriods(txns, g, msd);
  if (g === "daily" && points.length > 400) points = points.slice(-400);
  return { granularity: g, points };
}

export function getCategories(userId: string, f: TxnFilter) {
  const msd = getSettings(userId).monthStartDay;
  const txns = loadTxns(userId, f);
  const spend = calculateCategorySpend(txns);
  const prevMonthCompare = (() => {
    const today = todayISO();
    const cur = financialMonthRange(today, msd);
    const prev = financialMonthRange(addDays(cur.from, -1), msd);
    const all = f.category ? loadTxns(userId, { category: f.category }) : loadAllTxns(userId);
    const a = new Map(calculateCategorySpend(all.filter((t) => t.date >= cur.from && t.date <= cur.to)).map((c) => [c.category, c.amount]));
    const b = new Map(calculateCategorySpend(all.filter((t) => t.date >= prev.from && t.date <= prev.to)).map((c) => [c.category, c.amount]));
    const keys = [...new Set([...a.keys(), ...b.keys()])];
    return {
      current: { from: cur.from, to: cur.to },
      previous: { from: prev.from, to: prev.to },
      rows: keys.map((k) => ({ category: k, current: a.get(k) ?? 0, previous: b.get(k) ?? 0 })).sort((x, y) => y.current + y.previous - (x.current + x.previous)),
    };
  })();
  return { categories: spend, trend: calculateCategoryTrend(txns, "monthly", 6, msd), monthComparison: prevMonthCompare };
}

export function getMerchants(userId: string, f: TxnFilter, includeTransfers = false) {
  const txns = loadTxns(userId, f);
  return { merchants: calculateMerchantSpend(txns, { includeTransfers, limit: 50 }) };
}

export function getPatterns(userId: string, f: TxnFilter) {
  const msd = getSettings(userId).monthStartDay;
  const txns = loadTxns(userId, f);
  const spend = txns.filter(isSpending);
  const anomalies = detectAnomalies(txns, { limit: 20 });
  const outlierIds = new Set(anomalies.map((a) => a.txn.id));
  const largest = [...txns].sort((a, b) => b.amount - a.amount).slice(0, 12).map((t) => ({
    id: t.id, date: t.date, merchant: t.merchant, category: t.category, amount: t.amount, direction: t.direction, isOutlier: outlierIds.has(t.id),
  }));
  // Debit vs credit scatter (capped, keeping the biggest movements)
  const scatter = [...txns]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 600)
    .map((t) => ({ id: t.id, date: t.date, amount: t.amount, direction: t.direction, merchant: t.merchant, category: t.category, outlier: outlierIds.has(t.id) }));
  const spendTotal = round2(sum(spend.map((t) => t.debit)));
  return { patterns: calculatePatterns(txns, msd), anomalies, largest, scatter, spendTotal };
}

export function getCashflow(userId: string, f: TxnFilter) {
  const txns = loadTxns(userId, f);
  const msd = getSettings(userId).monthStartDay;
  const monthly = calculatePeriods(txns, "monthly", msd);
  return {
    timeline: downsampleCashflow(calculateCashFlow(txns)),
    monthly: monthly.map((m) => ({ key: m.key, label: m.label, income: m.income, spending: m.spending, netCashFlow: m.netCashFlow, savings: m.savings, savingsRate: m.savingsRate })),
    incomeSources: calculateIncomeSources(txns),
  };
}

/** Everything the dashboard needs in a single, memoised call. */
export function getOverview(userId: string, f: TxnFilter, asOf: ISODate = todayISO()) {
  const key = `overview:${asOf}:${f.basis ?? ""}:${f.from ?? ""}:${f.to ?? ""}:${f.category ?? ""}:${f.merchant ?? ""}`;
  return memoize(userId, key, () => {
    const settings = getSettings(userId);
    const msd = settings.monthStartDay;
    const all = loadAllTxns(userId);
    const txns = loadTxns(userId, f);
    const summary = calculateSummary(txns);
    const cur = financialMonthRange(asOf, msd);
    const monthTxns = all.filter((t) => t.date >= cur.from && t.date <= cur.to);
    const thisMonth = calculateSummary(monthTxns);
    const bal = currentBalance(userId);
    const series = detectSeries(userId, asOf);
    const manual = getManualObligations(userId);
    const upcoming = getUpcoming(userId, 30, asOf);
    const forecast = getForecast(userId, { days: 30, asOf });
    let insights = storedInsights(userId);
    if (!insights.length && all.length) insights = regenerateInsights(userId, asOf).map((i) => ({ ...i, generatedAt: new Date().toISOString() }));
    const monthly = calculatePeriods(txns, "monthly", msd);
    // Refund-netted daily spending (same definition as the Financial Snapshot), shaped like a PeriodPoint for the charts.
    const daily = spendingSeries(txns, "daily", msd)
      .slice(-90)
      .map((p) => ({ key: p.key, label: p.label, start: p.start, income: p.income, spending: p.spending, refunds: 0, credits: 0, debits: 0, netCashFlow: p.netCashFlow, savings: 0, savingsRate: null, transfersIn: 0, transfersOut: 0, count: p.count }));
    return {
      hasData: all.length > 0,
      hasDemo: hasDemoData(userId),
      dataRange: dataRange(userId),
      asOf,
      filters: f,
      summary,
      thisMonth: { from: cur.from, to: cur.to, spending: thisMonth.spending, income: thisMonth.income, netCashFlow: thisMonth.netCashFlow, transactionCount: thisMonth.transactionCount },
      balance: bal,
      monthly,
      daily,
      categories: calculateCategorySpend(txns).slice(0, 12),
      merchants: calculateMerchantSpend(txns, { limit: 8 }),
      cashflow: downsampleCashflow(calculateCashFlow(txns)),
      incomeSources: calculateIncomeSources(txns),
      recurring: series.filter((s) => s.kind === "expense" && !s.possiblyEnded).slice(0, 8),
      recurringMonthlyTotal: monthlyCommitments(series, manual),
      upcoming: upcoming.items.filter((i) => i.kind === "expense").slice(0, 8),
      upcomingTotal: round2(sum(upcoming.items.filter((i) => i.kind === "expense").map((i) => i.amount))),
      forecast: {
        expectedIncome: forecast.expectedIncome,
        expectedRecurring: forecast.expectedRecurring,
        discretionary: forecast.discretionary,
        expectedRemaining: forecast.expectedRemaining,
        currentBalance: forecast.currentBalance,
        horizonDays: forecast.horizonDays,
        confidence: forecast.confidence,
        safeToSpend: forecast.safeToSpend,
      },
      budgets: getBudgetStatus(userId, asOf),
      insights: insights.slice(0, 8),
    };
  });
}
