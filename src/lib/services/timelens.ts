/**
 * The Time lens: one window of the ledger with its comparison, records and the Strip. Everything is composed from
 * existing analytics (period comparison, rankings); nothing is recomputed differently here.
 */
import { analyzeRanges, periodsFromRange, type SpendingIntelligence } from "../analytics/compare";
import { dayStats, largestTransactions, rankDays, type DayStat } from "../analytics/rankings";
import type { TxnLite } from "../domain/types";
import { todayISO, type ISODate } from "../util/dates";
import { dataRange, loadAllTxns, memoize } from "./data";
import { getStripRange, type StripData } from "./strip";
import { thresholdsFor } from "./intelligence";
import { getSettings } from "./users";

export interface TimeRecord {
  best: number;
  /** Everything that shares the best value (a tie is shown as a tie). */
  days: { date: ISODate; value: number; count: number }[];
}

export interface TimeLens {
  from: ISODate;
  to: ISODate;
  label: string;
  strip: StripData;
  spending: SpendingIntelligence;
  /** True when the previous comparable period has data to compare with. */
  hasPrevious: boolean;
  records: {
    busiest: TimeRecord;
    priciest: TimeRecord;
    mostIn: TimeRecord;
    largest: { amount: number; direction: "debit" | "credit"; merchant: string; date: ISODate; id: string; ties: number } | null;
  };
  moneyIn: { count: number };
}

const rec = (stats: DayStat[], metric: "count" | "spending" | "moneyIn"): TimeRecord => {
  const r = rankDays(stats, metric);
  const v = (d: DayStat) => (metric === "count" ? d.count : metric === "spending" ? d.spending : d.moneyIn);
  return { best: r.best, days: r.winners.map((d) => ({ date: d.date, value: v(d), count: d.count })) };
};

export function getTimeLens(userId: string, from: ISODate, to: ISODate, label: string, today: ISODate = todayISO()): TimeLens | null {
  const range = dataRange(userId);
  if (!range) return null;
  const s = getSettings(userId);
  return memoize(userId, `timelens:${from}:${to}:${label}:${today}:${s.monthStartDay}:${s.changeMinPct}:${s.changeMinAmount}:${s.changeMinTxns}`, () => {
    const all: TxnLite[] = loadAllTxns(userId);
    const end = to > range.to ? range.to : to;
    const periods = periodsFromRange({ from, to: end, label }, range.to, s.monthStartDay);
    const spending = analyzeRanges(all, periods, { monthStartDay: s.monthStartDay, thresholds: thresholdsFor(s) });
    const inside = all.filter((t) => t.date >= from && t.date <= end);
    const stats = dayStats(inside, all);
    const big = largestTransactions(inside);
    const top = big.winners[0];
    return {
      from,
      to: end,
      label,
      strip: getStripRange(userId, from, end, today)!,
      spending,
      hasPrevious: spending.totals.previous.transactionCount > 0,
      records: {
        busiest: rec(stats, "count"),
        priciest: rec(stats, "spending"),
        mostIn: rec(stats, "moneyIn"),
        largest: top ? { amount: top.amount, direction: top.direction, merchant: top.merchant, date: top.date, id: top.id, ties: big.winners.length } : null,
      },
      moneyIn: { count: inside.filter((t) => t.direction === "credit").length },
    };
  });
}
