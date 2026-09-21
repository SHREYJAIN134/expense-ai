/**
 * Ranking questions ("which day had the most transactions / spending / money received", "largest transaction",
 * "top merchants", "highest-spending week / month"). Pure aggregation over CANONICAL financial events (the rows
 * `loadAllTxns` returns: one per real-world event, so a payment present in both HDFC and Google Pay counts once).
 * Nothing here calls a language model, and nothing sends transactions anywhere.
 *
 * Definitions (same rules as the rest of the analytics):
 *  - transactions       = canonical events of any direction (a refund, a transfer and a purchase each count as one)
 *  - spending           = debits excluding TRANSFERS / INVESTMENTS, with refunds netted against the purchase
 *  - money out / in     = all debits / all credits (transfers included: it is money that really moved)
 *  - money received     = money in, excluding transfers between the user's own accounts
 *  - income             = credits categorised SALARY/INCOME only
 *  - transaction value  = money out + money in (own-account transfers excluded)
 * Ties are returned as ties: every day sharing the top value is a winner.
 */
import { INCOME_CATEGORY } from "../domain/categories";
import type { TxnLite } from "../domain/types";
import type { ISODate } from "../util/dates";
import { round2, sum } from "../util/money";
import { isDebit, isRefund } from "./engine";
import { netSpendingRows, spendingSeries } from "./compare";

const EPS = 0.005;
const isSelfTransfer = (t: TxnLite) => t.subcategory === "Self Transfer";

export interface DayStat {
  date: ISODate;
  /** Canonical events that day (own-account transfers included: they are events). */
  count: number;
  debitCount: number;
  creditCount: number;
  moneyOut: number;
  moneyIn: number;
  /** Spending (net of refunds, excluding transfers / investments). */
  spending: number;
  income: number;
  refunds: number;
  /** Money in that came from people / transfers. */
  transfersIn: number;
  /** moneyOut + moneyIn */
  value: number;
  largestPayment: { amount: number; merchant: string; category: string } | null;
  largestReceipt: { amount: number; merchant: string; category: string } | null;
}

/** One row per calendar day that has at least one event. `period` is the slice to rank, `all` the full history (refund netting). */
export function dayStats(period: TxnLite[], all: TxnLite[] = period): DayStat[] {
  const spendByDay = new Map(spendingSeries(all, "daily").map((p) => [p.key, p.spending]));
  const netRows = netSpendingRows(period, all);
  const byDay = new Map<ISODate, TxnLite[]>();
  for (const t of period) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  const out: DayStat[] = [];
  for (const [date, rows] of byDay) {
    const real = rows.filter((t) => !isSelfTransfer(t));
    const debits = real.filter(isDebit);
    const credits = real.filter((t) => t.direction === "credit");
    const dayNet = netRows.filter((r) => r.date === date);
    const big = dayNet.reduce<(typeof dayNet)[number] | null>((a, r) => (!a || r.net > a.net ? r : a), null);
    const bigIn = credits.reduce<TxnLite | null>((a, r) => (!a || r.credit > a.credit ? r : a), null);
    const moneyOut = sum(debits.map((t) => t.debit));
    const moneyIn = sum(credits.map((t) => t.credit));
    out.push({
      date,
      count: rows.length,
      debitCount: rows.filter(isDebit).length,
      creditCount: rows.filter((t) => t.direction === "credit").length,
      moneyOut,
      moneyIn,
      spending: spendByDay.get(date) ?? 0,
      income: sum(credits.filter((t) => t.category === INCOME_CATEGORY).map((t) => t.credit)),
      refunds: sum(credits.filter(isRefund).map((t) => t.credit)),
      transfersIn: sum(credits.filter((t) => t.category === "TRANSFERS").map((t) => t.credit)),
      value: round2(moneyOut + moneyIn),
      largestPayment: big ? { amount: big.net, merchant: big.merchant, category: big.category } : null,
      largestReceipt: bigIn ? { amount: bigIn.credit, merchant: bigIn.merchant, category: bigIn.category } : null,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export type DayMetric = "count" | "spending" | "moneyIn" | "income" | "value";

export interface Ranked<T> {
  /** Everything that shares the best value (more than one = a tie). */
  winners: T[];
  /** Best first; ties in date order. */
  ranked: T[];
  best: number;
}

export function rankBy<T>(items: T[], value: (t: T) => number, key: (t: T) => string): Ranked<T> {
  const ranked = [...items].sort((a, b) => value(b) - value(a) || (key(a) < key(b) ? -1 : 1));
  const best = ranked.length ? value(ranked[0]) : 0;
  return { winners: ranked.filter((r) => Math.abs(value(r) - best) < EPS), ranked, best };
}

export function rankDays(stats: DayStat[], metric: DayMetric): Ranked<DayStat> {
  const v = (d: DayStat) => (metric === "count" ? d.count : metric === "spending" ? d.spending : metric === "moneyIn" ? d.moneyIn : metric === "income" ? d.income : d.value);
  // days with nothing to rank on (e.g. no spending at all) cannot win
  const r = rankBy(stats, v, (d) => d.date);
  if (r.best <= 0) return { winners: [], ranked: r.ranked, best: 0 };
  return r;
}

/** Largest single transaction(s) by amount. Ties are all returned. Own-account transfers are not "transactions" for this purpose. */
export function largestTransactions(period: TxnLite[], direction?: "debit" | "credit"): Ranked<TxnLite> {
  const rows = period.filter((t) => !isSelfTransfer(t) && (!direction || t.direction === direction));
  return rankBy(rows, (t) => t.amount, (t) => `${t.date}${t.id}`);
}

export interface MerchantRank {
  merchant: string;
  category: string;
  amount: number;
  count: number;
  share: number;
}

/** Merchants by net spending (refund-netted; transfers to people and investments are not merchants you spent at). */
export function topMerchantsBySpend(period: TxnLite[], all: TxnLite[] = period): MerchantRank[] {
  const rows = netSpendingRows(period, all);
  const total = sum(rows.map((r) => r.net));
  const map = new Map<string, { amount: number; count: number; cats: Map<string, number> }>();
  for (const r of rows) {
    const m = map.get(r.merchant) ?? { amount: 0, count: 0, cats: new Map() };
    m.amount += r.net;
    m.count++;
    m.cats.set(r.category, (m.cats.get(r.category) ?? 0) + r.net);
    map.set(r.merchant, m);
  }
  return [...map.entries()].map(([merchant, m]) => ({
    merchant,
    category: [...m.cats.entries()].sort((a, b) => b[1] - a[1])[0][0],
    amount: round2(m.amount),
    count: m.count,
    share: total > 0 ? Math.round((m.amount / total) * 1000) / 10 : 0,
  }));
}

export interface PeriodRank {
  key: string;
  label: string;
  start: ISODate;
  spending: number;
  count: number;
}

/** Weeks or months ranked by net spending. */
export function spendingByPeriod(all: TxnLite[], from: ISODate, to: ISODate, grain: "weekly" | "monthly", monthStartDay = 1): PeriodRank[] {
  // Only the rows inside the range are bucketed, so a week that straddles the boundary is counted for the range only.
  const inside = all.filter((t) => t.date >= from && t.date <= to);
  return spendingSeries(inside, grain, monthStartDay).map((p) => ({ key: p.key, label: p.label, start: p.start, spending: p.spending, count: p.count }));
}
