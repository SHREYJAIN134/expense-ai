/**
 * Data for "the Strip": one row per day with what came in, what was spent, what merely moved, and the balance,
 * followed by the estimated path. It only composes figures the rest of the app already computes (canonical events,
 * refund-netted spending, the cash-flow projection); nothing here invents a number.
 */
import { spendingSeries } from "../analytics/compare";
import { isCredit, isDebit } from "../analytics/engine";
import { NON_SPENDING_CATEGORIES } from "../domain/categories";
import { addDays, daysBetween, financialMonthRange, todayISO, type ISODate } from "../util/dates";
import { round2, sum } from "../util/money";
import { currentBalance, dataRange, loadAllTxns, memoize } from "./data";
import { getProjection } from "./intelligence";
import { getSettings } from "./users";

export interface StripDay {
  date: ISODate;
  /** All credits (income, refunds, transfers in, other) - money that arrived. */
  in: number;
  /** Refund-netted spending. */
  spend: number;
  /** Debits that are transfers / investments: money moved, not spent. */
  moved: number;
  count: number;
  /** Balance printed on the statements at the end of the day (carried forward), or null before the first known balance. */
  balance: number | null;
}

export interface StripEstimateDay {
  date: ISODate;
  /** balance + expected credits - expected recurring */
  committed: number;
  /** committed - typical everyday spending */
  likely: number;
  low: number;
  high: number;
  /** Typical everyday spending expected on this day (estimate). */
  everyday: number;
}

export interface StripData {
  from: ISODate;
  to: ISODate;
  view: StripView;
  /** Last day covered by imported statements. */
  dataThrough: ISODate | null;
  today: ISODate;
  staleDays: number;
  days: StripDay[];
  /** `net` is the true change in balance (all credits − all debits); `spend` is net of refunds, so in − spend − moved ≠ net when a refund landed. */
  totals: { in: number; spend: number; moved: number; net: number; count: number };
  estimate: {
    days: StripEstimateDay[];
    /** Named payments expected on a date (recurring / entered by the user). */
    items: { date: ISODate; name: string; amount: number; kind: "expense" | "income"; source: "manual" | "detected"; confidence: string }[];
    confidence: string;
    balanceAsOf: ISODate | null;
  } | null;
}

export type StripView = "week" | "month" | "quarter" | "year" | "custom";

export function resolveStripRange(view: Exclude<StripView, "custom">, through: ISODate, monthStartDay: number): { from: ISODate; to: ISODate } {
  if (view === "week") return { from: addDays(through, -6), to: through };
  if (view === "quarter") return { from: addDays(through, -89), to: through };
  if (view === "year") return { from: addDays(through, -364), to: through };
  const m = financialMonthRange(through, monthStartDay);
  return { from: m.from, to: through < m.to ? through : m.to };
}

export function getStrip(userId: string, view: Exclude<StripView, "custom"> = "month", today: ISODate = todayISO()): StripData | null {
  const range = dataRange(userId);
  if (!range) return null;
  const s = getSettings(userId);
  return memoize(userId, `strip:${view}:${today}:${s.monthStartDay}:${s.safetyBuffer}:${s.includeDetectedRecurring}`, () => {
    const { from, to } = resolveStripRange(view, range.to, s.monthStartDay);
    return buildStrip(userId, from, to, view, today, range.to, true);
  });
}

/** An arbitrary window (the Time lens): actual data only, no estimate. */
export function getStripRange(userId: string, from: ISODate, to: ISODate, today: ISODate = todayISO()): StripData | null {
  const range = dataRange(userId);
  if (!range) return null;
  const end = to > range.to ? range.to : to;
  if (from > end) return { from, to: end, view: "custom", dataThrough: range.to, today, staleDays: Math.max(0, daysBetween(range.to, today)), days: [], totals: { in: 0, spend: 0, moved: 0, net: 0, count: 0 }, estimate: null };
  return buildStrip(userId, from, end, "custom", today, range.to, false);
}

function buildStrip(userId: string, from: ISODate, to: ISODate, view: StripView, today: ISODate, through: ISODate, withEstimate: boolean): StripData {
  const all = loadAllTxns(userId);
  const rows = all.filter((t) => t.date >= from && t.date <= to);
  const spent = new Map(spendingSeries(rows, "daily").map((p) => [p.key, p.spending]));

  // Balance: last printed balance on or before each day, carried forward (looking back before the window for a start value).
  let carry: number | null = null;
  for (const t of all) {
    if (t.date >= from) break;
    if (t.balanceAfter != null) carry = t.balanceAfter;
  }
  const byDay = new Map<ISODate, typeof rows>();
  for (const t of rows) (byDay.get(t.date) ?? byDay.set(t.date, []).get(t.date)!).push(t);

  const days: StripDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = byDay.get(d) ?? [];
    for (const t of r) if (t.balanceAfter != null) carry = t.balanceAfter;
    days.push({
      date: d,
      in: round2(sum(r.filter(isCredit).map((t) => t.credit))),
      spend: spent.get(d) ?? 0,
      moved: round2(sum(r.filter((t) => isDebit(t) && NON_SPENDING_CATEGORIES.has(t.category)).map((t) => t.debit))),
      count: r.length,
      balance: carry,
    });
  }
  const totals = {
    in: round2(sum(days.map((d) => d.in))),
    spend: round2(sum(days.map((d) => d.spend))),
    moved: round2(sum(days.map((d) => d.moved))),
    net: round2(sum(rows.map((t) => t.credit)) - sum(rows.map((t) => t.debit))),
    count: rows.length,
  };

  // Estimate: the existing 30-day projection, from the day after the last statement balance.
  let estimate: StripData["estimate"] = null;
  const bal = withEstimate ? currentBalance(userId) : null;
  if (bal) {
    const p = getProjection(userId, today);
    const h30 = p.horizons.find((h) => h.days === 30) ?? p.horizons[p.horizons.length - 1];
    const horizonDays = Math.max(1, daysBetween(addDays(bal.asOf, 1), h30.to) + 1);
    const everyday = round2(h30.everydaySpending.expected / horizonDays);
    const est = p.path
      .filter((pt) => pt.committed !== undefined && pt.date > bal.asOf)
      .map((pt) => ({ date: pt.date, committed: pt.committed!, likely: pt.likely ?? pt.committed!, low: pt.likelyLow ?? pt.committed!, high: pt.likelyHigh ?? pt.committed!, everyday }));
    estimate = {
      days: est,
      items: h30.items.map((u) => ({ date: u.date, name: u.name, amount: u.amount, kind: u.kind, source: u.source, confidence: u.confidence })),
      confidence: p.confidence,
      balanceAsOf: bal.asOf,
    };
  }
  return { from, to, view, dataThrough: through, today, staleDays: Math.max(0, daysBetween(through, today)), days, totals, estimate };
}
