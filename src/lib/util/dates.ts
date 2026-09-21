/**
 * Timezone-safe date helpers. All dates are ISO `YYYY-MM-DD` strings and all
 * arithmetic is done in UTC so DST / server timezone can never shift a day.
 */
export type ISODate = string;

const MS_DAY = 86_400_000;

export function parseISO(s: ISODate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Today in the server's local calendar (not UTC), as ISO. */
export function todayISO(now: Date = new Date()): ISODate {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidISO(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISO(s);
  return !Number.isNaN(d.getTime()) && toISO(d) === s;
}

export function addDays(s: ISODate, n: number): ISODate {
  return toISO(new Date(parseISO(s).getTime() + n * MS_DAY));
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / MS_DAY);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function addMonths(s: ISODate, n: number, preferDay?: number): ISODate {
  const d = parseISO(s);
  const day = preferDay ?? d.getUTCDate();
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const m = total % 12; // 0-based
  const dim = daysInMonth(y, m + 1);
  return toISO(new Date(Date.UTC(y, m, Math.min(day, dim))));
}

export function startOfMonth(s: ISODate): ISODate {
  return s.slice(0, 8) + "01";
}

export function endOfMonth(s: ISODate): ISODate {
  const d = parseISO(s);
  return toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** ISO-8601 weekday: Mon=1 ... Sun=7 */
export function isoWeekday(s: ISODate): number {
  const w = parseISO(s).getUTCDay();
  return w === 0 ? 7 : w;
}

export function weekStart(s: ISODate): ISODate {
  return addDays(s, 1 - isoWeekday(s));
}

/** ISO-8601 week number and week-year. */
export function isoWeek(s: ISODate): { year: number; week: number } {
  const d = parseISO(s);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / MS_DAY + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type Granularity = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

/**
 * Month key honouring a "financial month" that starts on `startDay`.
 * With startDay=25, 2025-03-27 belongs to the financial month "2025-03"
 * (25 Mar - 24 Apr) and 2025-03-10 belongs to "2025-02".
 */
export function monthKey(s: ISODate, startDay = 1): string {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (startDay <= 1 || d >= startDay) return `${y}-${String(m).padStart(2, "0")}`;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

export function quarterKey(s: ISODate, startDay = 1): string {
  const mk = monthKey(s, startDay);
  const y = Number(mk.slice(0, 4));
  const m = Number(mk.slice(5, 7));
  return `${y}-Q${Math.ceil(m / 3)}`;
}

export function bucketKey(s: ISODate, g: Granularity, startDay = 1): string {
  switch (g) {
    case "daily":
      return s;
    case "weekly": {
      const { year, week } = isoWeek(s);
      return `${year}-W${String(week).padStart(2, "0")}`;
    }
    case "monthly":
      return monthKey(s, startDay);
    case "quarterly":
      return quarterKey(s, startDay);
    case "yearly":
      return s.slice(0, 4);
  }
}

/** Human label for a bucket key. */
export function bucketLabel(key: string, g: Granularity): string {
  switch (g) {
    case "daily": {
      const d = parseISO(key);
      return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
    }
    case "weekly":
      return `Week ${Number(key.slice(6))} · ${key.slice(0, 4)}`;
    case "monthly":
      return `${MONTH_SHORT[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    case "quarterly":
      return `${key.slice(5)} ${key.slice(0, 4)}`;
    case "yearly":
      return key;
  }
}

/** First calendar date of a financial month key. */
export function monthKeyStart(key: string, startDay = 1): ISODate {
  return `${key}-${String(Math.max(1, startDay)).padStart(2, "0")}`;
}

export interface DateRange {
  from: ISODate;
  to: ISODate;
}

/** Financial-month range containing `s`. */
export function financialMonthRange(s: ISODate, startDay = 1): DateRange {
  const key = monthKey(s, startDay);
  const from = monthKeyStart(key, startDay);
  if (startDay <= 1) return { from, to: endOfMonth(from) };
  return { from, to: addDays(addMonths(from, 1, startDay), -1) };
}

export function formatDateLong(s: ISODate): string {
  const d = parseISO(s);
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
