/**
 * Layout analysis for tabular bank statements: turns positioned PDF text items
 * into lines, locates the column header row, calibrates column geometry from the
 * actual transaction rows, and maps items to columns.
 *
 * Amount columns are matched by nearest header (statements right-align numbers).
 * Text columns (date / narration / ref / value date) are calibrated from the DATA
 * rows themselves, so the result does not depend on whether the header labels are
 * left-aligned, centred or right-aligned over their columns.
 */
import type { PdfPage, TextItem } from "../pdf-reader";
import { DATE_TOKEN_RE, parseStatementDate } from "./dates";

export type ColumnKey = "date" | "narration" | "ref" | "valueDate" | "debit" | "credit" | "balance";

export interface Line {
  y: number;
  items: TextItem[];
  text: string;
  page: number;
}

export interface ColumnSpec {
  key: ColumnKey;
  start: number;
  end: number;
  center: number;
}

export interface HeaderLayout {
  columns: ColumnSpec[];
  lineIndex: number;
  calibrated?: boolean;
}

/** Amounts on statements always carry decimals; this stricter form avoids matching ref numbers. */
export const DECIMAL_AMOUNT_RE = /^\(?-?(?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{1,2}\)?(?:\s?(?:Cr|Dr)\.?)?$/i;
const REF_NUMBER_RE = /^\d{8,20}$/;

export function groupLines(page: PdfPage, tol = 2.5): Line[] {
  const items = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) {
      last.items.push(it);
    } else {
      lines.push({ y: it.y, items: [it], text: "", page: page.page });
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = joinItems(l.items);
  }
  return lines;
}

/** Join items, inserting a space only where there is a visible gap. */
export function joinItems(items: TextItem[]): string {
  let out = "";
  let prevEnd: number | null = null;
  for (const it of items) {
    if (prevEnd !== null) {
      const gap = it.x - prevEnd;
      out += gap > 1.2 || /\s$/.test(out) || /^\s/.test(it.str) ? " " : "";
    }
    out += it.str.trim();
    prevEnd = it.x + it.w;
  }
  return out.replace(/\s+/g, " ").trim();
}

function classifyHeaderItem(s: string): ColumnKey | null {
  const t = s.toLowerCase().replace(/[.\s]+/g, " ").trim();
  if (!t) return null;
  if (/\bvalue\b/.test(t)) return "valueDate";
  if (/^(txn|transaction|posting)?\s*date$|^date$/.test(t)) return "date";
  if (/narration|description|particulars|details|remarks/.test(t)) return "narration";
  if (/chq|cheque|ref|instrument/.test(t)) return "ref";
  if (/withdraw|debit|\bdr\b/.test(t)) return "debit";
  if (/deposit|credit|\bcr\b/.test(t)) return "credit";
  if (/balance|closing/.test(t)) return "balance";
  return null;
}

/** Locate the header row on a page and derive column geometry. */
export function findHeader(lines: Line[]): HeaderLayout | null {
  for (let i = 0; i < lines.length; i++) {
    const keyed = new Map<ColumnKey, { start: number; end: number }>();
    for (const it of lines[i].items) {
      const k = classifyHeaderItem(it.str);
      if (!k) continue;
      const cur = keyed.get(k);
      const end = it.x + Math.max(it.w, 1);
      if (cur) {
        // Adjacent header words of one column, e.g. "Closing" "Balance"
        if (it.x - cur.end < 14) cur.end = Math.max(cur.end, end);
      } else keyed.set(k, { start: it.x, end });
    }
    const hasCore =
      keyed.has("date") && keyed.has("narration") && keyed.has("balance") && (keyed.has("debit") || keyed.has("credit"));
    if (hasCore) {
      const columns: ColumnSpec[] = [...keyed.entries()]
        .map(([key, v]) => ({ key, start: v.start, end: v.end, center: (v.start + v.end) / 2 }))
        .sort((a, b) => a.start - b.start);
      return { columns, lineIndex: i };
    }
  }
  return null;
}

const AMOUNT_KEYS: ColumnKey[] = ["debit", "credit", "balance"];

/**
 * A line starts a transaction only if its LEFTMOST item is a real calendar date AND the
 * same line carries at least one decimal amount (the balance is printed on the first line
 * of every HDFC row). This is what keeps header/footer/metadata dates - "Statement From",
 * "A/C Open Date", "Generated On" - from ever being read as transactions.
 */
export function isRowStartLine(line: Line): boolean {
  const first = line.items[0]?.str.trim() ?? "";
  if (!DATE_TOKEN_RE.test(first) || parseStatementDate(first) === null) return false;
  return line.items.slice(1).some((it) => DECIMAL_AMOUNT_RE.test(it.str.trim()));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Refine text-column starts using the transaction rows actually present on the page.
 * Falls back to the header-derived geometry if the data is inconsistent.
 */
export function calibrateHeader(lines: Line[], header: HeaderLayout): HeaderLayout {
  const dateX: number[] = [];
  const narrX: number[] = [];
  const refX: number[] = [];
  const valX: number[] = [];
  for (const line of lines) {
    if (!isRowStartLine(line)) continue;
    const rest = line.items.slice(1);
    dateX.push(line.items[0].x);
    const narr = rest.find((it) => {
      const t = it.str.trim();
      return !DATE_TOKEN_RE.test(t) && !DECIMAL_AMOUNT_RE.test(t) && !REF_NUMBER_RE.test(t);
    });
    if (narr) narrX.push(narr.x);
    const ref = rest.find((it) => REF_NUMBER_RE.test(it.str.trim()));
    if (ref) refX.push(ref.x);
    const val = rest.find((it) => DATE_TOKEN_RE.test(it.str.trim()));
    if (val) valX.push(val.x);
  }
  if (!dateX.length) return header;

  const starts: Partial<Record<ColumnKey, number>> = { date: Math.min(...dateX) - 1 };
  if (narrX.length) starts.narration = median(narrX) - 1;
  if (refX.length) starts.ref = median(refX) - 1;
  if (valX.length) starts.valueDate = median(valX) - 1;

  const columns = header.columns.map((c) => (starts[c.key] !== undefined && !AMOUNT_KEYS.includes(c.key) ? { ...c, start: starts[c.key]! } : c));
  // Sanity: text columns must stay in left-to-right order and left of the amount columns.
  const text = columns.filter((c) => !AMOUNT_KEYS.includes(c.key)).sort((a, b) => a.start - b.start);
  const order: ColumnKey[] = ["date", "narration", "ref", "valueDate"];
  const present = order.filter((k) => text.some((c) => c.key === k));
  const inOrder = present.every((k, i) => i === 0 || text.findIndex((c) => c.key === k) > text.findIndex((c) => c.key === present[i - 1]));
  const firstAmount = Math.min(...columns.filter((c) => AMOUNT_KEYS.includes(c.key)).map((c) => c.start), Infinity);
  if (!inOrder || text.some((c) => c.start >= firstAmount)) return header;
  return { ...header, columns: columns.sort((a, b) => a.start - b.start), calibrated: true };
}

export interface Cells {
  date?: string;
  narration?: string;
  ref?: string;
  valueDate?: string;
  debit?: string;
  credit?: string;
  balance?: string;
}

/** Start x of the narration column (left edge) - anything left of it is the DATE column. */
export function narrationStart(header: HeaderLayout): number {
  return header.columns.find((c) => c.key === "narration")?.start ?? 0;
}

/** True when a (non-row-start) line has text sitting in the DATE column: not a wrapped narration. */
export function hasTextInDateColumn(line: Line, header: HeaderLayout): boolean {
  const limit = narrationStart(header) - 4;
  return line.items.some((it) => it.x < limit && it.str.trim().length > 0);
}

/** Map a line's items into column cells. */
export function assignCells(line: Line, header: HeaderLayout): Cells {
  const cols = header.columns;
  const amountCols = cols.filter((c) => AMOUNT_KEYS.includes(c.key));
  const textCols = cols.filter((c) => !AMOUNT_KEYS.includes(c.key));
  const firstAmountStart = amountCols.length ? Math.min(...amountCols.map((c) => c.start)) : Infinity;
  const buckets = new Map<ColumnKey, TextItem[]>();
  const add = (k: ColumnKey, it: TextItem) => {
    const arr = buckets.get(k) ?? [];
    arr.push(it);
    buckets.set(k, arr);
  };

  for (const it of line.items) {
    const s = it.str.trim();
    const right = it.x + it.w;
    const center = it.x + it.w / 2;
    // Numeric-with-decimals items in the amount zone go to the nearest amount column.
    if (amountCols.length && DECIMAL_AMOUNT_RE.test(s) && right >= firstAmountStart - 6) {
      let best = amountCols[0];
      let bestD = Infinity;
      for (const c of amountCols) {
        const d = Math.min(Math.abs(center - c.center), Math.abs(right - c.end));
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      add(best.key, it);
      continue;
    }
    // Everything else is left-aligned text: choose the last text column starting at/left of the item.
    let chosen = textCols[0];
    for (const c of textCols) if (c.start - 3 <= it.x) chosen = c;
    if (chosen) add(chosen.key, it);
  }

  const cells: Cells = {};
  for (const [k, arr] of buckets) {
    const sorted = arr.sort((a, b) => a.x - b.x);
    cells[k] = joinItems(sorted);
    if (k === "narration") {
      // Keep a visible trailing/leading space so "ACME " + "TECH" is not fused into "ACMETECH".
      if (/\s$/.test(sorted[sorted.length - 1].str)) cells.narration += " ";
      if (/^\s/.test(sorted[0].str)) cells.narration = " " + cells.narration;
    }
  }
  return cells;
}
