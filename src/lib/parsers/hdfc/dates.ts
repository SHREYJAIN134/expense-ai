import { MONTH_SHORT, isValidISO, type ISODate } from "../../util/dates";

const MONTH_INDEX: Record<string, number> = Object.fromEntries(MONTH_SHORT.map((m, i) => [m.toLowerCase(), i + 1]));

function fixYear(y: number): number {
  if (y >= 100) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function build(y: number, m: number, d: number): ISODate | null {
  const iso = `${String(fixYear(y)).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidISO(iso) ? iso : null;
}

/**
 * Parse the date formats seen on Indian bank statements:
 *   dd/mm/yy  dd/mm/yyyy  dd-mm-yyyy  dd.mm.yyyy  dd MMM yyyy  dd-MMM-yy  yyyy-mm-dd
 * Returns null for anything that is not a real calendar date.
 */
export function parseStatementDate(raw: string): ISODate | null {
  const s = raw.trim().replace(/,/g, "");
  let m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (m) return build(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3,9})[\s\-/,]*(\d{2}|\d{4})$/);
  if (m) {
    const mi = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
    if (mi) return build(Number(m[3]), mi, Number(m[1]));
  }
  return null;
}

/** A whole-string date token (used to detect the start of a transaction row). */
export const DATE_TOKEN_RE =
  /^\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{2}|\d{4})$|^\d{1,2}[\s\-/][A-Za-z]{3,9}[\s\-/,]*(?:\d{2}|\d{4})$/;

/** Find the first date anywhere inside free text. */
export const DATE_ANYWHERE_RE =
  /\b(\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})|\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-,]+(?:\d{4}|\d{2}))\b/;
