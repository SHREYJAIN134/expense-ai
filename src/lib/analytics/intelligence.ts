/**
 * Financial Snapshot and the deterministic insights feed.
 *
 * Every insight is produced by a rule over the user's own numbers. A language model never writes, chooses or
 * numbers an insight, so every one of them can be reproduced from the database (each carries the calculation that
 * produced it and the ids of the transactions / categories behind it).
 *
 * There is deliberately NO overall "financial health score": one number cannot honestly summarise a person's
 * finances, and a made-up score would suggest precision the data does not have.
 */
import { categoryLabel } from "../domain/categories";
import type { TxnLite } from "../domain/types";
import { addDays, daysBetween, financialMonthRange, formatDateLong, type ISODate } from "../util/dates";
import { formatINR, round2, sum } from "../util/money";
import type { UnusualActivity } from "./anomalies";
import {
  spendingSeries,
  type CategoryRow,
  type MerchantRow,
  type SpendingIntelligence,
} from "./compare";
import type { BudgetVariance, UpcomingItem } from "./planning";
import type { SafeToSpend } from "./projection";
import { monthlyEquivalent, type RecurringSeries } from "./recurring";

export type InsightSeverity = "info" | "positive" | "watch" | "attention";

export interface IntelInsight {
  /** Deterministic: the same situation always yields the same id. */
  id: string;
  kind:
    | "spending_up"
    | "spending_down"
    | "category_spike"
    | "category_drop"
    | "merchant_spike"
    | "large_transaction"
    | "unusual_activity"
    | "recurring_detected"
    | "upcoming_recurring"
    | "high_discretionary"
    | "positive_cashflow"
    | "negative_cashflow"
    | "budget"
    | "stale_data";
  severity: InsightSeverity;
  title: string;
  /** Plain-language explanation. Contains only numbers computed below. */
  explanation: string;
  metric: { label: string; value: number; unit: "inr" | "pct" | "count"; previous?: number | null };
  /** The day the insight is about (drives the chronological feed). */
  date: ISODate;
  txnIds: string[];
  categories: string[];
  merchants: string[];
  /** How the number was calculated - the reproducibility trail. */
  calculation: string;
}

/* ------------------------------------ snapshot ------------------------------------ */

export interface SnapshotDelta {
  value: number;
  previous: number;
  /** null when the previous value is 0. */
  changePct: number | null;
}

export interface FinancialSnapshot {
  periodLabel: string;
  from: ISODate;
  to: ISODate;
  previousLabel: string;
  partial: boolean;
  balance: { amount: number; asOf: ISODate; staleDays: number } | null;
  income: SnapshotDelta;
  spending: SnapshotDelta & { gross: number; refunded: number };
  netCashFlow: SnapshotDelta;
  largestCategory: { category: string; amount: number; pctOfSpending: number; changePct: number | null } | null;
  largestMerchant: { merchant: string; amount: number; count: number; changePct: number | null } | null;
  recurring: { monthlyTotal: number; expectedNext30Days: number; count: number };
  discretionary: { safeToSpend: number | null; shortfall: number; through: ISODate; disclaimer: string };
  unusual: { total: number; high: number; medium: number; top: { id: string; type: string; severity: string; reason: string; date: ISODate }[] };
  caveats: string[];
}

const delta = (value: number, previous: number): SnapshotDelta => ({
  value: round2(value),
  previous: round2(previous),
  changePct: previous !== 0 ? Math.round(((value - previous) / Math.abs(previous)) * 1000) / 10 : null,
});

export function buildSnapshot(opts: {
  spending: SpendingIntelligence;
  balance: { balance: number; asOf: ISODate } | null;
  today: ISODate;
  recurringMonthlyTotal: number;
  recurringCount: number;
  expectedNext30Days: number;
  safe: SafeToSpend;
  anomalies: UnusualActivity[];
}): FinancialSnapshot {
  const { spending: sp } = opts;
  const cur = sp.totals.current;
  const prev = sp.totals.previous;
  const topCat = sp.categories[0] ?? null;
  const topMerch = sp.merchants[0] ?? null;
  return {
    periodLabel: sp.periods.current.label,
    from: sp.periods.current.from,
    to: sp.periods.current.to,
    previousLabel: sp.periods.previous.label,
    partial: sp.periods.partial,
    balance: opts.balance ? { amount: opts.balance.balance, asOf: opts.balance.asOf, staleDays: Math.max(0, daysBetween(opts.balance.asOf, opts.today)) } : null,
    income: delta(cur.income, prev.income),
    spending: { ...delta(cur.net, prev.net), gross: cur.gross, refunded: round2(cur.refunded + cur.unlinkedRefunds) },
    netCashFlow: delta(cur.netCashFlow, prev.netCashFlow),
    largestCategory: topCat ? { category: topCat.key, amount: topCat.amount, pctOfSpending: topCat.pctOfSpending, changePct: topCat.change.pctChange } : null,
    largestMerchant: topMerch ? { merchant: topMerch.key, amount: topMerch.amount, count: topMerch.count, changePct: topMerch.change.pctChange } : null,
    recurring: { monthlyTotal: opts.recurringMonthlyTotal, expectedNext30Days: opts.expectedNext30Days, count: opts.recurringCount },
    discretionary: { safeToSpend: opts.safe.amount, shortfall: opts.safe.shortfall, through: opts.safe.to, disclaimer: opts.safe.disclaimer },
    unusual: {
      total: opts.anomalies.length,
      high: opts.anomalies.filter((a) => a.severity === "high").length,
      medium: opts.anomalies.filter((a) => a.severity === "medium").length,
      top: opts.anomalies.slice(0, 3).map((a) => ({ id: a.id, type: a.type, severity: a.severity, reason: a.reason, date: a.date })),
    },
    caveats: sp.caveats,
  };
}

/* ------------------------------------ insights ------------------------------------ */

const SEV_RANK: Record<InsightSeverity, number> = { attention: 3, watch: 2, positive: 1, info: 0 };
const pctText = (p: number | null) => (p === null ? "" : ` (${p > 0 ? "+" : ""}${p}%)`);

export function generateIntelInsights(opts: {
  txns: TxnLite[];
  asOf: ISODate;
  monthStartDay: number;
  /** Refund-netted analysis of the current month vs the same point of the previous month. */
  spending: SpendingIntelligence;
  anomalies: UnusualActivity[];
  series: RecurringSeries[];
  upcoming: UpcomingItem[];
  safe: SafeToSpend;
  budgets?: BudgetVariance[];
}): IntelInsight[] {
  const { txns, asOf, spending: sp, safe } = opts;
  const th = sp.thresholds;
  const out: IntelInsight[] = [];
  if (!txns.length) return out;
  const firstDate = txns.reduce((a, t) => (t.date < a ? t.date : a), txns[0].date);
  const lastDate = txns.reduce((a, t) => (t.date > a ? t.date : a), txns[0].date);
  const cur = sp.totals.current;
  const prev = sp.totals.previous;
  const periodLabel = sp.periods.current.label.toLowerCase();
  const prevLabel = sp.periods.previous.label.toLowerCase();
  const like = sp.periods.partial ? `the same point ${prevLabel}` : prevLabel;
  const previousComplete = firstDate <= sp.periods.previous.from; // history covers the whole previous period

  // Data freshness
  const staleDays = daysBetween(lastDate, asOf);
  if (staleDays > 10) {
    out.push({
      id: `stale_data:${lastDate}`,
      kind: "stale_data",
      severity: staleDays > 40 ? "attention" : "info",
      title: "Your data may be out of date",
      explanation: `The newest transaction is from ${formatDateLong(lastDate)} (${staleDays} days ago). Balances, projections and safe-to-spend are based on that date; upload a newer statement to bring them up to date.`,
      metric: { label: "Days since last transaction", value: staleDays, unit: "count" },
      date: asOf,
      txnIds: [],
      categories: [],
      merchants: [],
      calculation: `${asOf} minus the date of the latest transaction (${lastDate}).`,
    });
  }

  // Spending up / down vs previous equivalent period
  if (previousComplete && prev.spendingCount >= th.minTxns && prev.net > 0) {
    const d = round2(cur.net - prev.net);
    const p = Math.round((d / prev.net) * 1000) / 10;
    if (Math.abs(d) >= th.minAmount && Math.abs(p) >= th.minPct) {
      const up = d > 0;
      out.push({
        id: `${up ? "spending_up" : "spending_down"}:${sp.periods.unit}:${sp.periods.current.from}`,
        kind: up ? "spending_up" : "spending_down",
        severity: up ? "watch" : "positive",
        title: `Spending is ${up ? "up" : "down"} ${Math.abs(p)}% compared with ${like}`,
        explanation: `You have spent ${formatINR(cur.net)} ${periodLabel}, versus ${formatINR(prev.net)} for ${like}: ${up ? "an increase" : "a decrease"} of ${formatINR(Math.abs(d))}. Refunds are netted and transfers and investments are not counted as spending.${sp.periods.partial ? ` ${sp.periods.current.label} is still in progress.` : ""}`,
        metric: { label: "Net spending", value: cur.net, unit: "inr", previous: prev.net },
        date: sp.periods.current.to,
        txnIds: [],
        categories: sp.changes.categories.slice(0, 3).map((c) => c.key),
        merchants: [],
        calculation: `Net spending ${sp.periods.current.from}..${sp.periods.current.to} = spending debits (excluding transfers & investments) minus linked refunds; compared with ${sp.periods.previous.from}..${sp.periods.previous.to}.`,
      });
    }
  }

  // Category spikes / drops
  const catByKey = new Map<string, CategoryRow>(sp.categories.map((c) => [c.key, c]));
  for (const c of sp.changes.categories.filter((c) => c.kind === "increase" || c.kind === "new").slice(0, 3)) {
    const row = catByKey.get(c.key);
    out.push({
      id: `category_spike:${c.key}:${sp.periods.current.from}`,
      kind: "category_spike",
      severity: c.pctChange !== null && c.pctChange >= th.minPct * 3 ? "attention" : "watch",
      title: c.kind === "new" ? `New spending on ${categoryLabel(c.key)}` : `${categoryLabel(c.key)} spending is up${pctText(c.pctChange)}`,
      explanation: `${categoryLabel(c.key)} is ${formatINR(c.current)} ${periodLabel} across ${c.currentCount} transactions, versus ${formatINR(c.previous)} for ${like}.${row ? ` Largest single payment: ${formatINR(row.largest?.amount ?? 0)} at ${row.largest?.merchant}.` : ""}`,
      metric: { label: categoryLabel(c.key), value: c.current, unit: "inr", previous: c.previous },
      date: sp.periods.current.to,
      txnIds: row?.largest ? [row.largest.id] : [],
      categories: [c.key],
      merchants: [],
      calculation: `Refund-netted ${categoryLabel(c.key)} spending, ${sp.periods.current.from}..${sp.periods.current.to} vs ${sp.periods.previous.from}..${sp.periods.previous.to}. Flagged because the change is at least ${th.minPct}%, ${formatINR(th.minAmount)} and ${th.minTxns} transactions.`,
    });
  }
  for (const c of sp.changes.categories.filter((c) => c.kind === "decrease" || c.kind === "stopped").slice(0, 2)) {
    out.push({
      id: `category_drop:${c.key}:${sp.periods.current.from}`,
      kind: "category_drop",
      severity: "positive",
      title: `${categoryLabel(c.key)} spending is down${pctText(c.pctChange)}`,
      explanation: `${categoryLabel(c.key)} is ${formatINR(c.current)} ${periodLabel}, versus ${formatINR(c.previous)} for ${like}.`,
      metric: { label: categoryLabel(c.key), value: c.current, unit: "inr", previous: c.previous },
      date: sp.periods.current.to,
      txnIds: [],
      categories: [c.key],
      merchants: [],
      calculation: `Refund-netted ${categoryLabel(c.key)} spending, current vs previous equivalent period.`,
    });
  }

  // Merchant spikes
  const merchByKey = new Map<string, MerchantRow>(sp.merchants.map((m) => [m.key, m]));
  for (const c of sp.changes.merchants.filter((c) => c.kind === "increase" || c.kind === "new").slice(0, 3)) {
    const row = merchByKey.get(c.key);
    out.push({
      id: `merchant_spike:${c.key.toLowerCase()}:${sp.periods.current.from}`,
      kind: "merchant_spike",
      severity: "watch",
      title: c.kind === "new" ? `New this period: ${c.key}` : `Spending at ${c.key} is up${pctText(c.pctChange)}`,
      explanation: `${formatINR(c.current)} at ${c.key} ${periodLabel} (${c.currentCount} payments), versus ${formatINR(c.previous)} for ${like}.`,
      metric: { label: c.key, value: c.current, unit: "inr", previous: c.previous },
      date: row?.last ?? sp.periods.current.to,
      txnIds: row?.largest ? [row.largest.id] : [],
      categories: [c.category],
      merchants: [c.key],
      calculation: `Refund-netted spending at ${c.key}, current vs previous equivalent period, thresholds ${th.minPct}% / ${formatINR(th.minAmount)} / ${th.minTxns} transactions.`,
    });
  }

  // Unusual activity (from the anomaly engine)
  for (const a of opts.anomalies.slice(0, 8)) {
    const large = a.type === "large_transaction";
    out.push({
      id: `${large ? "large_transaction" : "unusual_activity"}:${a.id}`,
      kind: large ? "large_transaction" : "unusual_activity",
      severity: a.severity === "high" ? "attention" : a.severity === "medium" ? "watch" : "info",
      title: large ? `Unusually large payment at ${a.merchant}` : titleFor(a),
      explanation: `${a.reason} Unusual doesn't mean wrong - it is just different from your normal pattern (${a.baselineLabel}).`,
      metric: { label: a.unit === "count" ? "Payments" : "Amount", value: a.observed, unit: a.unit === "count" ? "count" : "inr", previous: a.baseline },
      date: a.date,
      txnIds: a.txnIds.slice(0, 12),
      categories: a.category ? [a.category] : [],
      merchants: a.merchant ? [a.merchant] : [],
      calculation: `${a.type.replace(/_/g, " ")}: observed ${a.observed} vs baseline ${a.baseline} from ${a.sampleSize} historical observations${a.score !== null ? ` (robust z-score ${a.score})` : ""}; confidence ${Math.round(a.confidence * 100)}%.`,
    });
  }

  // Recurring payments detected
  const recurring = opts.series.filter((s) => s.kind === "expense" && !s.possiblyEnded && s.confidence >= 0.55).sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a));
  if (recurring.length) {
    const monthly = round2(sum(recurring.map(monthlyEquivalent)));
    const names = recurring.slice(0, 3).map((s) => s.merchant);
    out.push({
      id: `recurring_detected:${recurring.length}:${round2(monthly)}`,
      kind: "recurring_detected",
      severity: "info",
      title: `${recurring.length} recurring payment${recurring.length > 1 ? "s" : ""} detected`,
      explanation: `Repeating payments such as ${names.join(", ")}${recurring.length > 3 ? ` and ${recurring.length - 3} more` : ""} add up to roughly ${formatINR(monthly)} a month. This is an estimate from past patterns (at least 3 similar payments about the same interval apart).`,
      metric: { label: "Estimated per month", value: monthly, unit: "inr" },
      date: recurring.reduce((a, s) => (s.lastDate > a ? s.lastDate : a), recurring[0].lastDate),
      txnIds: recurring.flatMap((s) => s.txnIds.slice(-1)),
      categories: [...new Set(recurring.map((s) => s.category))],
      merchants: recurring.map((s) => s.merchant),
      calculation: "Series with 3+ similar payments at a regular interval, converted to a monthly equivalent and summed.",
    });
  }

  // Upcoming recurring in the next 7 days
  const soon = opts.upcoming.filter((u) => u.kind === "expense" && u.date >= asOf && u.date <= addDays(asOf, 7));
  if (soon.length) {
    const total = round2(sum(soon.map((u) => u.amount)));
    out.push({
      id: `upcoming_recurring:${asOf}:${soon.length}`,
      kind: "upcoming_recurring",
      severity: "info",
      title: `${soon.length} recurring payment${soon.length > 1 ? "s" : ""} expected in the next 7 days`,
      explanation: `About ${formatINR(total)} is expected: ${soon.slice(0, 4).map((u) => `${u.name} (${formatINR(u.amount)}, ${formatDateLong(u.date)})`).join("; ")}. Expected dates and amounts are estimates, not guarantees.`,
      metric: { label: "Expected", value: total, unit: "inr" },
      date: asOf,
      txnIds: [],
      categories: [...new Set(soon.map((u) => u.category))],
      merchants: soon.map((u) => u.name),
      calculation: "Recurring payments (detected + entered by you) whose next expected date is within 7 days.",
    });
  }

  // Estimated discretionary room
  if (safe.amount !== null && safe.balance !== null && safe.balance > 0) {
    const share = Math.round((safe.amount / safe.balance) * 1000) / 10;
    if (safe.amount > 0 && share >= 50) {
      out.push({
        id: `high_discretionary:${asOf}`,
        kind: "high_discretionary",
        severity: "positive",
        title: "You have comfortable room after upcoming commitments",
        explanation: `After upcoming recurring payments, budget commitments and a safety buffer, an estimated ${formatINR(safe.amount)} (${share}% of your balance) is left until ${formatDateLong(safe.to)}. ${safe.disclaimer}`,
        metric: { label: "Estimated safe to spend", value: safe.amount, unit: "inr" },
        date: asOf,
        txnIds: [],
        categories: [],
        merchants: [],
        calculation: `balance ${formatINR(safe.balance)} - recurring ${formatINR(safe.upcomingRecurring)} - budgets ${formatINR(safe.budgetCommitments)} - buffer ${formatINR(safe.safetyBuffer)}.`,
      });
    } else if (safe.shortfall > 0) {
      out.push({
        id: `high_discretionary:short:${asOf}`,
        kind: "high_discretionary",
        severity: "attention",
        title: "Upcoming commitments are larger than your balance",
        explanation: `Recurring payments, budget commitments and the safety buffer come to ${formatINR(safe.upcomingRecurring + safe.budgetCommitments + safe.safetyBuffer)} until ${formatDateLong(safe.to)}, which is ${formatINR(safe.shortfall)} more than your latest balance of ${formatINR(safe.balance)}. Expected income is not counted. ${safe.disclaimer}`,
        metric: { label: "Estimated shortfall", value: safe.shortfall, unit: "inr" },
        date: asOf,
        txnIds: [],
        categories: [],
        merchants: [],
        calculation: `balance ${formatINR(safe.balance)} - recurring ${formatINR(safe.upcomingRecurring)} - budgets ${formatINR(safe.budgetCommitments)} - buffer ${formatINR(safe.safetyBuffer)} is negative.`,
      });
    }
  }

  // Cash-flow trend over complete months
  // Only months that are fully inside the imported data (they ended on or before the newest transaction).
  const complete = spendingSeries(txns, "monthly", opts.monthStartDay).filter(
    (m) => m.count >= 5 && m.start < sp.periods.current.from && financialMonthRange(m.start, opts.monthStartDay).to <= lastDate,
  );
  if (complete.length >= 2) {
    const last3 = complete.slice(-3);
    if (last3.every((m) => m.netCashFlow > 0)) {
      out.push({
        id: `positive_cashflow:${last3[last3.length - 1].key}`,
        kind: "positive_cashflow",
        severity: "positive",
        title: `More came in than went out in each of the last ${last3.length} months`,
        explanation: `Net cash flow (money in minus money out) was ${last3.map((m) => `${formatINR(m.netCashFlow)} in ${m.label}`).join(", ")}.`,
        metric: { label: "Latest month net cash flow", value: last3[last3.length - 1].netCashFlow, unit: "inr", previous: last3[last3.length - 2]?.netCashFlow ?? null },
        date: last3[last3.length - 1].start,
        txnIds: [],
        categories: [],
        merchants: [],
        calculation: "Total credits minus total debits for each complete month (transfers and investments included, since they move real money).",
      });
    } else if (complete[complete.length - 1].netCashFlow < 0) {
      const m = complete[complete.length - 1];
      out.push({
        id: `negative_cashflow:${m.key}`,
        kind: "negative_cashflow",
        severity: "watch",
        title: `More went out than came in in ${m.label}`,
        explanation: `Net cash flow was ${formatINR(m.netCashFlow)} in ${m.label} (money in minus money out, including transfers and investments).`,
        metric: { label: "Net cash flow", value: m.netCashFlow, unit: "inr" },
        date: m.start,
        txnIds: [],
        categories: [],
        merchants: [],
        calculation: "Total credits minus total debits for the latest complete month.",
      });
    }
  }

  // Budgets that need attention
  for (const b of (opts.budgets ?? []).filter((b) => b.status === "over" || b.status === "projected_over")) {
    out.push({
      id: `budget:${b.category}:${b.periodStart}`,
      kind: "budget",
      severity: b.status === "over" ? "attention" : "watch",
      title: b.status === "over" ? `${categoryLabel(b.category)} is over budget` : `${categoryLabel(b.category)} is on track to exceed its budget`,
      explanation: b.message,
      metric: { label: `${categoryLabel(b.category)} spent`, value: b.actual, unit: "inr", previous: b.budget },
      date: asOf,
      txnIds: [],
      categories: [b.category],
      merchants: [],
      calculation: `Spending this financial month vs the ${formatINR(b.budget)} budget (projection uses your run-rate blended with the 3-month average).`,
    });
  }

  return dedupe(out).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || SEV_RANK[b.severity] - SEV_RANK[a.severity] || (a.id < b.id ? -1 : 1));
}

function dedupe(items: IntelInsight[]): IntelInsight[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

function titleFor(a: UnusualActivity): string {
  switch (a.type) {
    case "frequent_transactions":
      return `Unusually frequent payments to ${a.merchant}`;
    case "merchant_spike":
      return `Unusual spending at ${a.merchant}`;
    case "category_spike":
      return `Unusual ${a.category ? categoryLabel(a.category) : "category"} spending`;
    case "unusual_day":
      return "Unusually high spending day";
    case "spending_spike":
      return "Sudden rise in everyday spending";
    case "possible_duplicate":
      return `Duplicate-looking payments to ${a.merchant}`;
    default:
      return "Unusual activity";
  }
}
