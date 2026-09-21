/**
 * Pure analytics functions over TxnLite[]. No I/O, no React - the API layer
 * loads rows from SQLite and the UI only renders these structured results.
 *
 * Definitions (documented in README):
 *  - income        = credits categorised SALARY/INCOME
 *  - refunds       = credits categorised REFUNDS (reduce net spending)
 *  - transfersIn/Out, investmentsOut = money movement, NOT income / spending
 *  - spending      = debits whose category is not TRANSFERS / INVESTMENTS
 *  - netCashFlow   = total credits - total debits (true change in balance)
 *  - savings       = income - (spending - refunds)
 */
import { INCOME_CATEGORY, NON_SPENDING_CATEGORIES, REFUND_CATEGORY } from "../domain/categories";
import type { TxnLite } from "../domain/types";
import {
  WEEKDAY_SHORT,
  bucketKey,
  bucketLabel,
  isoWeekday,
  parseISO,
  type Granularity,
  type ISODate,
} from "../util/dates";
import { mean, median, pct, quantile, round2, sum } from "../util/money";

export const isCredit = (t: TxnLite) => t.direction === "credit";
export const isDebit = (t: TxnLite) => t.direction === "debit";
export const isIncome = (t: TxnLite) => isCredit(t) && t.category === INCOME_CATEGORY;
export const isRefund = (t: TxnLite) => isCredit(t) && t.category === REFUND_CATEGORY;
export const isSpending = (t: TxnLite) => isDebit(t) && !NON_SPENDING_CATEGORIES.has(t.category);

export interface TxnRef {
  id: string;
  date: ISODate;
  amount: number;
  merchant: string;
  category: string;
  description?: string;
}

export interface Summary {
  totalCredits: number;
  totalDebits: number;
  netCashFlow: number;
  income: number;
  spending: number;
  refunds: number;
  netSpending: number;
  transfersIn: number;
  transfersOut: number;
  investmentsOut: number;
  otherCredits: number;
  savings: number;
  /** % of income kept; null when there is no income in the range. */
  savingsRate: number | null;
  creditCount: number;
  debitCount: number;
  incomeCount: number;
  avgCredit: number;
  avgDebit: number;
  largestCredit: TxnRef | null;
  largestDebit: TxnRef | null;
  topCategory: { category: string; amount: number; pct: number } | null;
  transactionCount: number;
  from: ISODate | null;
  to: ISODate | null;
}

const ref = (t: TxnLite): TxnRef => ({
  id: t.id,
  date: t.date,
  amount: t.amount,
  merchant: t.merchant,
  category: t.category,
  description: t.description,
});

export function calculateIncome(txns: TxnLite[]): number {
  return sum(txns.filter(isIncome).map((t) => t.credit));
}
export function calculateExpenses(txns: TxnLite[]): number {
  return sum(txns.filter(isSpending).map((t) => t.debit));
}
export function calculateNetCashFlow(txns: TxnLite[]): number {
  return round2(sum(txns.map((t) => t.credit)) - sum(txns.map((t) => t.debit)));
}
export function calculateSavingsRate(income: number, netSpending: number): number | null {
  if (income <= 0) return null;
  return Math.round(((income - netSpending) / income) * 1000) / 10;
}

export function calculateSummary(txns: TxnLite[]): Summary {
  const credits = txns.filter(isCredit);
  const debits = txns.filter(isDebit);
  const income = calculateIncome(txns);
  const spending = calculateExpenses(txns);
  const refunds = sum(txns.filter(isRefund).map((t) => t.credit));
  const transfersIn = sum(credits.filter((t) => t.category === "TRANSFERS").map((t) => t.credit));
  const transfersOut = sum(debits.filter((t) => t.category === "TRANSFERS").map((t) => t.debit));
  const investmentsOut = sum(debits.filter((t) => t.category === "INVESTMENTS").map((t) => t.debit));
  const totalCredits = sum(credits.map((t) => t.credit));
  const totalDebits = sum(debits.map((t) => t.debit));
  const netSpending = round2(spending - refunds);
  const cats = calculateCategorySpend(txns);
  const largestCredit = credits.reduce<TxnLite | null>((a, t) => (!a || t.credit > a.credit ? t : a), null);
  const largestDebit = debits.reduce<TxnLite | null>((a, t) => (!a || t.debit > a.debit ? t : a), null);
  const dates = txns.map((t) => t.date).sort();
  return {
    totalCredits,
    totalDebits,
    netCashFlow: round2(totalCredits - totalDebits),
    income,
    spending,
    refunds,
    netSpending,
    transfersIn,
    transfersOut,
    investmentsOut,
    otherCredits: round2(totalCredits - income - refunds - transfersIn),
    savings: round2(income - netSpending),
    savingsRate: calculateSavingsRate(income, netSpending),
    creditCount: credits.length,
    debitCount: debits.length,
    incomeCount: txns.filter(isIncome).length,
    avgCredit: credits.length ? round2(totalCredits / credits.length) : 0,
    avgDebit: debits.length ? round2(totalDebits / debits.length) : 0,
    largestCredit: largestCredit ? ref(largestCredit) : null,
    largestDebit: largestDebit ? ref(largestDebit) : null,
    topCategory: cats[0] ? { category: cats[0].category, amount: cats[0].amount, pct: cats[0].pct } : null,
    transactionCount: txns.length,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}

/* ------------------------------- time series ------------------------------- */

export interface PeriodPoint {
  key: string;
  label: string;
  /** First date with data in the bucket (for sorting / drill-down). */
  start: ISODate;
  income: number;
  spending: number;
  refunds: number;
  credits: number;
  debits: number;
  netCashFlow: number;
  savings: number;
  savingsRate: number | null;
  transfersIn: number;
  transfersOut: number;
  count: number;
}

function aggregatePeriods(txns: TxnLite[], g: Granularity, monthStartDay = 1): PeriodPoint[] {
  const map = new Map<string, TxnLite[]>();
  for (const t of txns) {
    const k = bucketKey(t.date, g, monthStartDay);
    const arr = map.get(k);
    if (arr) arr.push(t);
    else map.set(k, [t]);
  }
  const out: PeriodPoint[] = [];
  for (const [key, rows] of map) {
    const income = calculateIncome(rows);
    const spending = calculateExpenses(rows);
    const refunds = sum(rows.filter(isRefund).map((t) => t.credit));
    const credits = sum(rows.map((t) => t.credit));
    const debits = sum(rows.map((t) => t.debit));
    const netSpending = round2(spending - refunds);
    out.push({
      key,
      label: bucketLabel(key, g),
      start: rows.reduce((a, t) => (t.date < a ? t.date : a), rows[0].date),
      income,
      spending,
      refunds,
      credits,
      debits,
      netCashFlow: round2(credits - debits),
      savings: round2(income - netSpending),
      savingsRate: calculateSavingsRate(income, netSpending),
      transfersIn: sum(rows.filter((t) => isCredit(t) && t.category === "TRANSFERS").map((t) => t.credit)),
      transfersOut: sum(rows.filter((t) => isDebit(t) && t.category === "TRANSFERS").map((t) => t.debit)),
      count: rows.length,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

export const calculateDailySpend = (txns: TxnLite[]) => aggregatePeriods(txns, "daily");
export const calculateWeeklySpend = (txns: TxnLite[]) => aggregatePeriods(txns, "weekly");
export const calculateMonthlySpend = (txns: TxnLite[], monthStartDay = 1) => aggregatePeriods(txns, "monthly", monthStartDay);
export const calculateQuarterlySpend = (txns: TxnLite[], monthStartDay = 1) => aggregatePeriods(txns, "quarterly", monthStartDay);
export const calculateYearlySpend = (txns: TxnLite[]) => aggregatePeriods(txns, "yearly");

export function calculatePeriods(txns: TxnLite[], g: Granularity, monthStartDay = 1): PeriodPoint[] {
  return aggregatePeriods(txns, g, monthStartDay);
}

/** Running cash-flow (cumulative net) by day: the "cash-flow timeline". */
export function calculateCashFlow(txns: TxnLite[]): { date: ISODate; net: number; cumulative: number; balance?: number }[] {
  const byDay = new Map<ISODate, { net: number; balance?: number }>();
  const sorted = [...txns].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  for (const t of sorted) {
    const d = byDay.get(t.date) ?? { net: 0 };
    d.net = round2(d.net + t.credit - t.debit);
    if (t.balanceAfter != null) d.balance = t.balanceAfter;
    byDay.set(t.date, d);
  }
  let cum = 0;
  return [...byDay.entries()].map(([date, v]) => {
    cum = round2(cum + v.net);
    return { date, net: v.net, cumulative: cum, balance: v.balance };
  });
}

/* --------------------------- category & merchant --------------------------- */

export interface CategorySpend {
  category: string;
  amount: number;
  count: number;
  pct: number;
  subcategories: { name: string; amount: number; count: number }[];
}

/**
 * Amount of each debit that was later refunded, keyed by the debit id. Only refunds present in `txns`
 * count, so a range that excludes the original purchase never subtracts an orphan refund.
 */
export function refundOffsets(txns: TxnLite[]): Map<string, number> {
  const ids = new Set<string>();
  for (const t of txns) if (isDebit(t)) ids.add(t.id);
  const out = new Map<string, number>();
  for (const t of txns) {
    if (isCredit(t) && t.refundFor && ids.has(t.refundFor)) out.set(t.refundFor, round2((out.get(t.refundFor) ?? 0) + t.credit));
  }
  return out;
}

/** Debit rows with linked refunds netted off; fully refunded purchases drop out (net spend 0). */
export function netDebits(rows: TxnLite[], offsets: Map<string, number>): (TxnLite & { net: number })[] {
  const out: (TxnLite & { net: number })[] = [];
  for (const t of rows) {
    const net = round2(Math.max(0, t.debit - (offsets.get(t.id) ?? 0)));
    if (net > 0) out.push({ ...t, net });
  }
  return out;
}

/**
 * Spending by category. Refund credits that are linked to an original purchase in the same set are
 * netted against that purchase (Blinkit ₹266 debit + ₹266 refund = ₹0), so category totals reflect
 * what was actually kept.
 */
export function calculateCategorySpend(txns: TxnLite[], opts: { includeNonSpending?: boolean } = {}): CategorySpend[] {
  const rows = netDebits(
    txns.filter((t) => isDebit(t) && (opts.includeNonSpending || !NON_SPENDING_CATEGORIES.has(t.category))),
    refundOffsets(txns),
  );
  const total = sum(rows.map((t) => t.net));
  const map = new Map<string, { amount: number; count: number; subs: Map<string, { amount: number; count: number }> }>();
  for (const t of rows) {
    const c = map.get(t.category) ?? { amount: 0, count: 0, subs: new Map() };
    c.amount += t.net;
    c.count++;
    const s = c.subs.get(t.subcategory) ?? { amount: 0, count: 0 };
    s.amount += t.net;
    s.count++;
    c.subs.set(t.subcategory, s);
    map.set(t.category, c);
  }
  return [...map.entries()]
    .map(([category, v]) => ({
      category,
      amount: round2(v.amount),
      count: v.count,
      pct: pct(v.amount, total),
      subcategories: [...v.subs.entries()]
        .map(([name, s]) => ({ name, amount: round2(s.amount), count: s.count }))
        .sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.amount - a.amount);
}

export interface MerchantSpend {
  merchant: string;
  category: string;
  amount: number;
  count: number;
  average: number;
  lastDate: ISODate;
}

export function calculateMerchantSpend(txns: TxnLite[], opts: { includeTransfers?: boolean; limit?: number } = {}): MerchantSpend[] {
  const rows = netDebits(
    txns.filter((t) => isDebit(t) && (opts.includeTransfers ? true : !NON_SPENDING_CATEGORIES.has(t.category))),
    refundOffsets(txns),
  );
  const map = new Map<string, { amount: number; count: number; last: ISODate; cats: Map<string, number> }>();
  for (const t of rows) {
    const m = map.get(t.merchant) ?? { amount: 0, count: 0, last: t.date, cats: new Map() };
    m.amount += t.net;
    m.count++;
    if (t.date > m.last) m.last = t.date;
    m.cats.set(t.category, (m.cats.get(t.category) ?? 0) + t.net);
    map.set(t.merchant, m);
  }
  const out = [...map.entries()].map(([merchant, v]) => ({
    merchant,
    category: [...v.cats.entries()].sort((a, b) => b[1] - a[1])[0][0],
    amount: round2(v.amount),
    count: v.count,
    average: round2(v.amount / v.count),
    lastDate: v.last,
  }));
  out.sort((a, b) => b.amount - a.amount);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Monthly (or other granularity) spending by category for the top-N categories; rest folded into "Other categories". */
export function calculateCategoryTrend(
  txns: TxnLite[],
  g: Granularity = "monthly",
  topN = 6,
  monthStartDay = 1,
): { keys: string[]; rows: Record<string, number | string>[] } {
  const spend = txns.filter(isSpending);
  const totals = calculateCategorySpend(spend);
  const keys = totals.slice(0, topN).map((c) => c.category);
  const hasRest = totals.length > topN;
  const rowMap = new Map<string, Record<string, number | string>>();
  for (const t of spend) {
    const k = bucketKey(t.date, g, monthStartDay);
    const row = rowMap.get(k) ?? { key: k, label: bucketLabel(k, g) };
    const col = keys.includes(t.category) ? t.category : "OTHER CATEGORIES";
    row[col] = round2(((row[col] as number) ?? 0) + t.debit);
    rowMap.set(k, row);
  }
  const rows = [...rowMap.values()].sort((a, b) => ((a.key as string) < (b.key as string) ? -1 : 1));
  for (const r of rows) for (const k of [...keys, ...(hasRest ? ["OTHER CATEGORIES"] : [])]) r[k] = (r[k] as number) ?? 0;
  return { keys: hasRest ? [...keys, "OTHER CATEGORIES"] : keys, rows };
}

/** Income broken down by source (subcategory/merchant) - answers "where does my money come from". */
export function calculateIncomeSources(txns: TxnLite[]): { source: string; kind: string; amount: number; count: number; pct: number }[] {
  const credits = txns.filter(isCredit);
  const total = sum(credits.map((t) => t.credit));
  const map = new Map<string, { kind: string; amount: number; count: number }>();
  for (const t of credits) {
    let kind: string;
    if (t.category === INCOME_CATEGORY) kind = t.subcategory;
    else if (t.category === REFUND_CATEGORY) kind = "Refunds & cashback";
    else if (t.category === "TRANSFERS") kind = t.subcategory === "Family" ? "Family transfers" : "Transfers from people";
    else if (t.category === "INVESTMENTS") kind = "Investment proceeds";
    else kind = "Other credits";
    const m = map.get(kind) ?? { kind, amount: 0, count: 0 };
    m.amount += t.credit;
    m.count++;
    map.set(kind, m);
  }
  return [...map.entries()]
    .map(([source, v]) => ({ source, kind: v.kind, amount: round2(v.amount), count: v.count, pct: pct(v.amount, total) }))
    .sort((a, b) => b.amount - a.amount);
}

/* ---------------------------------- patterns ---------------------------------- */

export interface PatternData {
  weekday: { weekday: number; label: string; amount: number; count: number; average: number }[];
  weekdayByMonth: { months: string[]; monthLabels: string[]; cells: { weekday: number; month: string; amount: number }[]; max: number };
  calendar: { date: ISODate; amount: number; count: number }[];
  distribution: { label: string; min: number; max: number | null; count: number; amount: number }[];
  frequency: { key: string; label: string; count: number; debits: number; credits: number }[];
}

const DIST_BUCKETS: [number, number | null, string][] = [
  [0, 100, "< ₹100"],
  [100, 500, "₹100–500"],
  [500, 1000, "₹500–1k"],
  [1000, 2500, "₹1k–2.5k"],
  [2500, 5000, "₹2.5k–5k"],
  [5000, 10000, "₹5k–10k"],
  [10000, 25000, "₹10k–25k"],
  [25000, null, "₹25k+"],
];

export function calculatePatterns(txns: TxnLite[], monthStartDay = 1): PatternData {
  const spend = txns.filter(isSpending);
  const wk = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, label: WEEKDAY_SHORT[i], amount: 0, count: 0, average: 0 }));
  const cal = new Map<ISODate, { amount: number; count: number }>();
  const wm = new Map<string, number>();
  const months = new Set<string>();
  for (const t of spend) {
    const w = isoWeekday(t.date) - 1;
    wk[w].amount += t.debit;
    wk[w].count++;
    const c = cal.get(t.date) ?? { amount: 0, count: 0 };
    c.amount += t.debit;
    c.count++;
    cal.set(t.date, c);
    const mk = bucketKey(t.date, "monthly", monthStartDay);
    months.add(mk);
    const k = `${w + 1}|${mk}`;
    wm.set(k, (wm.get(k) ?? 0) + t.debit);
  }
  wk.forEach((w) => {
    w.amount = round2(w.amount);
    w.average = w.count ? round2(w.amount / w.count) : 0;
  });
  const monthList = [...months].sort();
  const cells = [...wm.entries()].map(([k, amount]) => {
    const [weekday, month] = k.split("|");
    return { weekday: Number(weekday), month, amount: round2(amount) };
  });
  const distribution = DIST_BUCKETS.map(([min, max, label]) => {
    const rows = spend.filter((t) => t.debit >= min && (max === null || t.debit < max));
    return { label, min, max, count: rows.length, amount: sum(rows.map((t) => t.debit)) };
  });
  const freq = new Map<string, { count: number; debits: number; credits: number }>();
  for (const t of txns) {
    const k = bucketKey(t.date, "monthly", monthStartDay);
    const f = freq.get(k) ?? { count: 0, debits: 0, credits: 0 };
    f.count++;
    if (isDebit(t)) f.debits++;
    else f.credits++;
    freq.set(k, f);
  }
  return {
    weekday: wk,
    weekdayByMonth: {
      months: monthList,
      monthLabels: monthList.map((m) => bucketLabel(m, "monthly")),
      cells,
      max: Math.max(0, ...cells.map((c) => c.amount)),
    },
    calendar: [...cal.entries()].map(([date, v]) => ({ date, amount: round2(v.amount), count: v.count })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    distribution,
    frequency: [...freq.entries()]
      .map(([key, v]) => ({ key, label: bucketLabel(key, "monthly"), ...v }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}

/* ----------------------------------- anomalies ----------------------------------- */

export interface Anomaly {
  txn: TxnRef;
  score: number;
  baseline: number;
  reason: string;
}

/**
 * Robust outlier detection on spending debits. Per category we use the median and
 * MAD (modified z-score > 3.5) so a single huge purchase doesn't hide itself by
 * inflating the mean/stddev. Sparse categories fall back to a global IQR fence.
 */
export function detectAnomalies(txns: TxnLite[], opts: { minAmount?: number; limit?: number } = {}): Anomaly[] {
  const minAmount = opts.minAmount ?? 1500;
  const spend = txns.filter(isSpending);
  if (spend.length < 8) return [];
  const byCat = new Map<string, TxnLite[]>();
  for (const t of spend) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t]);
  const all = spend.map((t) => t.debit);
  const q1 = quantile(all, 0.25);
  const q3 = quantile(all, 0.75);
  const globalFence = q3 + 3 * (q3 - q1);
  const out: Anomaly[] = [];
  for (const [cat, rows] of byCat) {
    const amounts = rows.map((t) => t.debit);
    const med = median(amounts);
    const mad = median(amounts.map((a) => Math.abs(a - med)));
    for (const t of rows) {
      if (t.debit < minAmount) continue;
      if (rows.length >= 6 && mad > 0) {
        const z = (0.6745 * (t.debit - med)) / mad;
        if (z > 3.5 && t.debit >= 2 * med) {
          out.push({ txn: ref(t), score: round2(z), baseline: round2(med), reason: `${round2(t.debit / med)}× your typical ${cat.toLowerCase()} transaction (${Math.round(med)})` });
        }
      } else if (rows.length >= 6 && mad === 0 && t.debit >= 3 * med && med > 0) {
        out.push({ txn: ref(t), score: round2(t.debit / med), baseline: round2(med), reason: `${round2(t.debit / med)}× your typical ${cat.toLowerCase()} transaction` });
      } else if (t.debit > globalFence) {
        out.push({ txn: ref(t), score: round2(t.debit / Math.max(1, q3)), baseline: round2(median(all)), reason: `Unusually large compared with your usual spending (${Math.round(median(all))} typical)` });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/* ------------------------------------ helpers ------------------------------------ */

/** Average monthly value of a numeric selector across complete-or-partial months present in the data. */
export function monthlyAverage(points: PeriodPoint[], pick: (p: PeriodPoint) => number): number {
  return points.length ? round2(mean(points.map(pick))) : 0;
}

export function filterRange(txns: TxnLite[], from?: ISODate | null, to?: ISODate | null): TxnLite[] {
  return txns.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
}

export function daysSpan(txns: TxnLite[]): number {
  if (!txns.length) return 0;
  const dates = txns.map((t) => t.date).sort();
  return Math.round((parseISO(dates[dates.length - 1]).getTime() - parseISO(dates[0]).getTime()) / 86_400_000) + 1;
}
