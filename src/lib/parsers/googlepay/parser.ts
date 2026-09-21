/**
 * Google Pay transaction-statement parser.
 *
 * Layout (one block per transaction, three printed lines):
 *
 *   01 Aug, 2026   Paid to Rahul Negi                       ₹625
 *   01:00 PM       UPI Transaction ID: 621331236828
 *                    Paid by HDFC Bank 9332
 *
 * Direction comes ONLY from the wording ("Paid to" = debit, "Received from" = credit) - Google Pay prints no signs.
 * The repeated page header (title, contact line, table header) and the page footer (explanatory note, "Page x of y")
 * are recognised structurally and never become transactions. The contact line (phone number / e-mail) is ignored and
 * never stored.
 *
 * Integrity: a block that cannot be read completely (no amount, no id, unknown direction...) aborts the whole parse -
 * a statement is never imported partially.
 */
import { StatementError, type Direction, type ParsedStatement, type ParsedTransaction } from "../../domain/types";
import { addDays, isValidISO, MONTH_SHORT, type ISODate } from "../../util/dates";
import { round2 } from "../../util/money";
import type { PdfPage } from "../pdf-reader";
import { parseStatementDate } from "../hdfc/dates";
import { groupLines, joinItems, type Line } from "../hdfc/layout";
import { reconcileGooglePay } from "./reconcile";

export const GPAY_PARSER_VERSION = "googlepay-1";

const DATE_LINE_RE = /^\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i;
const ID_RE = /^UPI\s+Transaction\s+ID\s*:\s*([A-Za-z0-9]+)$/i;
const BANK_RE = /^Paid\s+(?:by|to)\s+(.+?)\s+(\d{3,6})$/i;
const DIRECTION_RE = /^(Paid to|Received from)\s+(.+)$/i;
const AMOUNT_RE = /^₹\s*([\d,]+(?:\.\d{1,2})?)$/;
const FOOTER_RE = /^(Note:|received\.\s+Any|Page\s+\d+\s+of\s+\d+)/i;
const HEADER_RE = /^(Transaction statement|Date\s*&\s*time)$/i;
/** Text columns: date/time on the left, details in the middle, amount at the far right. */
const DETAILS_MIN_X = 120;
const AMOUNT_MIN_X = 400;

interface Block {
  page: number;
  date: string;
  first: string;
  amountText: string;
  time?: string;
  id?: string;
  bank?: { name: string; mask: string };
  extra: string[];
  lines: string[];
  problems: string[];
}

function to24h(t: string): string | null {
  const m = t.match(TIME_RE);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

const parseRupees = (s: string): number | null => {
  const m = s.trim().match(AMOUNT_RE);
  return m ? round2(Number(m[1].replace(/,/g, ""))) : null;
};

function splitLine(line: Line) {
  const left = line.items.filter((i) => i.x < DETAILS_MIN_X);
  const mid = line.items.filter((i) => i.x >= DETAILS_MIN_X && i.x < AMOUNT_MIN_X);
  const right = line.items.filter((i) => i.x >= AMOUNT_MIN_X);
  return { left: joinItems(left).trim(), mid: joinItems(mid).trim(), right: joinItems(right).trim() };
}

function longDate(s: string): ISODate | null {
  const m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const mi = MONTH_SHORT.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const iso = `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
  return isValidISO(iso) ? iso : null;
}

export function parseGooglePayPages(pages: PdfPage[]): ParsedStatement {
  const warnings: string[] = [];
  const blocks: Block[] = [];
  let period: { start: ISODate; end: ISODate } | undefined;
  let summary: { sent: number; received: number } | undefined;
  let cur: Block | null = null;

  for (const page of pages) {
    const lines = groupLines(page);
    let inBody = false;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const { left, mid, right } = splitLine(line);
      const whole = joinItems(line.items).trim();

      // ---- header region (until the table header row): title, contact line, period / totals summary
      if (!inBody) {
        if (/^Date\s*&\s*time/i.test(left) || (/Date\s*&\s*time/i.test(whole) && /Transaction details/i.test(whole))) {
          inBody = true;
          continue;
        }
        if (/Transaction statement period/i.test(whole) && /Sent/.test(whole) && /Received/.test(whole)) {
          // The next line carries "01 August 2026 - 31 August 2026 | Sent amount | Received amount".
          const next = lines[li + 1];
          if (next) {
            const m = joinItems(next.items).match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*[-–]\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
            const a = m ? longDate(m[1]) : null;
            const b = m ? longDate(m[2]) : null;
            if (a && b) period = { start: a, end: b };
            const sentX = line.items.find((i) => /^Sent$/.test(i.str.trim()))?.x;
            const recvX = line.items.find((i) => /^Received$/.test(i.str.trim()))?.x;
            const amounts = next.items.map((i) => ({ x: i.x, v: parseRupees(i.str) })).filter((a2): a2 is { x: number; v: number } => a2.v !== null);
            if (sentX !== undefined && recvX !== undefined && amounts.length >= 2) {
              const nearest = (x: number) => amounts.reduce((best, c) => (Math.abs(c.x - x) < Math.abs(best.x - x) ? c : best));
              summary = { sent: nearest(sentX).v, received: nearest(recvX).v };
            } else if (amounts.length === 2) {
              summary = { sent: amounts[0].v, received: amounts[1].v };
            }
          }
        }
        // A transaction row on a page without the table header would silently be lost: refuse instead.
        if (DATE_LINE_RE.test(left)) throw new StatementError("PARSE_FAILED", `Page ${page.page} has transactions but no table header; the statement layout is not recognised. Nothing was imported.`);
        continue; // title / contact line / summary: never transactions
      }

      // ---- footer region: explanatory note, page number
      if (FOOTER_RE.test(whole) || FOOTER_RE.test(mid) || FOOTER_RE.test(left)) {
        continue;
      }
      if (HEADER_RE.test(whole) || HEADER_RE.test(left)) continue;

      if (DATE_LINE_RE.test(left)) {
        cur = { page: page.page, date: left, first: mid, amountText: right, extra: [], lines: [whole], problems: [] };
        blocks.push(cur);
        continue;
      }
      if (!cur) continue; // stray text before the first transaction
      cur.lines.push(whole);
      if (left && TIME_RE.test(left)) cur.time = left;
      else if (left) cur.problems.push(`unexpected text "${left.slice(0, 20)}"`);
      const idm = mid.match(ID_RE);
      const bm = mid.match(BANK_RE);
      if (idm) cur.id = idm[1];
      else if (bm && cur.id) cur.bank = { name: bm[1].trim(), mask: bm[2] };
      else if (mid && !cur.id) cur.extra.push(mid); // counterparty wrapped onto a second line
      else if (mid) cur.problems.push("unexpected text after the transaction id");
      if (right && !cur.amountText) cur.amountText = right;
    }
  }

  if (!blocks.length) throw new StatementError("NO_TRANSACTIONS", "No transactions could be found in this Google Pay statement.");

  const txns: ParsedTransaction[] = [];
  const invalid: string[] = [];
  blocks.forEach((b, idx) => {
    const date = parseStatementDate(b.date);
    const dm = (b.first + (b.extra.length ? " " + b.extra.join(" ") : "")).match(DIRECTION_RE);
    const amount = parseRupees(b.amountText);
    const time = b.time ? to24h(b.time) : null;
    const problems = [...b.problems];
    if (!date) problems.push("date");
    if (!dm) problems.push("direction (expected 'Paid to' or 'Received from')");
    if (amount === null || amount <= 0) problems.push("amount");
    if (!b.id) problems.push("UPI transaction id");
    if (!time) problems.push("time");
    if (problems.length) {
      invalid.push(`row ${idx + 1} on page ${b.page}: ${problems.join(", ")}`);
      return;
    }
    const direction: Direction = /^paid to$/i.test(dm![1]) ? "debit" : "credit";
    const counterparty = dm![2].replace(/\s+/g, " ").trim();
    txns.push({
      date: date!,
      time: time!,
      rawDescription: b.lines.join(" ").replace(/\s+/g, " ").trim(),
      narrationLines: [b.first + (b.extra.length ? " " + b.extra.join(" ") : ""), `UPI Transaction ID: ${b.id}`, ...(b.bank ? [`${direction === "debit" ? "Paid by" : "Paid to"} ${b.bank.name} ${b.bank.mask}`] : [])],
      debit: direction === "debit" ? amount! : 0,
      credit: direction === "credit" ? amount! : 0,
      rawWithdrawal: direction === "debit" ? b.amountText : undefined,
      rawDeposit: direction === "credit" ? b.amountText : undefined,
      rowIndex: idx,
      page: b.page,
      warnings: b.bank ? [] : ["The funding bank line is missing for this row."],
      counterparty,
      providerTxnId: b.id,
      fundingBank: b.bank?.name,
      fundingMask: b.bank?.mask,
    });
  });
  if (invalid.length) {
    // Never import a partially understood statement.
    throw new StatementError("PARSE_FAILED", `Some Google Pay rows could not be read completely (${invalid.slice(0, 3).join("; ")}${invalid.length > 3 ? "; ..." : ""}). Nothing was imported.`);
  }

  // duplicate provider ids inside one statement would be a parsing or export fault
  const ids = new Map<string, number>();
  for (const t of txns) ids.set(t.providerTxnId!, (ids.get(t.providerTxnId!) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) warnings.push(`UPI transaction id ${id.slice(0, 4)}… appears ${n} times in this statement.`);

  const dates = txns.map((t) => t.date).sort();
  if (!period) {
    period = { start: dates[0], end: dates[dates.length - 1] };
    warnings.push("The statement period was not found; it was taken from the first and last transaction dates.");
  } else if (dates[0] < period.start || dates[dates.length - 1] > addDays(period.end, 0)) {
    warnings.push("Some transactions fall outside the statement period printed on the first page.");
  }
  if (!summary) warnings.push("The Sent / Received totals were not found, so this statement cannot be reconciled.");

  const masks = new Map<string, number>();
  for (const t of txns) if (t.fundingMask) masks.set(t.fundingMask, (masks.get(t.fundingMask) ?? 0) + 1);
  const mask = [...masks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNKNOWN";
  if (masks.size > 1) warnings.push(`Payments were made from ${masks.size} different accounts (${[...masks.keys()].join(", ")}).`);

  const statement: ParsedStatement = {
    bank: "GOOGLE_PAY",
    parserVersion: GPAY_PARSER_VERSION,
    account: { mask, type: "UPI wallet statement" },
    period,
    providerSummary: summary,
    transactions: txns,
    warnings,
  };
  statement.reconciliation = reconcileGooglePay(summary, txns.map((t) => ({ direction: t.debit > 0 ? "debit" : "credit", amount: t.debit > 0 ? t.debit : t.credit })));
  return statement;
}
