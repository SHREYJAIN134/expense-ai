/**
 * Explicit calendar dates in questions: "24th of August", "24 Aug 2026", "August 24", "24/08", "2026-08-24",
 * "from August 20 to August 24", "last Monday". Deterministic and pure.
 *
 * Rules
 *  - An impossible date ("August 35", "31 Feb") is an ERROR the user is told about, never silently reinterpreted.
 *  - No year given: if the imported data (statements) covers exactly one year in which that date exists, that year is
 *    used. If it covers several, the question is AMBIGUOUS and the user is asked. With no data range, the most recent
 *    such date that is not in the future is used.
 */
import { MONTH_NAMES, addDays, formatDateLong, isValidISO, isoWeekday, weekStart, type ISODate } from "../util/dates";

export interface ExplicitDates {
  from: ISODate;
  to: ISODate;
  label: string;
  kind: "past" | "current" | "future";
  /** The question named an impossible date. */
  error?: string;
  /** More than one year is possible: ask instead of guessing. */
  clarify?: string;
}

const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD = "(?:st|nd|rd|th)?";

const monthIndex = (w: string) => MONTH_NAMES.findIndex((m) => m.slice(0, 3).toLowerCase() === w.slice(0, 3).toLowerCase()) + 1;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): ISODate => `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;

interface Tok {
  start: number;
  end: number;
  day: number;
  month: number;
  year?: number;
}

/** Find every explicit day+month(+year) in the text, left to right. Matched spans are blanked so patterns never overlap. */
function findTokens(text: string): Tok[] {
  let t = text;
  const toks: Tok[] = [];
  const take = (re: RegExp, build: (m: RegExpExecArray) => Omit<Tok, "start" | "end"> | null) => {
    t = t.replace(re, (...args) => {
      const m = args.slice(0, args.length - 2) as unknown as RegExpExecArray;
      const offset = args[args.length - 2] as number;
      const built = build(m);
      if (!built) return m[0];
      toks.push({ start: offset, end: offset + m[0].length, ...built });
      return " ".repeat(m[0].length);
    });
  };
  const yr = (s?: string) => (s ? (s.length === 2 ? 2000 + Number(s) : Number(s)) : undefined);
  // 2026-08-24
  take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (m) => ({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }));
  // 24th of august [2026]
  take(new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:of\\s+)?${MONTH_WORD}\\b\\.?(?:[\\s,]+(\\d{4})\\b)?`, "gi"), (m) => ({ day: Number(m[1]), month: monthIndex(m[2]), year: yr(m[3]) }));
  // august 24[th] [2026]
  take(new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?!\\d)${ORD}\\b(?:[\\s,]+(\\d{4})\\b)?`, "gi"), (m) => ({ month: monthIndex(m[1]), day: Number(m[2]), year: yr(m[3]) }));
  // 24/08[/2026], 24-08[-26]  (day first, as on Indian statements; month-first only when day-first is impossible)
  take(/(?<![\d/.-])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?(?![\d/])/g, (m) => {
    let day = Number(m[1]);
    let month = Number(m[2]);
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return { day, month, year: yr(m[3]) };
  });
  return toks.sort((a, b) => a.start - b.start);
}

function daysIn(month: number, year: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

type Resolved = { date: ISODate } | { error: string } | { clarify: string };

function resolveToken(tok: Tok, today: ISODate, data?: { from: ISODate; to: ISODate }): Resolved {
  const { day, month } = tok;
  const name = `${day} ${MONTH_NAMES[month - 1] ?? "?"}`;
  if (month < 1 || month > 12 || day < 1 || day > 31) return { error: `"${name}${tok.year ? " " + tok.year : ""}" is not a valid date.` };
  if (tok.year) {
    const d = iso(tok.year, month, day);
    return isValidISO(d) ? { date: d } : { error: `${name} ${tok.year} is not a valid date (that month has ${daysIn(month, tok.year)} days).` };
  }
  if (day > daysIn(month, 2024)) return { error: `"${name}" is not a valid date (${MONTH_NAMES[month - 1]} never has ${day} days).` };
  if (data) {
    const y0 = Number(data.from.slice(0, 4));
    const y1 = Number(data.to.slice(0, 4));
    const years: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const d = iso(y, month, day);
      if (isValidISO(d) && d >= data.from && d <= data.to) years.push(y);
    }
    if (years.length === 1) return { date: iso(years[0], month, day) };
    if (years.length > 1) return { clarify: `${name} exists in your data for more than one year (${years.join(" and ")}). Which year do you mean? For example: "${name} ${years[years.length - 1]}".` };
  }
  // No usable data range: the most recent such date that is not in the future.
  let y = Number(today.slice(0, 4));
  for (let i = 0; i < 8; i++, y--) {
    const d = iso(y, month, day);
    if (isValidISO(d) && d <= today) return { date: d };
  }
  return { error: `${name} is not a valid date.` };
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Returns null when the text contains no explicit date. */
export function resolveExplicitDates(text: string, today: ISODate, data?: { from: ISODate; to: ISODate }): ExplicitDates | null {
  const t = text.toLowerCase();
  const kindOf = (from: ISODate, to: ISODate): ExplicitDates["kind"] => (from > today ? "future" : to >= today ? "current" : "past");
  const problem = (r: Resolved): ExplicitDates | null =>
    "error" in r ? { from: today, to: today, label: "", kind: "past", error: r.error } : "clarify" in r ? { from: today, to: today, label: "", kind: "past", clarify: r.clarify } : null;

  // "from 20 to 24 august", "between 20th and 24th of august 2026": the first day borrows the month
  const short = t.match(new RegExp(`\\b(?:from|between)\\s+(\\d{1,2})${ORD}\\s+(?:to|until|till|through|and|-)\\s+(\\d{1,2})${ORD}\\s*(?:of\\s+)?${MONTH_WORD}\\b\\.?(?:[\\s,]+(\\d{4})\\b)?`));
  if (short) {
    const month = monthIndex(short[3]);
    const year = short[4] ? Number(short[4]) : undefined;
    const a = resolveToken({ start: 0, end: 0, day: Number(short[1]), month, year }, today, data);
    const b = resolveToken({ start: 0, end: 0, day: Number(short[2]), month, year }, today, data);
    const bad = problem(a) ?? problem(b);
    if (bad) return bad;
    const [x, y] = [(a as { date: ISODate }).date, (b as { date: ISODate }).date].sort();
    return { from: x, to: y, label: `from ${formatDateLong(x)} to ${formatDateLong(y)}`, kind: kindOf(x, y) };
  }

  const toks = findTokens(t);
  if (toks.length >= 2) {
    const between = t.slice(toks[0].end, toks[1].start);
    const before = t.slice(Math.max(0, toks[0].start - 12), toks[0].start);
    if (/\b(to|until|till|through|and)\b|-/.test(between) || /\b(from|between)\s*$/.test(before)) {
      const a = resolveToken(toks[0], today, data);
      const b = resolveToken(toks[1], today, data);
      const bad = problem(a) ?? problem(b);
      if (bad) return bad;
      const [x, y] = [(a as { date: ISODate }).date, (b as { date: ISODate }).date].sort();
      return { from: x, to: y, label: `from ${formatDateLong(x)} to ${formatDateLong(y)}`, kind: kindOf(x, y) };
    }
  }
  if (toks.length >= 1) {
    const r = resolveToken(toks[0], today, data);
    const bad = problem(r);
    if (bad) return bad;
    const d = (r as { date: ISODate }).date;
    return { from: d, to: d, label: `on ${formatDateLong(d)}`, kind: kindOf(d, d) };
  }

  // "last monday", "this friday"
  const wd = t.match(new RegExp(`\\b(last|previous|this)\\s+(${WEEKDAYS.join("|")})\\b`));
  if (wd) {
    const idx = WEEKDAYS.indexOf(wd[2]) + 1; // ISO: Mon = 1
    let d: ISODate;
    if (wd[1] === "this") d = addDays(weekStart(today), idx - 1);
    else {
      const back = (isoWeekday(today) - idx + 7) % 7 || 7; // strictly before today
      d = addDays(today, -back);
    }
    return { from: d, to: d, label: `on ${wd[1] === "this" ? "this" : "last"} ${WEEKDAYS[idx - 1][0].toUpperCase() + WEEKDAYS[idx - 1].slice(1)} (${formatDateLong(d)})`, kind: kindOf(d, d) };
  }
  return null;
}
