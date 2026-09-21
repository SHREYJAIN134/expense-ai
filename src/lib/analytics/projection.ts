/**
 * Upcoming cash-flow projection and the "safe to spend" model.
 *
 * Everything here is an ESTIMATE built from the user's own history and obligations - never a guarantee - and the
 * projected numbers are always kept separate from the actual (statement) balance.
 *
 *   projected balance (committed) = current balance + expected credits - expected recurring payments
 *                                   (recurring = patterns detected in history + obligations the user entered)
 *   projected balance (likely)    = committed balance - typical everyday spending (with a low/high range)
 *
 *   safe to spend = balance - upcoming recurring - budget commitments - safety buffer
 *
 * If the newest statement is older than today, the window starts the day after the statement's last balance, so
 * payments that were probably made in the gap are included rather than silently skipped.
 */
import type { TxnLite } from "../domain/types";
import { addDays, daysBetween, financialMonthRange, type ISODate } from "../util/dates";
import { round2, sum } from "../util/money";
import { buildForecast, type BudgetVariance, type Forecast, type ManualObligation, type UpcomingItem } from "./planning";
import type { RecurringSeries } from "./recurring";

export const SAFE_TO_SPEND_DISCLAIMER = "Safe to spend is an estimate, not a guarantee.";

export interface ProjectionSettings {
  /** null / undefined = automatic (10% of typical monthly spending). */
  safetyBuffer?: number | null;
  /** Count payment patterns detected in history (default true). Obligations the user entered always count. */
  includeDetectedRecurring?: boolean;
  /** Set aside the unspent part of each active budget (default true). */
  reserveBudgets?: boolean;
}

export interface ProjectionInput extends ProjectionSettings {
  txns: TxnLite[];
  today: ISODate;
  balance: number | null;
  balanceAsOf: ISODate | null;
  /** Recurring series detected as of the balance date. */
  series: RecurringSeries[];
  manual: ManualObligation[];
  dismissedKeys?: Set<string>;
  horizons?: number[];
}

export interface ProjectionHorizon {
  days: number;
  /** Last day of the window. */
  to: ISODate;
  expectedCredits: number;
  expectedRecurring: number;
  /** Part of `expectedRecurring` the user entered themselves. */
  knownObligations: number;
  /** Part of `expectedRecurring` detected from history. */
  detectedRecurring: number;
  /** balance + expected credits - expected recurring. null when the balance is unknown. */
  committedBalance: number | null;
  everydaySpending: { expected: number; low: number; high: number };
  /** committedBalance - typical everyday spending, with a range. */
  likelyBalance: number | null;
  likelyLow: number | null;
  likelyHigh: number | null;
  items: UpcomingItem[];
}

export interface ProjectionPoint {
  date: ISODate;
  /** Balance printed on the statements (actual). Only on or before the last statement date. */
  actual?: number;
  /** Projected: balance + expected credits - expected recurring. */
  committed?: number;
  /** Projected: committed - typical everyday spending. */
  likely?: number;
  likelyLow?: number;
  likelyHigh?: number;
}

export interface CashFlowProjection {
  today: ISODate;
  balance: number | null;
  balanceAsOf: ISODate | null;
  /** Days between the last statement balance and today (0 when up to date). */
  staleDays: number;
  horizons: ProjectionHorizon[];
  path: ProjectionPoint[];
  confidence: Forecast["confidence"];
  assumptions: string[];
  disclaimer: string;
}

/** First day NOT yet reflected in the balance: the day after the statement's last balance (tomorrow if unknown). */
function windowStart(today: ISODate, balanceAsOf: ISODate | null): ISODate {
  return addDays(balanceAsOf ?? today, 1);
}

function seriesFor(series: RecurringSeries[], includeDetected: boolean) {
  return series.filter((s) => s.kind === "income" || includeDetected);
}

export function projectCashFlow(input: ProjectionInput): CashFlowProjection {
  const { txns, today, balance, balanceAsOf } = input;
  const includeDetected = input.includeDetectedRecurring ?? true;
  const horizonsWanted = input.horizons ?? [7, 14, 30];
  const start = windowStart(today, balanceAsOf);
  const series = seriesFor(input.series, includeDetected);
  const staleDays = balanceAsOf ? Math.max(0, daysBetween(balanceAsOf, today)) : 0;

  const forecastTo = (to: ISODate): Forecast =>
    buildForecast({
      txns,
      asOf: start,
      to: to < start ? start : to,
      manual: input.manual,
      series,
      dismissedKeys: input.dismissedKeys,
      currentBalance: balance,
      balanceAsOf,
      bufferOverride: input.safetyBuffer,
    });

  const horizons: ProjectionHorizon[] = horizonsWanted.map((days) => {
    const to = addDays(today, days);
    const f = forecastTo(to);
    const expense = f.upcoming.filter((u) => u.kind === "expense");
    const known = sum(expense.filter((u) => u.source === "manual").map((u) => u.amount));
    const detected = sum(expense.filter((u) => u.source === "detected").map((u) => u.amount));
    const committed = balance === null ? null : round2(balance + f.expectedIncome - f.expectedRecurring);
    return {
      days,
      to,
      expectedCredits: f.expectedIncome,
      expectedRecurring: f.expectedRecurring,
      knownObligations: known,
      detectedRecurring: detected,
      committedBalance: committed,
      everydaySpending: { expected: f.discretionary.expected, low: f.discretionary.low, high: f.discretionary.high },
      likelyBalance: f.expectedRemaining,
      likelyLow: f.expectedRemainingLow,
      likelyHigh: f.expectedRemainingHigh,
      items: f.upcoming,
    };
  });

  // Day-by-day path for the chart, from the longest horizon.
  const longest = horizons.reduce((a, h) => (h.days > a.days ? h : a), horizons[0]);
  const path: ProjectionPoint[] = [];
  const f = forecastTo(longest.to);
  const historyFrom = addDays(today, -30);
  const actualByDay = new Map<ISODate, number>();
  for (const t of [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (t.balanceAfter != null && t.date >= historyFrom) actualByDay.set(t.date, t.balanceAfter);
  }
  let carry: number | undefined;
  for (let d = historyFrom; balanceAsOf && d <= balanceAsOf; d = addDays(d, 1)) {
    if (actualByDay.has(d)) carry = actualByDay.get(d);
    if (carry !== undefined) path.push({ date: d, actual: carry });
  }
  if (balance !== null) {
    const daily = f.discretionary.dailyAverage;
    const totalDays = Math.max(1, f.horizonDays);
    const lowDaily = f.discretionary.low / totalDays;
    const highDaily = f.discretionary.high / totalDays;
    let committed = balance;
    const byDate = new Map<ISODate, number>();
    for (const u of f.upcoming) byDate.set(u.date, round2((byDate.get(u.date) ?? 0) + (u.kind === "income" ? u.amount : -u.amount)));
    // anchor point joins the actual line to the projected lines
    if (balanceAsOf) {
      const anchor = path.find((p) => p.date === balanceAsOf);
      if (anchor) Object.assign(anchor, { committed: balance, likely: balance, likelyLow: balance, likelyHigh: balance });
      else path.push({ date: balanceAsOf, actual: balance, committed: balance, likely: balance, likelyLow: balance, likelyHigh: balance });
    }
    let n = 0;
    for (let d = start; d <= longest.to; d = addDays(d, 1)) {
      n++;
      committed = round2(committed + (byDate.get(d) ?? 0));
      path.push({
        date: d,
        committed,
        likely: round2(committed - daily * n),
        likelyLow: round2(committed - highDaily * n),
        likelyHigh: round2(committed - lowDaily * n),
      });
    }
  }

  const assumptions = [...f.assumptions.filter((a) => !a.startsWith("A safety buffer") && !a.startsWith("The safety buffer"))];
  if (staleDays > 3) assumptions.unshift(`Your latest statement ends ${staleDays} days ago, so the projection starts from that balance and includes what was probably paid since. Upload a newer statement for a firmer picture.`);
  if (balance === null) assumptions.push("Current balance is unknown (statements without a balance column), so projected balances cannot be shown.");
  return {
    today,
    balance,
    balanceAsOf,
    staleDays,
    horizons,
    path,
    confidence: staleDays > 14 && f.confidence === "Higher" ? "Medium" : f.confidence,
    assumptions,
    disclaimer: "Projections are estimates based on your past patterns and the obligations you entered. They are not guaranteed balances.",
  };
}

/* ------------------------------- safe to spend ------------------------------- */

export interface SafeComponent {
  key: "balance" | "recurring" | "budgets" | "buffer";
  label: string;
  /** Always a positive number; `sign` says whether it is added or subtracted. */
  amount: number;
  sign: 1 | -1;
  note: string;
}

export interface BudgetReserve {
  category: string;
  budget: number;
  spent: number;
  remaining: number;
  /** Recurring payments already counted above for this category (not reserved twice). */
  alreadyCounted: number;
  reserved: number;
}

export interface SafeToSpend {
  from: ISODate;
  to: ISODate;
  horizonDays: number;
  balance: number | null;
  balanceAsOf: ISODate | null;
  components: SafeComponent[];
  upcomingRecurring: number;
  budgetCommitments: number;
  budgetLines: BudgetReserve[];
  safetyBuffer: number;
  bufferSource: "user" | "auto";
  /** balance - recurring - budgets - buffer, before flooring at 0. null without a balance. */
  raw: number | null;
  /** The estimate shown to the user: never negative. */
  amount: number | null;
  /** How far short the balance falls of covering the commitments (0 when there is no shortfall). */
  shortfall: number;
  /** Income expected in the window; deliberately NOT counted (conservative). */
  expectedIncomeNotCounted: number;
  /** Context only (not part of the calculation): typical everyday spending in the window, and the resulting projection. */
  everydaySpending: { expected: number; low: number; high: number };
  estimatedRemaining: number | null;
  upcoming: UpcomingItem[];
  assumptions: string[];
  confidence: Forecast["confidence"];
  disclaimer: string;
}

/**
 * Safe-to-spend for the rest of the current financial month (at least the next 7 days).
 * Every component is returned so the UI can show exactly how the number was built.
 */
export function computeSafeToSpend(
  input: ProjectionInput & { budgets?: BudgetVariance[]; monthStartDay?: number },
): SafeToSpend {
  const { today, balance, balanceAsOf } = input;
  const includeDetected = input.includeDetectedRecurring ?? true;
  const reserve = input.reserveBudgets ?? true;
  const monthEnd = financialMonthRange(today, input.monthStartDay ?? 1).to;
  const minEnd = addDays(today, 7);
  const to = monthEnd > minEnd ? monthEnd : minEnd;
  const start = windowStart(today, balanceAsOf);
  const f = buildForecast({
    txns: input.txns,
    asOf: start,
    to: to < start ? start : to,
    manual: input.manual,
    series: seriesFor(input.series, includeDetected),
    dismissedKeys: input.dismissedKeys,
    currentBalance: balance,
    balanceAsOf,
    bufferOverride: input.safetyBuffer,
  });
  const expenses = f.upcoming.filter((u) => u.kind === "expense");
  const recurring = sum(expenses.map((u) => u.amount));

  const budgetLines: BudgetReserve[] = reserve
    ? (input.budgets ?? []).map((b) => {
        const counted = sum(expenses.filter((u) => u.category === b.category).map((u) => u.amount));
        const remaining = Math.max(0, round2(b.budget - b.actual));
        return { category: b.category, budget: b.budget, spent: b.actual, remaining, alreadyCounted: counted, reserved: Math.max(0, round2(remaining - counted)) };
      })
    : [];
  const budgetTotal = sum(budgetLines.map((l) => l.reserved));
  const buffer = f.buffer;
  const bufferSource: "user" | "auto" = input.safetyBuffer != null ? "user" : "auto";

  const components: SafeComponent[] = [];
  if (balance !== null) components.push({ key: "balance", label: "Current balance", amount: balance, sign: 1, note: balanceAsOf ? `as of your latest statement (${balanceAsOf})` : "from your statements" });
  components.push({
    key: "recurring",
    label: "Upcoming recurring payments",
    amount: recurring,
    sign: -1,
    note: `${expenses.length} expected up to ${to}${includeDetected ? "" : " (only obligations you entered)"}`,
  });
  components.push({
    key: "budgets",
    label: "Budget commitments",
    amount: budgetTotal,
    sign: -1,
    note: reserve ? (budgetLines.length ? `unspent part of ${budgetLines.length} budget${budgetLines.length > 1 ? "s" : ""}, not counting bills already listed above` : "no active budgets") : "not reserved (turned off in settings)",
  });
  components.push({
    key: "buffer",
    label: "Safety buffer",
    amount: buffer,
    sign: -1,
    note: bufferSource === "user" ? "the amount you set" : "10% of your typical monthly spending",
  });

  const raw = balance === null ? null : round2(balance - recurring - budgetTotal - buffer);
  const assumptions = [
    "Income that has not arrived yet is not counted, which keeps the estimate on the cautious side.",
    includeDetected ? "Recurring payments come from patterns in your history plus obligations you entered." : "Only recurring obligations you entered are counted (detected patterns are switched off).",
    reserve ? "The unspent part of each active budget is set aside." : "Budgets are not set aside.",
  ];
  const stale = balanceAsOf ? Math.max(0, daysBetween(balanceAsOf, today)) : 0;
  if (stale > 3) assumptions.unshift(`The balance is from ${stale} days ago; payments made since then are not reflected.`);
  if (balance === null) assumptions.push("Current balance is unknown, so safe to spend cannot be calculated.");
  return {
    from: start,
    to,
    horizonDays: Math.max(1, daysBetween(today, to) + 1),
    balance,
    balanceAsOf,
    components,
    upcomingRecurring: recurring,
    budgetCommitments: budgetTotal,
    budgetLines,
    safetyBuffer: buffer,
    bufferSource,
    raw,
    amount: raw === null ? null : Math.max(0, raw),
    shortfall: raw !== null && raw < 0 ? round2(-raw) : 0,
    expectedIncomeNotCounted: f.expectedIncome,
    everydaySpending: { expected: f.discretionary.expected, low: f.discretionary.low, high: f.discretionary.high },
    estimatedRemaining: f.expectedRemaining,
    upcoming: expenses,
    assumptions,
    confidence: stale > 14 && f.confidence === "Higher" ? "Medium" : f.confidence,
    disclaimer: SAFE_TO_SPEND_DISCLAIMER,
  };
}

