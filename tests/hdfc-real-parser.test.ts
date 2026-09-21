/**
 * Parser tests against SYNTHETIC statements that reproduce the STRUCTURE of the real HDFC statement:
 * multi-page, repeated customer block / table header / footer on every page, narrations wrapped over
 * several physical lines (word wrap + mid-token hard breaks at 40 chars), separate Chq./Ref.No. and
 * Value Dt columns, dd/mm/yy dates, Indian number formatting, STATEMENT SUMMARY on the last page.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { generateRealHdfcPdf, wrapHdfc, type OfficialFigures, type RealRow } from "../scripts/real-pdf";
import { parseStatementPdf, type ParsedUpload } from "../src/lib/parsers";
import { readPdfPages } from "../src/lib/parsers/pdf-reader";
import { estimateWrapWidth, extractOfficialSummary } from "../src/lib/parsers/hdfc/parser";
import { groupLines, isRowStartLine } from "../src/lib/parsers/hdfc/layout";
import { reconcileStatement } from "../src/lib/parsers/hdfc/reconcile";
import { buildRealStatement, OFFICIAL } from "./real-fixture";
import { round2 } from "../src/lib/util/money";

const { rows: ROWS, official: OFF } = buildRealStatement();
let base: ParsedUpload;

beforeAll(async () => {
  base = await parseStatementPdf(await generateRealHdfcPdf({ rows: ROWS, official: OFF }));
});

function officialOf(opening: number, rows: RealRow[]): OfficialFigures {
  const debits = rows.filter((r) => r.debit > 0);
  const credits = rows.filter((r) => r.credit > 0);
  const totalDebits = round2(debits.reduce((a, r) => a + r.debit, 0));
  const totalCredits = round2(credits.reduce((a, r) => a + r.credit, 0));
  return { openingBalance: opening, debitCount: debits.length, creditCount: credits.length, totalDebits, totalCredits, closingBalance: round2(opening + totalCredits - totalDebits) };
}
function mkRows(opening: number, specs: { day: number; n: string; debit?: number; credit?: number; valueDay?: number }[]): RealRow[] {
  let bal = opening;
  return specs.map((s, i) => {
    bal = round2(bal + (s.credit ?? 0) - (s.debit ?? 0));
    return {
      date: `2026-08-${String(s.day).padStart(2, "0")}`,
      valueDate: `2026-08-${String(s.valueDay ?? s.day).padStart(2, "0")}`,
      narration: s.n,
      reference: "0000" + String(621000000000 + i * 13),
      debit: s.debit ?? 0,
      credit: s.credit ?? 0,
      balance: bal,
    };
  });
}

describe("fixture sanity", () => {
  it("is built to the spec's reconciliation figures", () => {
    expect(OFFICIAL).toEqual({ openingBalance: 29004.97, debitCount: 76, creditCount: 8, totalDebits: 12379.76, totalCredits: 5868, closingBalance: 22493.21 });
    expect(ROWS).toHaveLength(84);
    expect(ROWS.filter((r) => r.debit > 0)).toHaveLength(76);
    expect(ROWS.filter((r) => r.credit > 0)).toHaveLength(8);
    expect(ROWS[0].balance).toBe(28379.97); // 29,004.97 - 625.00, the spec's example row
    expect(round2(29004.97 + 5868 - 12379.76)).toBe(22493.21);
  });
  it("wraps narrations exactly like the examples in the spec", () => {
    expect(wrapHdfc("UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY")).toEqual([
      "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0ME",
      "RUPI-622758185216-PAY VIA RAZORPAY",
    ]);
    expect(wrapHdfc("UPI-RAHUL NEGI-RAKHINEGI634@OKHDFCBANK-PUNB0123456-621331236828-UPI")[0]).toBe("UPI-RAHUL");
  });
});

describe("multi-page statement: transaction reconstruction", () => {
  it("spans many pages and reconstructs EVERY transaction exactly once (84 rows, not one per physical line)", async () => {
    expect(base.pageCount).toBeGreaterThanOrEqual(8);
    expect(base.statement.transactions).toHaveLength(84);
    expect(base.normalized.transactions).toHaveLength(84);
    expect(base.normalized.dropped).toEqual([]);
  });

  it("matches the source row-for-row: date, value date, amount, balance, reference and narration", () => {
    base.normalized.transactions.forEach((n, i) => {
      const s = ROWS[i];
      expect(n.txnDate, `row ${i} date`).toBe(s.date);
      expect(n.valueDate, `row ${i} value date`).toBe(s.valueDate);
      expect(n.amount, `row ${i} amount`).toBe(s.debit || s.credit);
      expect(n.direction).toBe(s.credit > 0 ? "credit" : "debit");
      expect(n.balanceAfter, `row ${i} balance`).toBe(s.balance);
      expect(n.referenceNumber, `row ${i} ref`).toBe(s.reference);
      expect(n.rawDescription, `row ${i} narration`).toBe(s.narration);
    });
  });

  it("never turns headers, customer metadata, footers or summary into transactions", () => {
    const junk = /HDFC BANK LIMITED|Page No|Registered Office|Account Branch|Statement From|Generated On|Cust ID|A\/C Open|IFSC|GSTIN|computer generated|STATEMENT SUMMARY|Opening Balance/i;
    for (const t of base.normalized.transactions) {
      expect(t.rawDescription).not.toMatch(junk);
      expect(t.txnDate.startsWith("2026-08-")).toBe(true); // A/C open date (2019) and generated date (Sep 2026) never leak in
    }
    expect(base.statement.transactions.some((t) => t.date < "2026-08-01" || t.date > "2026-08-31")).toBe(false);
  });

  it("preserves the original narration line breaks AND a re-joined normalised narration", () => {
    const blinkit = base.normalized.transactions.find((t) => t.rawDescription.includes("BLINKIT.RZP@HDFCBANK") && t.referenceNumber === "0000622758185216")!;
    expect(blinkit.rawNarration.split("\n")).toEqual(["UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0ME", "RUPI-622758185216-PAY VIA RAZORPAY"]);
    expect(blinkit.rawDescription).toBe("UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY"); // hard break rejoined without a space
    expect(blinkit.normalizedNarration).toBe("UPI BLINKIT BLINKIT RZP HDFCBANK HDFC0MERUPI 622758185216 PAY VIA RAZORPAY");
    const rahul = base.normalized.transactions[0];
    expect(rahul.rawNarration.split("\n")[0]).toBe("UPI-RAHUL"); // word wrap: rejoined WITH a space
    expect(rahul.rawDescription).toContain("UPI-RAHUL NEGI-RAKHINEGI634@OKHDFCBANK");
    expect(rahul.rawNarration.split("\n").length).toBeGreaterThan(1);
  });

  it("extracts the Chq./Ref.No. column independently, verbatim, and keeps it out of the narration", () => {
    const first = base.normalized.transactions[0];
    expect(first.referenceNumber).toBe("0000621331236828");
    expect(first.rawDescription).not.toContain("0000621331236828");
    for (const t of base.normalized.transactions) {
      expect(t.referenceNumber).toMatch(/^0000\d{12}$/);
      expect(t.rawDescription).not.toContain(t.referenceNumber!);
    }
    // the 12-digit UPI RRN inside the narration is a DIFFERENT field
    expect(first.upiReference).toBe("620000007919");
    expect(first.upiReference).not.toBe(first.referenceNumber);
  });

  it("keeps transaction date and value date separate (25/08/26 -> 26/08/26)", () => {
    const differing = base.normalized.transactions.filter((t) => t.valueDate !== t.txnDate);
    expect(differing).toHaveLength(1);
    expect(differing[0]).toMatchObject({ txnDate: "2026-08-25", valueDate: "2026-08-26", amount: 180 });
    expect(base.normalized.transactions.filter((t) => t.valueDate === t.txnDate)).toHaveLength(83);
  });

  it("never populates both debit and credit; keeps the original extracted amount strings", () => {
    for (const t of base.normalized.transactions) expect(t.debit > 0 && t.credit > 0).toBe(false);
    const p = base.statement.transactions[0];
    expect(p.rawWithdrawal).toBe("625.00");
    expect(p.rawDeposit).toBeUndefined();
    expect(p.rawBalance).toBe("28,379.97");
    const credit = base.statement.transactions.find((t) => t.credit > 0)!;
    expect(credit.rawDeposit).toMatch(/^[\d,]+\.\d{2}$/);
    expect(credit.rawWithdrawal).toBeUndefined();
  });

  it("verifies previous balance + credit − debit = current balance for every row", () => {
    let prev = OFF.openingBalance;
    for (const t of base.normalized.transactions) {
      expect(round2(prev + t.credit - t.debit)).toBe(t.balanceAfter);
      prev = t.balanceAfter!;
    }
    expect(prev).toBe(OFF.closingBalance);
  });

  it("copes with Indian number formatting (lakhs grouping) in amounts and balances", async () => {
    const rows = mkRows(1234567.89, [{ day: 1, n: "UPI-SOMEONE-X@YBL-YESB0YBLUPI-621111111111-UPI", debit: 100000.5 }, { day: 2, n: "NEFT CR-HDFC0000001-ACME LTD-SALARY", credit: 2500000 }]);
    const r = await parseStatementPdf(await generateRealHdfcPdf({ rows, official: officialOf(1234567.89, rows) }));
    expect(r.normalized.transactions.map((t) => t.amount)).toEqual([100000.5, 2500000]);
    expect(r.normalized.transactions.at(-1)!.balanceAfter).toBe(rows[1].balance);
    expect(r.statement.reconciliation?.status).toBe("reconciled");
  });
});

describe("statement summary and reconciliation", () => {
  it("extracts the OFFICIAL summary as its own object", () => {
    expect(base.statement.summary).toEqual({ openingBalance: 29004.97, debitCount: 76, creditCount: 8, totalDebits: 12379.76, totalCredits: 5868, closingBalance: 22493.21 });
    expect(base.statement.openingBalance).toBe(29004.97);
    expect(base.statement.closingBalance).toBe(22493.21);
  });

  it("independently calculates from the parsed rows and reports a full match", () => {
    const rec = base.statement.reconciliation!;
    expect(rec.status).toBe("reconciled");
    expect(rec.calculated).toMatchObject({ debitCount: 76, creditCount: 8, totalDebits: 12379.76, totalCredits: 5868, closingFromFlow: 22493.21, lastRowBalance: 22493.21, openingBalance: 29004.97 });
    expect(rec.checks.filter((c) => c.ok === false)).toEqual([]);
    expect(rec.checks.map((c) => c.key)).toEqual(expect.arrayContaining(["debitCount", "creditCount", "totalDebits", "totalCredits", "officialIdentity", "calculatedClosing", "lastRowBalance", "balanceChain"]));
    expect(rec.balanceChain).toMatchObject({ checked: 84, corrections: 0 });
    expect(rec.balanceChain.breaks).toEqual([]);
    expect(rec.issues).toEqual([]);
    expect(base.statement.warnings).toEqual([]);
  });

  it("opening + credits − debits = closing (29004.97 + 5868.00 − 12379.76 = 22493.21) and fails if the parser drifts", () => {
    const s = base.statement;
    expect(round2(s.summary!.openingBalance + s.summary!.totalCredits - s.summary!.totalDebits)).toBe(22493.21);
    const drifted = structuredClone(s);
    drifted.transactions[10].debit = round2(drifted.transactions[10].debit + 0.5);
    const rec = reconcileStatement(drifted);
    expect(rec.status).toBe("mismatch");
    expect(rec.checks.find((c) => c.key === "totalDebits")?.ok).toBe(false);
    expect(rec.issues.join(" ")).toMatch(/Total debits/);
  });

  it("flags a missing row via counts, totals and the balance chain", async () => {
    const drop = ROWS.findIndex((r, i) => i >= 40 && r.debit > 0);
    const missing = ROWS.filter((_, i) => i !== drop);
    const r = await parseStatementPdf(await generateRealHdfcPdf({ rows: missing, official: OFF })); // summary still the FULL statement's
    const rec = r.statement.reconciliation!;
    expect(rec.status).toBe("mismatch");
    expect(rec.checks.filter((c) => c.ok === false).map((c) => c.key)).toEqual(expect.arrayContaining(["totalDebits", "calculatedClosing"]));
    expect(rec.balanceChain.breaks.length).toBeGreaterThan(0);
    expect(r.statement.warnings.join(" ")).toMatch(/does not follow|break/i);
  });

  it("reports a tampered official summary as a mismatch (and does not silently trust either side)", async () => {
    const r = await parseStatementPdf(await generateRealHdfcPdf({ rows: ROWS, official: { ...OFF, debitCount: 75, totalDebits: 12379.86 } }));
    const rec = r.statement.reconciliation!;
    expect(rec.status).toBe("mismatch");
    expect(rec.checks.find((c) => c.key === "debitCount")).toMatchObject({ ok: false, official: 75, calculated: 76 });
    expect(rec.checks.find((c) => c.key === "totalDebits")?.ok).toBe(false);
  });

  it("without a summary block: status no_summary, chain still verified, closing derived", async () => {
    const r = await parseStatementPdf(await generateRealHdfcPdf({ rows: ROWS, official: OFF, omitSummary: true }));
    const rec = r.statement.reconciliation!;
    expect(rec.status).toBe("no_summary");
    expect(rec.official).toBeNull();
    expect(rec.balanceChain.breaks).toEqual([]);
    expect(rec.calculated.lastRowBalance).toBe(22493.21);
    expect(r.statement.warnings.join(" ")).toMatch(/summary/i);
  });

  it("extractOfficialSummary handles the label row and value row on separate lines", async () => {
    const pages = await readPdfPages(await generateRealHdfcPdf({ rows: ROWS, official: OFF }));
    const lines = pages.flatMap((p) => groupLines(p));
    expect(extractOfficialSummary(lines)).toEqual(OFF);
    expect(extractOfficialSummary(lines.filter((l) => !/summary/i.test(l.text)))).toBeUndefined();
  });
});

describe("page breaks, repeated headers and footers", () => {
  it("has the table header, customer metadata and footer repeated on every page", async () => {
    const pages = await readPdfPages(await generateRealHdfcPdf({ rows: ROWS, official: OFF }));
    for (const p of pages) {
      const text = p.items.map((i) => i.str).join(" ");
      expect(text).toContain("Chq./Ref.No.");
      expect(text).toContain("Account Branch");
      expect(text).toContain("Registered Office");
      expect(text).toContain("Generated On");
    }
  });

  it("a narration split ACROSS a page boundary is still ONE transaction", async () => {
    const rows = mkRows(5000, [
      { day: 1, n: "UPI-SHOP ONE-SHOPONE@YBL-YESB0YBLUPI-621000000001-UPI", debit: 10 }, // 3 lines: filler
      { day: 2, n: "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY", debit: 266 },
      { day: 3, n: "UPI-ZEPTO-ZEPTO.RZP@HDFCBANK-HDFC0MERUPI-622758185217-PAY VIA RAZORPAY", debit: 99 },
    ]);
    // 2 body lines per page: transaction 2's second line lands at the TOP of the next page, after the repeated header
    const pdf = await generateRealHdfcPdf({ rows, official: officialOf(5000, rows), linesPerPage: 2 });
    const pages = await readPdfPages(pdf);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const r = await parseStatementPdf(pdf);
    expect(r.normalized.transactions).toHaveLength(3);
    r.normalized.transactions.forEach((t, i) => {
      expect(t.rawDescription).toBe(rows[i].narration);
      expect(t.balanceAfter).toBe(rows[i].balance);
    });
    expect(r.normalized.transactions[1].rawNarration.split("\n")).toHaveLength(2);
    expect(r.statement.reconciliation?.status).toBe("reconciled");
  });

  it("first page line of a page after a break is a continuation, not a new transaction", async () => {
    const rows = mkRows(5000, [{ day: 2, n: "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY", debit: 266 }]);
    const pages = await readPdfPages(await generateRealHdfcPdf({ rows, official: officialOf(5000, rows), linesPerPage: 1 }));
    const bodyStarts = pages.flatMap((p) => groupLines(p)).filter(isRowStartLine);
    expect(bodyStarts).toHaveLength(1); // only ONE line begins a transaction although the narration spans 2 pages
  });

  it("transaction ending exactly at the bottom of a page and the next beginning at the top", async () => {
    const specs = Array.from({ length: 9 }, (_, i) => ({ day: 1 + i, n: `UPI-MERCHANT ${i}-M${i}@YBL-YESB0YBLUPI-62100000${String(i).padStart(4, "0")}-UPI`, debit: 10 + i }));
    const rows = mkRows(1000, specs);
    for (const linesPerPage of [2, 3, 4, 5]) {
      const r = await parseStatementPdf(await generateRealHdfcPdf({ rows, official: officialOf(1000, rows), linesPerPage }));
      expect(r.normalized.transactions.map((t) => t.rawDescription)).toEqual(rows.map((x) => x.narration));
      expect(r.statement.reconciliation?.status).toBe("reconciled");
    }
  });

  it("does not depend on how the header labels are aligned (left vs centred)", async () => {
    const left = await parseStatementPdf(await generateRealHdfcPdf({ rows: ROWS, official: OFF, centeredHeaders: false }));
    expect(left.normalized.transactions.map((t) => t.rawDescription)).toEqual(base.normalized.transactions.map((t) => t.rawDescription));
    expect(left.statement.reconciliation?.status).toBe("reconciled");
  });

  it("is stable when the bank changes the wrap width (30 / 40 / 50 chars)", async () => {
    for (const wrapWidth of [30, 40, 50]) {
      const r = await parseStatementPdf(await generateRealHdfcPdf({ rows: ROWS, official: OFF, wrapWidth }));
      expect(r.normalized.transactions, `wrap ${wrapWidth}`).toHaveLength(84);
      expect(r.statement.reconciliation?.status, `wrap ${wrapWidth}`).toBe("reconciled");
      // amounts/balances/references never depend on wrapping
      expect(r.normalized.transactions.map((t) => t.referenceNumber)).toEqual(ROWS.map((x) => x.reference));
    }
  });
});

describe("wrap-width estimation", () => {
  it("uses the most common chunk length; a lone word-wrapped line is not mistaken for a hard break", () => {
    const hard = Array(6).fill("X".repeat(40));
    expect(estimateWrapWidth([...hard, "UPI-RAHUL", "SOME WORDS HERE 34 chars ok....."])).toBe(40);
    expect(estimateWrapWidth(["A".repeat(38), "UPI-RAHUL", "B".repeat(31)])).toBe(0); // no evidence of hard breaks
    expect(estimateWrapWidth([])).toBe(0);
  });
});
