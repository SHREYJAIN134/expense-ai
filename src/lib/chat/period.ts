/** Natural-language period resolution ("last month", "in 2025", "past 30 days", "in March"...). */
import { resolveExplicitDates } from "./dates";
import {
  MONTH_NAMES,
  addDays,
  addMonths,
  endOfMonth,
  financialMonthRange,
  formatDateLong,
  weekStart,
  type DateRange,
  type ISODate,
} from "../util/dates";

export interface ResolvedPeriod extends DateRange {
  label: string;
  kind: "past" | "current" | "future" | "all";
  /** The question named an impossible date (e.g. "August 35"): report it, never reinterpret. */
  error?: string;
  /** The date could be in several years of the imported data: ask which one. */
  clarify?: string;
}

const MONTH_RE = new RegExp(`\\b(${MONTH_NAMES.map((m) => m.slice(0, 3).toLowerCase() + "[a-z]*").join("|")})\\b`, "i");

function monthIndexFromWord(w: string): number {
  const p = w.slice(0, 3).toLowerCase();
  return MONTH_NAMES.findIndex((m) => m.slice(0, 3).toLowerCase() === p);
}

export function resolvePeriod(text: string, today: ISODate, monthStartDay = 1, data?: { from: ISODate; to: ISODate }): ResolvedPeriod | null {
  const t = text.toLowerCase();
  const year = Number(today.slice(0, 4));

  if (/\b(all time|overall|ever|in total|so far overall|since (i|the) (started|beginning))\b/.test(t)) {
    return { from: "0000-01-01", to: today, label: "across all your data", kind: "all" };
  }
  if (/\btoday\b/.test(t)) return { from: today, to: today, label: "today", kind: "current" };
  if (/\byesterday\b/.test(t)) {
    const y = addDays(today, -1);
    return { from: y, to: y, label: "yesterday", kind: "past" };
  }

  // A specific calendar date or date range ("24th of August", "August 20 to August 24", "24/08", "last Monday")
  // is a day, not the whole month it happens to be in.
  const explicit = resolveExplicitDates(t, today, data);
  if (explicit) return explicit;

  // "recently" / "lately" with no explicit period = the last 30 days
  if (/\b(recent(ly)?|lately)\b/.test(t) && !/\b(last|past|this|next|previous)\b/.test(t)) {
    return { from: addDays(today, -29), to: today, label: "in the last 30 days", kind: "past" };
  }

  let m = t.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month|year)s?\b/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const from = unit === "day" ? addDays(today, -(n - 1)) : unit === "week" ? addDays(today, -(n * 7 - 1)) : unit === "month" ? addDays(addMonths(today, -n), 1) : addDays(addMonths(today, -12 * n), 1);
    return { from, to: today, label: `in the last ${n} ${unit}${n > 1 ? "s" : ""}`, kind: "past" };
  }
  m = t.match(/\bnext\s+(\d{1,3})\s+(day|week|month)s?\b/);
  if (m) {
    const n = Number(m[1]);
    const to = m[2] === "day" ? addDays(today, n) : m[2] === "week" ? addDays(today, n * 7) : addDays(addMonths(today, n), 0);
    return { from: today, to, label: `in the next ${n} ${m[2]}${n > 1 ? "s" : ""}`, kind: "future" };
  }
  if (/\bnext month\b/.test(t)) {
    const nm = addMonths(financialMonthRange(today, monthStartDay).from, 1, monthStartDay > 1 ? monthStartDay : 1);
    const r = financialMonthRange(nm, monthStartDay);
    return { ...r, label: "next month", kind: "future" };
  }
  if (/\bthis week\b/.test(t)) return { from: weekStart(today), to: addDays(weekStart(today), 6), label: "this week", kind: "current" };
  if (/\blast week\b/.test(t)) {
    const s = addDays(weekStart(today), -7);
    return { from: s, to: addDays(s, 6), label: "last week", kind: "past" };
  }
  if (/\bthis month\b|\bthis (financial )?month\b|\bmonth so far\b|\bso far this month\b/.test(t)) {
    const r = financialMonthRange(today, monthStartDay);
    return { from: r.from, to: r.to, label: "this month", kind: "current" };
  }
  if (/\blast month\b|\bprevious month\b|\bpast month\b/.test(t)) {
    const cur = financialMonthRange(today, monthStartDay);
    const r = financialMonthRange(addDays(cur.from, -1), monthStartDay);
    return { ...r, label: "last month", kind: "past" };
  }
  if (/\bthis quarter\b/.test(t)) {
    const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
    const from = `${year}-${String(q * 3 + 1).padStart(2, "0")}-01`;
    return { from, to: endOfMonth(addMonths(from, 2)), label: "this quarter", kind: "current" };
  }
  if (/\blast quarter\b/.test(t)) {
    const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
    const start = addMonths(`${year}-${String(q * 3 + 1).padStart(2, "0")}-01`, -3);
    return { from: start, to: endOfMonth(addMonths(start, 2)), label: "last quarter", kind: "past" };
  }
  if (/\bthis year\b|\byear to date\b|\bytd\b/.test(t)) return { from: `${year}-01-01`, to: today, label: `this year (${year})`, kind: "current" };
  if (/\blast year\b|\bprevious year\b/.test(t)) return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, label: `last year (${year - 1})`, kind: "past" };

  // "in March 2026" / "in march" / "march"
  const yearMatch = t.match(/\b(20\d{2})\b/);
  const monthMatch = t.match(MONTH_RE);
  // "may" is also a verb ("how much may I spend"): only read it as the month when it is clearly used as one.
  const mayIsVerb = monthMatch?.[1].toLowerCase() === "may" && !/\b(in|during|for|of|since|from|until|on)\s+may\b|\bmay\s+(20\d{2}|month)\b|^\s*may\s*[?.!]*\s*$/.test(t);
  if (monthMatch && !mayIsVerb && monthIndexFromWord(monthMatch[1]) >= 0 && /\b(in|for|during|of|on)?\s*\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(t)) {
    const mi = monthIndexFromWord(monthMatch[1]);
    let y = yearMatch ? Number(yearMatch[1]) : year;
    if (!yearMatch && mi + 1 > Number(today.slice(5, 7))) y -= 1;
    const from = `${y}-${String(mi + 1).padStart(2, "0")}-01`;
    return { from, to: endOfMonth(from), label: `in ${MONTH_NAMES[mi]} ${y}`, kind: from > today ? "future" : "past" };
  }
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    return { from: `${y}-01-01`, to: y === year ? today : `${y}-12-31`, label: `in ${y}`, kind: y === year ? "current" : "past" };
  }
  return null;
}

export function describeRange(from: ISODate, to: ISODate): string {
  return `${formatDateLong(from)} to ${formatDateLong(to)}`;
}
