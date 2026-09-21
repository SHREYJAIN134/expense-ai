/**
 * Forward-looking calculations: upcoming payments, cash-flow forecast, budgets.
 * All outputs are ESTIMATES derived from historical patterns and the user's own
 * manually-entered obligations. They are never presented as guaranteed.
 */
import type { TxnLite } from "../domain/types";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  financialMonthRange,
  isoWeekday,
  parseISO,
  toISO,
  type ISODate,
} from "../util/dates";
import { mean, median, round2, sum } from "../util/money";
import { isSpending } from "./engine";
import { detectRecurringExpenses, monthlyEquivalent, type Frequency, type RecurringSeries } from "./recurring";
import { merchantKeyOf } from "../classification/merchants";

/* --------------------------------- upcoming --------------------------------- */

export interface ManualObligation {
  id: string;
  name: string;
  amount: number;
  frequency: Frequency;
  /** Day of month for monthly/quarterly/yearly; weekday 1-7 for weekly/biweekly. */
  dueDay?: number | null;
  startDate?: ISODate | null;
  category: string;
  kind: "expense" | "income";
  merchantKey?: string | null;
}

export interface UpcomingItem {
  id: string;
  name: string;
  amount: number;
  date: ISODate;
  kind: "expense" | "income";
  source: "manual" | "detected";
  category: string;
  frequency: Frequency;
  confidence: "Manual" | "High" | "Medium" | "Low";
  overdue?: boolean;
  basis: string;
}

/** All occurrence dates of a manual obligation within [from, to]. */
export function obligationDates(o: ManualObligation, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  if (o.frequency === "weekly" || o.frequency === "biweekly") {
    const step = o.frequency === "weekly" ? 7 : 14;
    let anchor: ISODate;
    if (o.startDate) anchor = o.startDate;
    else {
      // first date on/after `from` that falls on due weekday (default Monday)
      const wd = o.dueDay && o.dueDay >= 1 && o.dueDay <= 7 ? o.dueDay : 1;
      anchor = addDays(from, (wd - isoWeekday(from) + 7) % 7);
    }
    let d = anchor;
    if (d < from) d = addDays(d, Math.ceil(daysBetween(d, from) / step) * step);
    for (; d <= to; d = addDays(d, step)) out.push(d);
    return out;
  }
  const monthStep = o.frequency === "monthly" ? 1 : o.frequency === "quarterly" ? 3 : 12;
  const anchorMonthDate = o.startDate ?? from;
  const day = o.dueDay ?? Number(anchorMonthDate.slice(8, 10));
  // walk from a month before `from` to be safe
  const startY = Number(from.slice(0, 4));
  const startM = Number(from.slice(5, 7));
  const anchorTotal = Number(anchorMonthDate.slice(0, 4)) * 12 + Number(anchorMonthDate.slice(5, 7)) - 1;
  for (let i = -1; i <= 400; i++) {
    const total = startY * 12 + startM - 1 + i;
    if (monthStep > 1 && (((total - anchorTotal) % monthStep) + monthStep) % monthStep !== 0) continue;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const d = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, "0")}`;
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** A detected series and a manual entry describe the same payment. */
function sameObligation(s: RecurringSeries, m: ManualObligation): boolean {
  if (m.merchantKey && m.merchantKey === merchantKeyOf(s.merchant)) return true;
  if (m.kind !== s.kind) return false;
  const nameKey = merchantKeyOf(m.name);
  const sKey = merchantKeyOf(s.merchant);
  if (nameKey && (sKey.includes(nameKey) || nameKey.includes(sKey))) return true;
  return (
    m.category === s.category &&
    m.frequency === s.frequency &&
    Math.abs(m.amount - s.averageAmount) <= Math.max(50, 0.15 * s.averageAmount)
  );
}

export function buildUpcoming(opts: {
  asOf: ISODate;
  to: ISODate;
  series: RecurringSeries[];
  manual: ManualObligation[];
  dismissedKeys?: Set<string>;
  includeIncome?: boolean;
}): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  const { asOf, to } = opts;

  for (const m of opts.manual) {
    if (m.kind === "income" && !opts.includeIncome) continue;
    for (const d of obligationDates(m, asOf, to)) {
      items.push({
        id: `${m.id}:${d}`,
        name: m.name,
        amount: round2(m.amount),
        date: d,
        kind: m.kind,
        source: "manual",
        category: m.category,
        frequency: m.frequency,
        confidence: "Manual",
        basis: "Entered by you as a recurring obligation",
      });
    }
  }

  for (const s of opts.series) {
    if (s.possiblyEnded) continue;
    if (s.kind === "income" && !opts.includeIncome) continue;
    if (opts.dismissedKeys?.has(merchantKeyOf(s.merchant))) continue;
    if (opts.manual.some((m) => sameObligation(s, m))) continue;
    // Project forward from lastDate until beyond `to`; keep dates >= asOf (or the overdue expected date).
    let d = s.nextExpected;
    let guard = 0;
    const day = Number(s.lastDate.slice(8, 10));
    const usesDay = s.frequency === "monthly" || s.frequency === "quarterly" || s.frequency === "yearly";
    while (d <= to && guard++ < 60) {
      if (d >= asOf || s.overdue) {
        items.push({
          id: `${s.key}:${d}`,
          name: s.merchant,
          amount: s.expectedAmount,
          date: d < asOf ? asOf : d,
          kind: s.kind,
          source: "detected",
          category: s.category,
          frequency: s.frequency,
          confidence: s.confidenceLabel,
          overdue: d < asOf,
          basis: `Estimated from ${s.occurrences} past payments (${s.amountPattern === "fixed" ? "fixed amount" : "average amount"}, ${s.frequency})`,
        });
      }
      const from = d;
      d = s.frequency === "weekly" ? addDays(from, 7) : s.frequency === "biweekly" ? addDays(from, 14) : addMonths(from, s.frequency === "monthly" ? 1 : s.frequency === "quarterly" ? 3 : 12, usesDay ? day : undefined);
    }
  }
  return items.sort((a, b) => (a.date === b.date ? b.amount - a.amount : a.date < b.date ? -1 : 1));
}

/* --------------------------------- forecast --------------------------------- */

export interface Forecast {
  asOf: ISODate;
  to: ISODate;
  horizonDays: number;
  currentBalance: number | null;
  balanceAsOf: ISODate | null;
  expectedIncome: number;
  expectedIncomeBasis: string;
  expectedRecurring: number;
  discretionary: { expected: number; low: number; high: number; dailyAverage: number };
  /** balance + income - recurring - discretionary (null when balance unknown). */
  expectedRemaining: number | null;
  expectedRemainingLow: number | null;
  expectedRemainingHigh: number | null;
  /** Net change over the horizon regardless of balance. */
  expectedNet: number;
  buffer: number;
  safeToSpend: number | null;
  upcoming: UpcomingItem[];
  assumptions: string[];
  dataDays: number;
  confidence: "Low" | "Medium" | "Higher";
}

export function buildForecast(opts: {
  txns: TxnLite[];
  asOf: ISODate;
  to: ISODate;
  manual: ManualObligation[];
  series?: RecurringSeries[];
  dismissedKeys?: Set<string>;
  currentBalance: number | null;
  balanceAsOf?: ISODate | null;
  /** Extra planned one-off spend to subtract (e.g. "if I spend 10,000"). */
  planned?: number;
  /** User-chosen safety buffer in rupees; when omitted the buffer is 10% of typical monthly spending. */
  bufferOverride?: number | null;
}): Forecast {
  const { txns, asOf, to } = opts;
  const horizon = Math.max(1, daysBetween(asOf, to) + 1);
  const series = opts.series ?? detectRecurringExpenses(txns, { asOf, includeIncome: true });
  const upcoming = buildUpcoming({ asOf, to, series, manual: opts.manual, dismissedKeys: opts.dismissedKeys, includeIncome: true });
  const expenseItems = upcoming.filter((u) => u.kind === "expense");
  const incomeItems = upcoming.filter((u) => u.kind === "income");
  const expectedRecurring = sum(expenseItems.map((u) => u.amount));

  // history window: last 90 days before asOf
  const histFrom = addDays(asOf, -89);
  const hist = txns.filter((t) => t.date >= histFrom && t.date <= asOf);
  const dataDays = hist.length ? Math.min(90, daysBetween(hist.reduce((a, t) => (t.date < a ? t.date : a), hist[0].date), asOf) + 1) : 0;
  const assumptions: string[] = [];

  // Expected income
  // If a regular income pattern exists (or the user entered one) trust it - even when the next
  // payment falls outside the horizon (then expected income is legitimately 0 for the window).
  const hasIncomePattern = series.some((s) => s.kind === "income" && !s.possiblyEnded) || opts.manual.some((m) => m.kind === "income");
  let expectedIncome = sum(incomeItems.map((u) => u.amount));
  let incomeBasis: string;
  if (incomeItems.length) {
    incomeBasis = "Recurring income pattern found in your history";
  } else if (hasIncomePattern) {
    incomeBasis = "Recurring income pattern found, but no payment is expected inside this window";
  } else {
    const incomeHist = sum(hist.filter((t) => t.direction === "credit" && t.category === "SALARY/INCOME").map((t) => t.credit));
    const perDay = dataDays > 0 ? incomeHist / Math.max(dataDays, 30) : 0;
    expectedIncome = round2(perDay * horizon);
    incomeBasis = dataDays > 0 ? "Average income from your last 90 days (no regular pattern detected)" : "No income history available";
  }
  assumptions.push(incomeBasis + ".");

  // Discretionary = spending that isn't part of a recurring series
  const recurringIds = new Set(series.filter((s) => s.kind === "expense").flatMap((s) => s.txnIds));
  const disc = hist.filter((t) => isSpending(t) && !recurringIds.has(t.id));
  const discTotal = sum(disc.map((t) => t.debit));
  const dailyAvg = dataDays > 0 ? discTotal / Math.max(dataDays, 1) : 0;
  const expectedDisc = round2(dailyAvg * horizon);
  // Range from month-to-month variation (30-day windows), falling back to +/-20%.
  const windows: number[] = [];
  for (let w = 0; w < 3; w++) {
    const wFrom = addDays(asOf, -30 * (w + 1) + 1);
    const wTo = addDays(asOf, -30 * w);
    if (wFrom < histFrom) break;
    const v = sum(disc.filter((t) => t.date >= wFrom && t.date <= wTo).map((t) => t.debit));
    if (v > 0) windows.push(v);
  }
  let low = expectedDisc * 0.8;
  let high = expectedDisc * 1.2;
  if (windows.length >= 2) {
    low = (Math.min(...windows) / 30) * horizon;
    high = (Math.max(...windows) / 30) * horizon;
  }
  assumptions.push(
    dataDays > 0
      ? `Everyday spending is estimated from your non-recurring spending over the last ${dataDays} days (about ${Math.round(dailyAvg)}/day).`
      : "No spending history available to estimate everyday spending.",
  );
  assumptions.push("Recurring items come from patterns in your past payments plus obligations you entered manually.");
  if (opts.planned) assumptions.push(`Includes a planned one-off expense of ${round2(opts.planned)} that you specified.`);

  const planned = opts.planned ?? 0;
  const monthlySpend = mean(
    [0, 1, 2]
      .map((w) => sum(hist.filter((t) => isSpending(t) && t.date >= addDays(asOf, -30 * (w + 1) + 1) && t.date <= addDays(asOf, -30 * w)).map((t) => t.debit)))
      .filter((v) => v > 0),
  );
  const buffer = opts.bufferOverride != null ? round2(opts.bufferOverride) : round2(monthlySpend * 0.1);
  const bal = opts.currentBalance;
  const net = round2(expectedIncome - expectedRecurring - expectedDisc - planned);
  const remaining = bal === null ? null : round2(bal + net);
  const remLow = bal === null ? null : round2(bal + expectedIncome - expectedRecurring - high - planned);
  const remHigh = bal === null ? null : round2(bal + expectedIncome - expectedRecurring - low - planned);
  const safe = remaining === null ? null : Math.max(0, round2(remaining - buffer));
  assumptions.push(opts.bufferOverride != null ? `The safety buffer of ${buffer} that you set is kept aside when calculating 'safe to spend'.` : `A safety buffer of ${buffer} (10% of typical monthly spending) is kept aside when calculating 'safe to spend'.`);
  if (bal === null) assumptions.push("Current balance is unknown (statements without balance column), so remaining cash cannot be computed.");

  return {
    asOf,
    to,
    horizonDays: horizon,
    currentBalance: bal,
    balanceAsOf: opts.balanceAsOf ?? null,
    expectedIncome: round2(expectedIncome),
    expectedIncomeBasis: incomeBasis,
    expectedRecurring,
    discretionary: { expected: expectedDisc, low: round2(low), high: round2(high), dailyAverage: round2(dailyAvg) },
    expectedRemaining: remaining,
    expectedRemainingLow: remLow,
    expectedRemainingHigh: remHigh,
    expectedNet: net,
    buffer,
    safeToSpend: safe,
    upcoming,
    assumptions,
    dataDays,
    confidence: dataDays >= 75 && series.length >= 3 ? "Higher" : dataDays >= 30 ? "Medium" : "Low",
  };
}

/* ---------------------------------- budgets ---------------------------------- */

export interface BudgetInput {
  id: string;
  category: string;
  amount: number;
  alertThreshold: number;
}

export type BudgetStatus = "ok" | "warning" | "projected_over" | "over";

export interface BudgetVariance {
  id: string;
  category: string;
  budget: number;
  actual: number;
  remaining: number;
  pctUsed: number;
  projected: number;
  projectedPct: number;
  variance: number;
  status: BudgetStatus;
  message: string;
  average3m: number;
  periodStart: ISODate;
  periodEnd: ISODate;
  daysElapsed: number;
  daysTotal: number;
}

export function calculateBudgetVariance(
  budgets: BudgetInput[],
  txns: TxnLite[],
  asOf: ISODate,
  monthStartDay = 1,
): BudgetVariance[] {
  const range = financialMonthRange(asOf, monthStartDay);
  const daysTotal = daysBetween(range.from, range.to) + 1;
  const daysElapsed = Math.min(daysTotal, Math.max(1, daysBetween(range.from, asOf) + 1));
  return budgets.map((b) => {
    const inCat = txns.filter((t) => isSpending(t) && t.category === b.category);
    const actual = sum(inCat.filter((t) => t.date >= range.from && t.date <= range.to).map((t) => t.debit));
    // Projection: linear run-rate, blended with the 3-month average early in the month (few data points).
    const prior: number[] = [];
    for (let m = 1; m <= 3; m++) {
      const pr = financialMonthRange(addMonths(range.from, -m, monthStartDay > 1 ? monthStartDay : 1), monthStartDay);
      const v = sum(inCat.filter((t) => t.date >= pr.from && t.date <= pr.to).map((t) => t.debit));
      if (v > 0) prior.push(v);
    }
    const avg3 = prior.length ? round2(mean(prior)) : 0;
    const runRate = (actual / daysElapsed) * daysTotal;
    const w = Math.min(1, daysElapsed / 10);
    const projected = round2(avg3 > 0 ? Math.max(actual, runRate * w + avg3 * (1 - w)) : Math.max(actual, runRate));
    const pctUsed = b.amount > 0 ? Math.round((actual / b.amount) * 1000) / 10 : 0;
    const projectedPct = b.amount > 0 ? Math.round((projected / b.amount) * 1000) / 10 : 0;
    let status: BudgetStatus = "ok";
    let message = `On track: ${pctUsed}% used with ${daysTotal - daysElapsed} days left.`;
    if (actual > b.amount) {
      status = "over";
      message = `Over budget by ${round2(actual - b.amount)}.`;
    } else if (projected > b.amount) {
      status = "projected_over";
      message = `Projected to reach about ${Math.round(projected)} by period end (estimate) - over the ${b.amount} budget.`;
    } else if (actual >= b.amount * b.alertThreshold) {
      status = "warning";
      message = `${pctUsed}% of budget used - approaching your ${Math.round(b.alertThreshold * 100)}% alert threshold.`;
    }
    return {
      id: b.id,
      category: b.category,
      budget: b.amount,
      actual,
      remaining: round2(b.amount - actual),
      pctUsed,
      projected,
      projectedPct,
      variance: round2(actual - b.amount),
      status,
      message,
      average3m: avg3,
      periodStart: range.from,
      periodEnd: range.to,
      daysElapsed,
      daysTotal,
    };
  });
}

/** Sum of the monthly-equivalent of every active recurring obligation (manual + detected). */
export function monthlyCommitments(series: RecurringSeries[], manual: ManualObligation[]): number {
  const detected = series
    .filter((s) => s.kind === "expense" && !s.possiblyEnded && !manual.some((m) => sameObligation(s, m)))
    .map(monthlyEquivalent);
  const man = manual.filter((m) => m.kind === "expense").map((m) => monthlyEquivalent({ frequency: m.frequency, averageAmount: m.amount }));
  return sum([...detected, ...man]);
}

export { median, parseISO, toISO };
