/**
 * HDFC statement parser. Two strategies, tried in order:
 *  1. TABLE   - transaction boundaries come from the DATE column; column geometry is calibrated
 *               from the data rows (handles wrapped narrations, page breaks, repeated headers and
 *               footers, header alignment differences).
 *  2. TEXT    - line-regex fallback for statements without a detectable header.
 * Afterwards the running balances are used to check/repair debit-vs-credit, the bank's own
 * "STATEMENT SUMMARY" is extracted, and everything is reconciled (see reconcile.ts).
 *
 * Structural rules that keep non-transactions out:
 *  - a transaction starts only on a line whose LEFTMOST item is a real date AND that carries an amount;
 *  - anything before the table header on a page (customer block, statement period, branch...) is skipped;
 *  - a line with text in the DATE column that is not a row start is a footer/metadata line and ends
 *    the table region for that page (HDFC BANK LIMITED, Page No, Registered Office, GST, Generated On ...);
 *  - "STATEMENT SUMMARY" ends the table for good.
 */
import { parseAmount, round2 } from "../../util/money";
import type { OfficialSummary, ParsedStatement, ParsedTransaction } from "../../domain/types";
import type { PdfPage } from "../pdf-reader";
import { DATE_ANYWHERE_RE, parseStatementDate } from "./dates";
import { assignCells, calibrateHeader, DECIMAL_AMOUNT_RE, findHeader, groupLines, hasTextInDateColumn, isRowStartLine, type HeaderLayout, type Line } from "./layout";
import { reconcileStatement } from "./reconcile";

export const HDFC_PARSER_VERSION = "2.0.0";

/** Footer phrases that can appear away from the left margin (e.g. a right-aligned page number). */
export const FOOTER_RE =
  /page\s*no|page\s+\d+\s+of\s+\d+|generated\s*(on|by)|requesting\s*branch|registered\s*office|computer\s*generated|hdfc\s*bank\s*(limited|ltd)|contents\s*of\s*this\s*statement|\bgstn\b|synthetic\s*sample/i;

/**
 * Broad header/footer metadata vocabulary (customer block, branch, account facts, footer). Structural
 * patterns only - no personal data is hard-coded. Used only by the header-less text fallback, where
 * there is no geometry to tell metadata from narration.
 */
export const METADATA_RE =
  /page\s*no|page\s+\d+\s+of\s+\d+|generated\s*(on|by)|requesting\s*branch|registered\s*office|computer\s*generated|statement\s*of\s*account|hdfc\s*bank\s*(limited|ltd)|^continued|closing\s*balance\s*includes|contents\s*of\s*this\s*statement|state\s*account\s*branch|\bgstn?\b|\bgst\s*(no|in|number)|nomination|\bjoint\s*holders?\b|account\s*(branch|status|type|no|open)|a\/c\s*open|\bcust(omer)?\s*id\b|\bifsc\b|\bmicr\b|branch\s*code|\bcurrency\b|\be-?mail\b|\bphone\b|\bcity\b|\bstate\s*:|synthetic\s*sample/i;
const END_RE = /statement\s*summary|end\s*of\s*statement|\*+\s*end/i;

interface RawRow {
  date: string;
  valueDate?: string;
  narration: string[];
  ref: string[];
  debit?: string;
  credit?: string;
  balance?: string;
  page: number;
}

/**
 * HDFC wraps narrations at a fixed character width. A token longer than the line is hard-broken
 * mid-token (join WITHOUT a space); otherwise the wrap happens at a space (join WITH a space).
 * A chunk as long as the document's wrap width is a hard break.
 */
function joinNarration(parts: string[], wrapWidth: number): string {
  let out = "";
  parts.forEach((p, i) => {
    if (i === 0) {
      out = p;
      return;
    }
    const prev = parts[i - 1];
    const hardWrap = wrapWidth > 0 && prev.trimEnd().length >= wrapWidth && !/\s$/.test(prev) && !/^\s/.test(p);
    out += hardWrap ? p : " " + p;
  });
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The bank's hard-wrap width = the MOST COMMON length among narration chunks that are followed by
 * another chunk (hard-broken lines all have exactly that length; word-wrapped lines vary). Needs at
 * least two chunks of that length, otherwise we cannot tell a hard break from a word wrap and every
 * join uses a space.
 */
export function estimateWrapWidth(nonFinalChunks: string[]): number {
  const freq = new Map<number, number>();
  for (const c of nonFinalChunks) {
    const len = c.trimEnd().length;
    if (len >= 20) freq.set(len, (freq.get(len) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [len, n] of freq) if (n > bestN || (n === bestN && len > best)) [best, bestN] = [len, n];
  return bestN >= 2 ? best : 0;
}

function toParsed(r: RawRow, wrapWidth: number, rowIndex: number): ParsedTransaction | null {
  const date = parseStatementDate(r.date);
  if (!date) return null;
  const warnings: string[] = [];
  const d = r.debit ? parseAmount(r.debit) : null;
  const c = r.credit ? parseAmount(r.credit) : null;
  const b = r.balance ? parseAmount(r.balance) : null;
  const debit = d?.value ?? 0;
  const credit = c?.value ?? 0;
  if (debit > 0 && credit > 0) warnings.push("Both debit and credit present in one row");
  if (debit === 0 && credit === 0) warnings.push("No amount found in row");
  let balance = b?.value;
  if (b && b.sign === "dr" && balance !== undefined) balance = -balance; // overdrawn balance
  const valueDate = r.valueDate ? parseStatementDate(r.valueDate) ?? undefined : undefined;
  if (r.valueDate && !valueDate) warnings.push("Value date could not be read");
  const lines = r.narration.map((n) => n.trim()).filter(Boolean);
  return {
    date,
    valueDate,
    rawDescription: joinNarration(r.narration, wrapWidth),
    narrationLines: lines,
    reference: r.ref.join("").replace(/\s+/g, "").trim() || undefined,
    debit: round2(debit),
    credit: round2(credit),
    rawWithdrawal: r.debit,
    rawDeposit: r.credit,
    rawBalance: r.balance,
    balance,
    rowIndex,
    warnings,
  };
}

/* ------------------------------ TABLE strategy ------------------------------ */

function parseTable(pages: PdfPage[]): { rows: ParsedTransaction[]; lines: Line[] } {
  const allLines: Line[] = [];
  const rows: RawRow[] = [];
  let baseHeader: HeaderLayout | null = null;
  let lastCalibrated: HeaderLayout | null = null;
  let current: RawRow | null = null;
  let ended = false;

  for (const page of pages) {
    const lines = groupLines(page);
    allLines.push(...lines);
    if (ended) continue;
    const found = findHeader(lines);
    if (found) baseHeader = found; // repeated headers refresh the geometry
    if (!baseHeader) continue;
    let header = calibrateHeader(lines, baseHeader);
    // A page can hold ONLY the tail of a narration that started on the previous page (no row-start line
    // to calibrate from). Carry the geometry calibrated on an earlier page instead of falling back to the
    // header labels, whose alignment says nothing about where the data sits.
    if (header.calibrated) lastCalibrated = header;
    else if (lastCalibrated) header = lastCalibrated;
    let footer = false;

    for (let i = found ? found.lineIndex + 1 : 0; i < lines.length; i++) {
      const line = lines[i];
      if (END_RE.test(line.text)) {
        ended = true;
        break;
      }
      if (isRowStartLine(line)) {
        footer = false;
        const cells = assignCells({ ...line, items: line.items.slice(1) }, header);
        current = {
          date: line.items[0].str.trim(),
          valueDate: cells.valueDate,
          narration: cells.narration ? [cells.narration] : [],
          ref: cells.ref ? [cells.ref] : [],
          debit: cells.debit,
          credit: cells.credit,
          balance: cells.balance,
          page: page.page,
        };
        rows.push(current);
        continue;
      }
      if (footer || !current) continue;
      // Text sitting in the DATE column that is not a date = footer / metadata block, not a wrapped narration.
      // (Only trusted when the column geometry was calibrated from real rows on this page.)
      if ((header.calibrated && hasTextInDateColumn(line, header)) || FOOTER_RE.test(line.text)) {
        footer = true;
        continue;
      }
      const cells = assignCells(line, header);
      if (cells.narration) current.narration.push(cells.narration);
      if (cells.ref) current.ref.push(cells.ref);
      if (!current.balance && cells.balance) current.balance = cells.balance;
      if (!current.debit && !current.credit && (cells.debit || cells.credit)) {
        current.debit = cells.debit;
        current.credit = cells.credit;
      }
      if (!current.valueDate && cells.valueDate) current.valueDate = cells.valueDate;
    }
  }

  const wrapWidth = estimateWrapWidth(rows.flatMap((r) => r.narration.slice(0, -1)));
  const parsed: ParsedTransaction[] = [];
  for (const r of rows) {
    const p = toParsed(r, wrapWidth, parsed.length);
    if (p) parsed.push(p);
  }
  return { rows: parsed, lines: allLines };
}

/* ------------------------------ TEXT fallback ------------------------------ */

const CREDIT_HINT_RE = /\b(NEFT CR|IMPS CR|RTGS CR|CR-|SALARY|REFUND|REVERSAL|CREDIT INTEREST|INT\.?\s?PD|DEPOSIT|CASHBACK|ACH C)\b/i;
const LEAD_DATE_RE = /^(\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})|\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-,]+(?:\d{4}|\d{2}))\s+(.*)$/;

function parseTextFallback(pages: PdfPage[]): { rows: ParsedTransaction[]; lines: Line[] } {
  const lines: Line[] = pages.flatMap((p) => groupLines(p));
  const rows: ParsedTransaction[] = [];
  let cur: { date: string; parts: string[]; nums: string[]; page: number } | null = null;

  const flush = () => {
    if (!cur) return;
    const nums = cur.nums;
    const desc = cur.parts.join(" ").replace(/\s+/g, " ").trim();
    const date = parseStatementDate(cur.date);
    if (date && nums.length >= 1) {
      const balance = nums.length >= 2 ? parseAmount(nums[nums.length - 1]) : null;
      const amount = parseAmount(nums.length >= 2 ? nums[nums.length - 2] : nums[0]);
      if (amount) {
        rows.push({
          date,
          rawDescription: desc,
          narrationLines: [desc],
          debit: round2(amount.value),
          credit: 0,
          balance: balance?.value,
          rowIndex: rows.length,
          page: cur.page,
          warnings: ["Parsed with text fallback: debit/credit inferred", ...(CREDIT_HINT_RE.test(desc) ? ["credit-hint"] : [])],
        });
      }
    }
    cur = null;
  };

  for (const line of lines) {
    if (END_RE.test(line.text)) {
      flush();
      break;
    }
    const lead = line.text.match(LEAD_DATE_RE);
    if (lead && parseStatementDate(lead[1]) && lead[2].split(" ").some((t) => DECIMAL_AMOUNT_RE.test(t))) {
      flush();
      const nums: string[] = [];
      const rest: string[] = [];
      for (const t of lead[2].split(" ")) (DECIMAL_AMOUNT_RE.test(t) ? nums : rest).push(t);
      cur = { date: lead[1], parts: rest, nums, page: line.page };
    } else if (cur && !METADATA_RE.test(line.text)) {
      for (const t of line.text.split(" ")) {
        if (DECIMAL_AMOUNT_RE.test(t) && cur.nums.length < 3) cur.nums.push(t);
        else cur.parts.push(t);
      }
    }
  }
  flush();

  // Resolve direction using balance continuity, else keyword hints.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1].balance : undefined;
    let credit = false;
    if (r.balance !== undefined && prev !== undefined) credit = Math.abs(round2(r.balance - prev) - r.debit) < 0.011;
    else credit = r.warnings.includes("credit-hint");
    r.warnings = r.warnings.filter((w) => w !== "credit-hint");
    if (credit) {
      r.credit = r.debit;
      r.debit = 0;
    }
  }
  return { rows, lines };
}

/* ------------------------------ metadata & summary ------------------------------ */

const NUM_TOKEN_RE = /^\(?-?[\d,]+(?:\.\d+)?\)?(?:\s?(?:Cr|Dr)\.?)?$/i;

/**
 * Extract the bank's STATEMENT SUMMARY block: Opening Balance, Dr Count, Cr Count, Debits,
 * Credits, Closing Bal. The label row and value row may be laid out on one or several lines;
 * we take the first six numbers after the heading and require the count fields to be integers.
 */
export function extractOfficialSummary(lines: Line[]): OfficialSummary | undefined {
  const idx = lines.findIndex((l) => /statement\s*summary/i.test(l.text));
  if (idx < 0) return undefined;
  const nums: string[] = [];
  for (let i = idx; i < Math.min(idx + 6, lines.length) && nums.length < 6; i++) {
    const text = i === idx ? lines[i].text.replace(/.*statement\s*summary\s*:?-?/i, "") : lines[i].text;
    if (i > idx && /generated|registered|computer/i.test(text)) break;
    for (const tok of text.split(" ")) if (NUM_TOKEN_RE.test(tok) && /\d/.test(tok) && nums.length < 6) nums.push(tok);
  }
  if (nums.length < 6) return undefined;
  const isInt = (t: string) => /^\d+$/.test(t.replace(/,/g, ""));
  if (!isInt(nums[1]) || !isInt(nums[2])) return undefined;
  const v = nums.map((t) => parseAmount(t)?.value);
  if (v.some((x) => x === undefined)) return undefined;
  return { openingBalance: v[0]!, debitCount: v[1]!, creditCount: v[2]!, totalDebits: v[3]!, totalCredits: v[4]!, closingBalance: v[5]! };
}

function extractMetadata(lines: Line[]) {
  const text = lines.map((l) => l.text).join("\n");
  let mask = "UNKNOWN";
  const acct = text.match(/Account\s*(?:No|Number|#)\.?\s*[:\-]?\s*([Xx*\d][Xx*\d ]{3,24})/i);
  if (acct) {
    const digits = acct[1].replace(/[^0-9]/g, "");
    if (digits.length >= 4) mask = digits.slice(-4); // only the last 4 digits are ever kept
  }
  const typeMatch = text.match(/Account\s*Type\s*[:\-]?\s*([A-Za-z ]{3,40}?)(?=\s{2,}|\n|$|Statement)/i);
  const period = text.match(
    new RegExp(`(?:Statement\\s*(?:From|Period)|Period)\\s*[:\\-]?\\s*${DATE_ANYWHERE_RE.source}\\s*(?:To|-|to)\\s*:?\\s*${DATE_ANYWHERE_RE.source}`, "i"),
  );
  let periodOut: { start: string; end: string } | undefined;
  if (period) {
    const a = parseStatementDate(period[1]);
    const b = parseStatementDate(period[2]);
    if (a && b) periodOut = { start: a, end: b };
  }
  return { mask, type: typeMatch?.[1].trim(), period: periodOut, summary: extractOfficialSummary(lines) };
}

/** Use running balances to repair the debit/credit side and infer missing amounts. Every repair is flagged. */
function repairWithBalances(rows: ParsedTransaction[], opening?: number) {
  let prev = opening;
  for (const r of rows) {
    if (r.balance === undefined) continue;
    if (prev !== undefined) {
      const delta = round2(r.balance - prev);
      const amount = r.debit > 0 ? r.debit : r.credit;
      const signed = r.credit - r.debit;
      if (Math.abs(delta - signed) > 0.011) {
        if (amount > 0 && Math.abs(Math.abs(delta) - amount) < 0.011) {
          // Same magnitude, other side: the running balance proves the direction.
          if (delta > 0) {
            r.credit = amount;
            r.debit = 0;
          } else {
            r.debit = amount;
            r.credit = 0;
          }
          r.warnings.push("Debit/credit side corrected using running balance");
        } else if (amount === 0 && delta !== 0) {
          if (delta > 0) r.credit = Math.abs(delta);
          else r.debit = Math.abs(delta);
          r.warnings.push("Amount inferred from balance change");
        }
        // otherwise: left as-is; reconcile.ts reports the chain break.
      }
    }
    prev = r.balance;
  }
}

export function parseHdfcPages(pages: PdfPage[]): ParsedStatement {
  const warnings: string[] = [];
  let result = parseTable(pages);
  let usedFallback = false;
  if (result.rows.length === 0) {
    result = parseTextFallback(pages);
    usedFallback = true;
    if (result.rows.length) warnings.push("No table header detected; used the text fallback parser. Please review the preview carefully.");
  }

  const meta = extractMetadata(result.lines);
  const rows = result.rows;

  let opening = meta.summary?.openingBalance;
  if (opening === undefined && rows.length && rows[0].balance !== undefined) opening = round2(rows[0].balance - rows[0].credit + rows[0].debit);
  repairWithBalances(rows, meta.summary?.openingBalance);
  rows.forEach((r, i) => (r.rowIndex = i));

  let closing = meta.summary?.closingBalance;
  if (closing === undefined) closing = [...rows].reverse().find((r) => r.balance !== undefined)?.balance;

  const dates = rows.map((r) => r.date).sort();
  const period = meta.period ?? (dates.length ? { start: dates[0], end: dates[dates.length - 1] } : undefined);

  const statement: ParsedStatement = {
    bank: "HDFC",
    parserVersion: HDFC_PARSER_VERSION,
    account: { mask: meta.mask, type: meta.type },
    period,
    openingBalance: opening,
    closingBalance: closing,
    summary: meta.summary,
    transactions: rows,
    warnings,
  };
  const reconciliation = reconcileStatement(statement);
  statement.reconciliation = reconciliation;
  if (usedFallback && reconciliation.status === "no_summary") reconciliation.issues.push("Parsed with the fallback strategy - verify every row.");
  statement.warnings.push(...reconciliation.issues);
  const flagged = rows.filter((r) => r.warnings.length).length;
  if (flagged) statement.warnings.push(`${flagged} row(s) have parsing warnings. Review them in the preview.`);
  return statement;
}
