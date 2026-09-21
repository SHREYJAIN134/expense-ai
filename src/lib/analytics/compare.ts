/**
 * Spending intelligence: comparable periods, refund-netted totals, category / merchant / payment-method
 * analysis and change detection. Pure functions over TxnLite[] - no I/O, no randomness, no LLM.
 *
 * Definitions (same as the rest of the engine, made explicit here):
 *  - spending      = debits not in TRANSFERS / INVESTMENTS (transfers are money movement, not consumption)
 *  - credits       = never spending. Income = SALARY/INCOME credits; everything else is just "money in".
 *  - refunds       = REFUNDS credits. A refund linked to its original purchase (refundFor) is netted against
 *                    THAT PURCHASE, wherever the refund landed in time, so a Blinkit debit + refund nets to 0 in
 *                    the purchase's period and category. Refunds with no linked purchase are subtracted from
 *                    the period in which they arrived ("unlinked refunds").
 *  - previous period = the equivalent period before the current one. When the current period is still in
 *                    progress the previous period is cut to the same number of elapsed days (like-for-like).
 */
import { INCOME_CATEGORY } from "../domain/categories";
import type { TxnLite } from "../domain/types";
import {
  addDays,
  addMonths,
  bucketKey,
  bucketLabel,
  daysBetween,
  endOfMonth,
  financialMonthRange,
  formatDateLong,
  weekStart,
  type Granularity,
  type ISODate,
} from "../util/dates";
import { pct, round2, sum } from "../util/money";
import { isDebit, isRefund, isSpending, netDebits, refundOffsets } from "./engine";

/* ------------------------------ comparable periods ------------------------------ */

export type PeriodUnit = "day" | "week" | "month" | "quarter" | "year";

export interface PeriodRange {
  from: ISODate;
  to: ISODate;
  label: string;
}

export interface ComparablePeriods {
  unit: PeriodUnit;
  current: PeriodRange;
  previous: PeriodRange;
  /** True while the current period has not finished; `previous` is then cut to the same elapsed days. */
  partial: boolean;
  elapsedDays: number;
  totalDays: number;
}

const UNIT_LABELS: Record<PeriodUnit, [string, string]> = {
  day: ["Today", "Yesterday"],
  week: ["This week", "Last week"],
  month: ["This month", "Last month"],
  quarter: ["This quarter", "Last quarter"],
  year: ["This year", "Last year"],
};

export function comparablePeriods(asOf: ISODate, unit: PeriodUnit, monthStartDay = 1): ComparablePeriods {
  let curFrom: ISODate;
  let curEnd: ISODate;
  let prevFrom: ISODate;
  let prevEnd: ISODate;
  switch (unit) {
    case "day":
      curFrom = curEnd = asOf;
      prevFrom = prevEnd = addDays(asOf, -1);
      break;
    case "week":
      curFrom = weekStart(asOf);
      curEnd = addDays(curFrom, 6);
      prevFrom = addDays(curFrom, -7);
      prevEnd = addDays(curFrom, -1);
      break;
    case "month": {
      const r = financialMonthRange(asOf, monthStartDay);
      curFrom = r.from;
      curEnd = r.to;
      const p = financialMonthRange(addDays(r.from, -1), monthStartDay);
      prevFrom = p.from;
      prevEnd = p.to;
      break;
    }
    case "quarter": {
      const q = Math.floor((Number(asOf.slice(5, 7)) - 1) / 3);
      curFrom = `${asOf.slice(0, 4)}-${String(q * 3 + 1).padStart(2, "0")}-01`;
      curEnd = endOfMonth(addMonths(curFrom, 2));
      prevFrom = addMonths(curFrom, -3);
      prevEnd = endOfMonth(addMonths(prevFrom, 2));
      break;
    }
    case "year":
      curFrom = `${asOf.slice(0, 4)}-01-01`;
      curEnd = `${asOf.slice(0, 4)}-12-31`;
      prevFrom = `${Number(asOf.slice(0, 4)) - 1}-01-01`;
      prevEnd = `${Number(asOf.slice(0, 4)) - 1}-12-31`;
      break;
  }
  const totalDays = daysBetween(curFrom, curEnd) + 1;
  const partial = asOf < curEnd;
  const elapsedDays = partial ? daysBetween(curFrom, asOf) + 1 : totalDays;
  const curTo = partial ? asOf : curEnd;
  // Like-for-like: same number of elapsed days in the previous period.
  const prevTo = partial ? minDate(prevEnd, addDays(prevFrom, elapsedDays - 1)) : prevEnd;
  const [nowLabel, prevLabel] = UNIT_LABELS[unit];
  return {
    unit,
    current: { from: curFrom, to: curTo, label: nowLabel },
    previous: { from: prevFrom, to: prevTo, label: prevLabel },
    partial,
    elapsedDays,
    totalDays,
  };
}

/** Previous period of a custom range: same length, immediately before. */
export function previousOfRange(from: ISODate, to: ISODate): { from: ISODate; to: ISODate } {
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/**
 * Comparable periods for a range that came from natural language ("last month", "in August", "last 30 days").
 * Whole financial months / calendar quarters / years / ISO weeks are compared with the previous one of the same
 * kind; anything else with the immediately preceding range of the same length. Future days are never included.
 */
export function periodsFromRange(range: { from: ISODate; to: ISODate; label: string }, today: ISODate, monthStartDay = 1): ComparablePeriods {
  const to = range.to > today ? today : range.to;
  const isWholeMonth = (() => {
    const r = financialMonthRange(range.from, monthStartDay);
    return r.from === range.from && r.to === range.to;
  })();
  const candidates: PeriodUnit[] = isWholeMonth ? ["month"] : [];
  if (range.from === weekStart(range.from) && daysBetween(range.from, range.to) === 6) candidates.push("week");
  if (/-(01|04|07|10)-01$/.test(range.from) && daysBetween(range.from, range.to) >= 88 && daysBetween(range.from, range.to) <= 92) candidates.push("quarter");
  if (range.from.endsWith("-01-01") && (range.to.endsWith("-12-31") || range.to === today)) candidates.push("year");
  const unit = candidates[0];
  if (unit) {
    const p = comparablePeriods(to, unit, monthStartDay);
    if (p.current.from === range.from) return { ...p, current: { ...p.current, label: range.label }, previous: { ...p.previous } };
  }
  const prev = previousOfRange(range.from, to);
  const len = daysBetween(range.from, to) + 1;
  return {
    unit: "day",
    current: { from: range.from, to, label: range.label },
    previous: { ...prev, label: "the previous period" },
    partial: range.to > today,
    elapsedDays: len,
    totalDays: daysBetween(range.from, range.to) + 1,
  };
}

function minDate(a: ISODate, b: ISODate) {
  return a < b ? a : b;
}

export const inRange = (txns: TxnLite[], from: ISODate, to: ISODate) => txns.filter((t) => t.date >= from && t.date <= to);

/* ------------------------------------ totals ------------------------------------ */

export interface SpendTotals {
  /** Spending debits before refunds. */
  gross: number;
  /** Refunds netted against purchases (linked) - already removed from `net`. */
  refunded: number;
  /** Refund credits with no linked purchase, subtracted in the period they arrived. */
  unlinkedRefunds: number;
  /** What was actually spent: gross - refunded - unlinked refunds (never below 0). */
  net: number;
  income: number;
  /** All credits (income, refunds, transfers in, other). Credits are never spending. */
  credits: number;
  debits: number;
  /** credits - debits (true change in balance, includes transfers and investments). */
  netCashFlow: number;
  transfersOut: number;
  investmentsOut: number;
  transactionCount: number;
  spendingCount: number;
}

/**
 * Totals for a slice of transactions. `all` is the full history, used to find each purchase's refunds even when the
 * refund arrived in a different period than the purchase.
 */
export function spendTotals(period: TxnLite[], all: TxnLite[] = period): SpendTotals {
  const offsets = refundOffsets(all);
  const spendRows = period.filter(isSpending);
  const rows = netDebits(spendRows, offsets);
  const gross = sum(spendRows.map((t) => t.debit));
  const netRows = sum(rows.map((t) => t.net));
  const debitIds = new Set(all.filter(isDebit).map((t) => t.id));
  const unlinkedRefunds = sum(period.filter((t) => isRefund(t) && !(t.refundFor && debitIds.has(t.refundFor))).map((t) => t.credit));
  const credits = sum(period.map((t) => t.credit));
  const debits = sum(period.map((t) => t.debit));
  return {
    gross,
    refunded: round2(gross - netRows),
    unlinkedRefunds,
    net: Math.max(0, round2(netRows - unlinkedRefunds)),
    income: sum(period.filter((t) => t.direction === "credit" && t.category === INCOME_CATEGORY).map((t) => t.credit)),
    credits,
    debits,
    netCashFlow: round2(credits - debits),
    transfersOut: sum(period.filter((t) => isDebit(t) && t.category === "TRANSFERS").map((t) => t.debit)),
    investmentsOut: sum(period.filter((t) => isDebit(t) && t.category === "INVESTMENTS").map((t) => t.debit)),
    transactionCount: period.length,
    spendingCount: rows.length,
  };
}

/* ------------------------------ category & merchant ------------------------------ */

export interface LargestRef {
  id: string;
  date: ISODate;
  amount: number;
  merchant: string;
}

export interface GroupStat {
  key: string;
  category: string;
  amount: number;
  count: number;
  average: number;
  largest: LargestRef | null;
  first: ISODate;
  last: ISODate;
}

/** Net (refund-netted) spending rows of a period: the single source for every category / merchant figure. */
export function netSpendingRows(period: TxnLite[], all: TxnLite[] = period) {
  return netDebits(period.filter(isSpending), refundOffsets(all));
}

function groupBy(rows: (TxnLite & { net: number })[], by: "category" | "merchant"): GroupStat[] {
  const map = new Map<string, { rows: (TxnLite & { net: number })[] }>();
  for (const r of rows) {
    const k = by === "category" ? r.category : r.merchant;
    const g = map.get(k);
    if (g) g.rows.push(r);
    else map.set(k, { rows: [r] });
  }
  const out: GroupStat[] = [];
  for (const [key, { rows: rs }] of map) {
    const amount = sum(rs.map((r) => r.net));
    const largest = rs.reduce((a, r) => (r.net > a.net ? r : a), rs[0]);
    const cats = new Map<string, number>();
    for (const r of rs) cats.set(r.category, (cats.get(r.category) ?? 0) + r.net);
    out.push({
      key,
      category: by === "category" ? key : [...cats.entries()].sort((a, b) => b[1] - a[1])[0][0],
      amount,
      count: rs.length,
      average: round2(amount / rs.length),
      largest: { id: largest.id, date: largest.date, amount: largest.net, merchant: largest.merchant },
      first: rs.reduce((a, r) => (r.date < a ? r.date : a), rs[0].date),
      last: rs.reduce((a, r) => (r.date > a ? r.date : a), rs[0].date),
    });
  }
  return out.sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1));
}

export const categoryStats = (period: TxnLite[], all: TxnLite[] = period) => groupBy(netSpendingRows(period, all), "category");
export const merchantStats = (period: TxnLite[], all: TxnLite[] = period) => groupBy(netSpendingRows(period, all), "merchant");

/* ------------------------------- change detection ------------------------------- */

export interface ChangeThresholds {
  /** Minimum % change (of the previous amount) to call something a change. */
  minPct: number;
  /** Minimum change in rupees. */
  minAmount: number;
  /** Minimum transactions in the busier of the two periods (small-sample guard). */
  minTxns: number;
}

export const DEFAULT_THRESHOLDS: ChangeThresholds = { minPct: 25, minAmount: 500, minTxns: 3 };

export type ChangeKind = "increase" | "decrease" | "new" | "stopped" | "flat";

export interface GroupChange {
  key: string;
  category: string;
  current: number;
  previous: number;
  delta: number;
  /** null when there is nothing to compare against (previous = 0). */
  pctChange: number | null;
  currentCount: number;
  previousCount: number;
  kind: ChangeKind;
  /** Passed every threshold (percentage, rupees and sample size). */
  significant: boolean;
  /** Too few transactions to draw a conclusion. */
  lowSample: boolean;
}

/**
 * Compare two sets of groups. A change is only `significant` when it clears the percentage threshold, the rupee
 * threshold AND the sample-size guard, so a ₹40 move or a one-off purchase never raises an alert.
 */
export function compareGroups(current: GroupStat[], previous: GroupStat[], th: ChangeThresholds = DEFAULT_THRESHOLDS): GroupChange[] {
  const prev = new Map(previous.map((g) => [g.key, g]));
  const cur = new Map(current.map((g) => [g.key, g]));
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  const out: GroupChange[] = [];
  for (const key of keys) {
    const c = cur.get(key);
    const p = prev.get(key);
    const now = c?.amount ?? 0;
    const before = p?.amount ?? 0;
    const delta = round2(now - before);
    const pctChange = before > 0 ? Math.round((delta / before) * 1000) / 10 : null;
    const cc = c?.count ?? 0;
    const pc = p?.count ?? 0;
    const lowSample = Math.max(cc, pc) < th.minTxns;
    let kind: ChangeKind = delta > 0 ? "increase" : delta < 0 ? "decrease" : "flat";
    if (before === 0 && now > 0) kind = "new";
    if (now === 0 && before > 0) kind = "stopped";
    const bigEnough = Math.abs(delta) >= th.minAmount;
    const pctOk = pctChange === null ? true : Math.abs(pctChange) >= th.minPct;
    out.push({
      key,
      category: (c ?? p)!.category,
      current: now,
      previous: before,
      delta,
      pctChange,
      currentCount: cc,
      previousCount: pc,
      kind,
      significant: kind !== "flat" && bigEnough && pctOk && !lowSample,
      lowSample,
    });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : 1));
}

/* ------------------------------ payment behaviour ------------------------------ */

export interface PaymentMethodStat {
  method: string;
  amount: number;
  count: number;
  share: number;
  average: number;
}

/** Spending by how it was paid (UPI, AUTOPAY, Debit Card, NEFT...). Refund-netted, excludes transfers & investments. */
export function paymentMethodStats(period: TxnLite[], all: TxnLite[] = period): PaymentMethodStat[] {
  const rows = netSpendingRows(period, all);
  const total = sum(rows.map((r) => r.net));
  const map = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    const k = r.paymentMethod || "Other";
    const m = map.get(k) ?? { amount: 0, count: 0 };
    m.amount += r.net;
    m.count++;
    map.set(k, m);
  }
  return [...map.entries()]
    .map(([method, v]) => ({ method, amount: round2(v.amount), count: v.count, share: pct(v.amount, total), average: round2(v.amount / v.count) }))
    .sort((a, b) => b.amount - a.amount);
}

/* ------------------------------------ series ------------------------------------ */

export interface SpendPoint {
  key: string;
  label: string;
  start: ISODate;
  spending: number;
  income: number;
  netCashFlow: number;
  count: number;
}

/**
 * Refund-netted spending per day / week / month / quarter / year. Refunds are netted against the purchase's
 * bucket, so the series always agrees with the category and merchant figures.
 */
export function spendingSeries(txns: TxnLite[], g: Granularity, monthStartDay = 1): SpendPoint[] {
  const offsets = refundOffsets(txns);
  const debitIds = new Set(txns.filter(isDebit).map((t) => t.id));
  const buckets = new Map<string, TxnLite[]>();
  for (const t of txns) {
    const k = bucketKey(t.date, g, monthStartDay);
    const arr = buckets.get(k);
    if (arr) arr.push(t);
    else buckets.set(k, [t]);
  }
  const out: SpendPoint[] = [];
  for (const [key, rows] of buckets) {
    const netRows = netDebits(rows.filter(isSpending), offsets);
    const unlinked = sum(rows.filter((t) => isRefund(t) && !(t.refundFor && debitIds.has(t.refundFor))).map((t) => t.credit));
    const credits = sum(rows.map((t) => t.credit));
    out.push({
      key,
      label: bucketLabel(key, g),
      start: rows.reduce((a, t) => (t.date < a ? t.date : a), rows[0].date),
      spending: Math.max(0, round2(sum(netRows.map((r) => r.net)) - unlinked)),
      income: sum(rows.filter((t) => t.direction === "credit" && t.category === INCOME_CATEGORY).map((t) => t.credit)),
      netCashFlow: round2(credits - sum(rows.map((t) => t.debit))),
      count: rows.length,
    });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/* ---------------------------- full period analysis ---------------------------- */

export interface CategoryRow extends GroupStat {
  pctOfSpending: number;
  previousAmount: number;
  previousCount: number;
  change: GroupChange;
}

export interface MerchantRow extends GroupStat {
  previousAmount: number;
  previousCount: number;
  change: GroupChange;
  /** Spending at this merchant in each of the last 6 months (oldest first): "change over time". */
  monthly: { key: string; label: string; amount: number }[];
}

export interface SpendingIntelligence {
  periods: ComparablePeriods;
  totals: { current: SpendTotals; previous: SpendTotals; change: { amount: number; pct: number | null } };
  categories: CategoryRow[];
  merchants: MerchantRow[];
  paymentMethods: PaymentMethodStat[];
  /** Significant category / merchant changes only, biggest first. */
  changes: { categories: GroupChange[]; merchants: GroupChange[] };
  thresholds: ChangeThresholds;
  /** Plain-language limits on how far the numbers can be trusted (short history, partial period...). */
  caveats: string[];
}

export function analyzeSpending(
  all: TxnLite[],
  opts: { asOf: ISODate; unit: PeriodUnit; monthStartDay?: number; thresholds?: ChangeThresholds; merchantLimit?: number },
): SpendingIntelligence {
  return analyzeRanges(all, comparablePeriods(opts.asOf, opts.unit, opts.monthStartDay ?? 1), opts);
}

/** Same analysis for any pair of periods (used by the assistant for "last month", "in August", custom ranges...). */
export function analyzeRanges(
  all: TxnLite[],
  periods: ComparablePeriods,
  opts: { monthStartDay?: number; thresholds?: ChangeThresholds; merchantLimit?: number } = {},
): SpendingIntelligence {
  const msd = opts.monthStartDay ?? 1;
  const th = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const cur = inRange(all, periods.current.from, periods.current.to);
  const prev = inRange(all, periods.previous.from, periods.previous.to);
  const curTotals = spendTotals(cur, all);
  const prevTotals = spendTotals(prev, all);

  const curCats = categoryStats(cur, all);
  const prevCats = categoryStats(prev, all);
  const catChanges = compareGroups(curCats, prevCats, th);
  const catChangeByKey = new Map(catChanges.map((c) => [c.key, c]));
  const prevCatByKey = new Map(prevCats.map((c) => [c.key, c]));
  const catTotal = sum(curCats.map((c) => c.amount));
  const categories: CategoryRow[] = curCats.map((c) => ({
    ...c,
    pctOfSpending: pct(c.amount, catTotal),
    previousAmount: prevCatByKey.get(c.key)?.amount ?? 0,
    previousCount: prevCatByKey.get(c.key)?.count ?? 0,
    change: catChangeByKey.get(c.key)!,
  }));

  const curMerch = merchantStats(cur, all);
  const prevMerch = merchantStats(prev, all);
  const merchChanges = compareGroups(curMerch, prevMerch, th);
  const merchChangeByKey = new Map(merchChanges.map((c) => [c.key, c]));
  const prevMerchByKey = new Map(prevMerch.map((c) => [c.key, c]));
  const monthly = spendingSeriesByMerchant(all, curMerch.slice(0, opts.merchantLimit ?? 10).map((m) => m.key), msd);
  const merchants: MerchantRow[] = curMerch.slice(0, opts.merchantLimit ?? 10).map((m) => ({
    ...m,
    previousAmount: prevMerchByKey.get(m.key)?.amount ?? 0,
    previousCount: prevMerchByKey.get(m.key)?.count ?? 0,
    change: merchChangeByKey.get(m.key)!,
    monthly: monthly.get(m.key) ?? [],
  }));

  const caveats: string[] = [];
  const firstDate = all.reduce<ISODate | null>((a, t) => (a === null || t.date < a ? t.date : a), null);
  if (!all.length) caveats.push("No transactions yet.");
  else if (firstDate && firstDate > periods.previous.from) caveats.push(`Your history starts on ${formatDateLong(firstDate)}, so the previous period is incomplete and changes may be overstated.`);
  if (periods.partial) caveats.push(`${periods.current.label} is still in progress (${periods.elapsedDays} of ${periods.totalDays} days); it is compared with the same number of days in the previous period.`);
  if (prevTotals.transactionCount === 0 && all.length) caveats.push("There are no transactions in the previous period to compare with.");

  return {
    periods,
    totals: {
      current: curTotals,
      previous: prevTotals,
      change: { amount: round2(curTotals.net - prevTotals.net), pct: prevTotals.net > 0 ? Math.round(((curTotals.net - prevTotals.net) / prevTotals.net) * 1000) / 10 : null },
    },
    categories,
    merchants,
    paymentMethods: paymentMethodStats(cur, all),
    changes: { categories: catChanges.filter((c) => c.significant), merchants: merchChanges.filter((c) => c.significant) },
    thresholds: th,
    caveats,
  };
}

/** Last 6 months of refund-netted spending for each requested merchant. */
function spendingSeriesByMerchant(all: TxnLite[], merchants: string[], msd: number) {
  const out = new Map<string, { key: string; label: string; amount: number }[]>();
  if (!merchants.length) return out;
  const rows = netSpendingRows(all, all).filter((r) => merchants.includes(r.merchant));
  const months = [...new Set(all.map((t) => bucketKey(t.date, "monthly", msd)))].sort().slice(-6);
  for (const m of merchants) {
    out.set(
      m,
      months.map((mk) => ({
        key: mk,
        label: bucketLabel(mk, "monthly"),
        amount: sum(rows.filter((r) => r.merchant === m && bucketKey(r.date, "monthly", msd) === mk).map((r) => r.net)),
      })),
    );
  }
  return out;
}
