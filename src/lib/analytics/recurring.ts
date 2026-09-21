/**
 * Recurring payment detection from transaction history.
 * Everything here is a *pattern estimate* - never a guarantee. The UI/chat must
 * use wording like "expected", "estimated", "based on historical pattern".
 */
import type { TxnLite } from "../domain/types";
import { addDays, addMonths, daysBetween, type ISODate } from "../util/dates";
import { mean, median, round2, stddev } from "../util/money";

export type RecurringType = "FIXED" | "VARIABLE" | "AUTOPAY";
export type Frequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

export interface RecurringSeries {
  key: string;
  merchant: string;
  category: string;
  subcategory: string;
  kind: "expense" | "income";
  frequency: Frequency;
  averageAmount: number;
  lastAmount: number;
  amountPattern: "fixed" | "variable";
  /**
   * AUTOPAY = the bank narration explicitly says so (UPI AutoPay / mandate / ACH debit) on most payments.
   * Otherwise FIXED (same amount every time) or VARIABLE (amount changes). Never inferred from amounts alone.
   */
  type: RecurringType;
  /** Coefficient of variation of the amounts (0 = identical every time). */
  amountVariability: number;
  /** Best single estimate of the next amount: last amount for fixed/autopay series, average for variable ones. */
  expectedAmount: number;
  /** Previous amount when the latest payment differs from it by 5% or more (a price change), else null. */
  amountChangedFrom: number | null;
  lastDate: ISODate;
  nextExpected: ISODate;
  occurrences: number;
  intervalDays: number;
  confidence: number;
  confidenceLabel: "High" | "Medium" | "Low";
  /** Expected date has passed but not by so much that the series looks ended. */
  overdue: boolean;
  /** No payment for > ~2 cycles: probably cancelled. Excluded from upcoming. */
  possiblyEnded: boolean;
  txnIds: string[];
}

const FREQ_RANGES: [Frequency, number, number, number][] = [
  // frequency, min days, max days, nominal days
  ["weekly", 5, 9, 7],
  ["biweekly", 12, 17, 14],
  ["monthly", 26, 35, 30],
  ["quarterly", 84, 100, 91],
  ["yearly", 350, 380, 365],
];

export const FREQ_DAYS: Record<Frequency, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, yearly: 365 };

const DISCRETIONARY = new Set(["FOOD", "GROCERIES", "SHOPPING", "TRANSPORTATION", "TRAVEL", "PERSONAL", "ENTERTAINMENT", "HEALTHCARE"]);
const SKIP_CATEGORIES = new Set(["ATM/CASH", "BANKING FEES", "REFUNDS", "OTHER"]);
const BILL_CATEGORIES = new Set(["UTILITIES", "BILLS", "RENT", "SUBSCRIPTIONS", "EDUCATION", "INVESTMENTS"]);

function classifyFrequency(medianInterval: number): { frequency: Frequency; nominal: number } | null {
  for (const [frequency, lo, hi, nominal] of FREQ_RANGES) if (medianInterval >= lo && medianInterval <= hi) return { frequency, nominal };
  return null;
}

/** Next occurrence date after `last`, honouring the usual day-of-month for monthly/quarterly/yearly. */
export function nextOccurrence(last: ISODate, frequency: Frequency, dayOfMonth?: number): ISODate {
  switch (frequency) {
    case "weekly":
      return addDays(last, 7);
    case "biweekly":
      return addDays(last, 14);
    case "monthly":
      return addMonths(last, 1, dayOfMonth);
    case "quarterly":
      return addMonths(last, 3, dayOfMonth);
    case "yearly":
      return addMonths(last, 12, dayOfMonth);
  }
}

export function detectRecurringExpenses(
  txns: TxnLite[],
  opts: { asOf: ISODate; includeIncome?: boolean } = { asOf: new Date().toISOString().slice(0, 10) },
): RecurringSeries[] {
  const groups = new Map<string, TxnLite[]>();
  for (const t of txns) {
    if (SKIP_CATEGORIES.has(t.category)) continue;
    const kind = t.direction === "credit" ? "income" : "expense";
    if (kind === "income" && !opts.includeIncome) continue;
    if (kind === "income" && t.category !== "SALARY/INCOME" && t.category !== "TRANSFERS") continue;
    const key = `${kind}|${t.merchant.toLowerCase()}`;
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }

  const out: RecurringSeries[] = [];
  for (const [gk, rows] of groups) {
    const kind = gk.startsWith("income") ? "income" : "expense";
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Merge same-merchant same-day charges so a double-tap doesn't create a 0-day interval.
    const merged: { date: ISODate; amount: number; ids: string[]; t: TxnLite }[] = [];
    for (const t of sorted) {
      const amount = t.direction === "credit" ? t.credit : t.debit;
      const last = merged[merged.length - 1];
      if (last && last.date === t.date) {
        last.amount += amount;
        last.ids.push(t.id);
      } else merged.push({ date: t.date, amount, ids: [t.id], t });
    }
    if (merged.length < 2) continue;

    const intervals: number[] = [];
    for (let i = 1; i < merged.length; i++) intervals.push(daysBetween(merged[i - 1].date, merged[i].date));
    const med = median(intervals);
    const cls = classifyFrequency(med);
    if (!cls) continue;

    const tol = Math.max(3, cls.nominal * 0.15);
    const regularity = intervals.filter((d) => Math.abs(d - med) <= tol).length / intervals.length;
    const amounts = merged.map((m) => m.amount);
    const avg = mean(amounts);
    const cv = avg > 0 ? stddev(amounts) / avg : 1;
    const category = sorted[sorted.length - 1].category;
    const subcategory = sorted[sorted.length - 1].subcategory;
    const n = merged.length;

    // Need 3+ occurrences, except a clean fixed-amount monthly pair.
    const cleanPair = n === 2 && cls.frequency === "monthly" && cv < 0.01 && regularity === 1;
    if (n < 3 && !cleanPair) continue;
    if (regularity < 0.6) continue;
    if (cls.frequency === "weekly" && cv > 0.1) continue;
    const discretionary = DISCRETIONARY.has(category) && !(category === "ENTERTAINMENT" && subcategory === "Streaming") && !(category === "PERSONAL" && subcategory === "Fitness");
    if (discretionary && cv > 0.15) continue;
    if (category === "TRANSFERS" && cv > 0.05) continue;
    if (!BILL_CATEGORIES.has(category) && cv > 0.5) continue;

    let confidence = 0.4 * regularity + 0.3 * (1 - Math.min(1, cv / 0.5)) + 0.3 * Math.min(1, n / 6);
    if (BILL_CATEGORIES.has(category)) confidence += 0.05;
    if (cleanPair) confidence = Math.min(confidence, 0.5);
    confidence = Math.round(Math.min(1, confidence) * 100) / 100;

    const last = merged[merged.length - 1];
    const autopayCount = sorted.filter((t) => t.paymentMethod === "AUTOPAY").length;
    const isAutopay = kind === "expense" && autopayCount >= Math.ceil(sorted.length / 2);
    const prevAmount = merged.length >= 2 ? merged[merged.length - 2].amount : null;
    const amountChangedFrom = prevAmount !== null && prevAmount > 0 && Math.abs(last.amount - prevAmount) / prevAmount >= 0.05 ? round2(prevAmount) : null;
    // Two equal latest payments after a different earlier level = a settled new price: expect that level, not the old average.
    const settledLevel = merged.length >= 3 && Math.abs(last.amount - merged[merged.length - 2].amount) <= 0.01 * last.amount && cv > 0.05;
    const amountPattern = cv <= 0.05 ? "fixed" : "variable";
    const daysOfMonth = merged.map((m) => Number(m.date.slice(8, 10)));
    const usualDay = Math.round(median(daysOfMonth));
    const usesDay = cls.frequency === "monthly" || cls.frequency === "quarterly" || cls.frequency === "yearly";
    const next = nextOccurrence(last.date, cls.frequency, usesDay ? usualDay : undefined);
    const sinceLast = daysBetween(last.date, opts.asOf);
    const possiblyEnded = sinceLast > med * 2.2;
    const overdue = !possiblyEnded && next < opts.asOf;

    out.push({
      key: gk.split("|")[1],
      merchant: last.t.merchant,
      category,
      subcategory,
      kind,
      frequency: cls.frequency,
      averageAmount: round2(avg),
      lastAmount: round2(last.amount),
      amountPattern,
      type: isAutopay ? "AUTOPAY" : amountPattern === "fixed" ? "FIXED" : "VARIABLE",
      amountVariability: Math.round(cv * 1000) / 1000,
      expectedAmount: round2(amountPattern === "fixed" || settledLevel ? last.amount : avg),
      amountChangedFrom,
      lastDate: last.date,
      nextExpected: next,
      occurrences: n,
      intervalDays: Math.round(med),
      confidence,
      confidenceLabel: confidence >= 0.75 ? "High" : confidence >= 0.55 ? "Medium" : "Low",
      overdue,
      possiblyEnded,
      txnIds: merged.flatMap((m) => m.ids),
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || b.averageAmount - a.averageAmount);
}

/** Monthly-equivalent cost of a series (for "recurring commitments" totals). */
export function monthlyEquivalent(s: Pick<RecurringSeries, "frequency" | "averageAmount">): number {
  const perMonth: Record<Frequency, number> = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
  return round2(s.averageAmount * perMonth[s.frequency]);
}
