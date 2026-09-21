/**
 * Generator for SYNTHETIC statements that reproduce the STRUCTURE of a real HDFC savings-account
 * statement (multi-page, repeated customer block + table header + footer on every page, narrations
 * wrapped over several physical lines with mid-token hard breaks, separate Chq./Ref.No. and Value Dt
 * columns, dd/mm/yy dates, Indian number formatting, STATEMENT SUMMARY on the last page).
 * Dev/test only. Contains NO real personal or financial data.
 */
import PDFDocument from "pdfkit";
import type { ISODate } from "../src/lib/util/dates";

export interface RealRow {
  date: ISODate;
  valueDate: ISODate;
  narration: string;
  /** Chq./Ref.No. column, verbatim (e.g. "0000621331236828"). */
  reference: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface OfficialFigures {
  openingBalance: number;
  debitCount: number;
  creditCount: number;
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
}

export const fmtIndian = (n: number) => {
  const [i, d] = n.toFixed(2).split(".");
  const head = i.slice(0, -3);
  const tail = i.slice(-3);
  return `${head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail : tail}.${d}`;
};
const ddmmyy = (d: ISODate) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;

/**
 * HDFC-style narration wrapping at `width` characters: wrap at spaces; a token longer than the
 * line starts on a fresh line and is hard-broken at `width`. Example (width 40):
 *   "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY"
 *   -> ["UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0ME", "RUPI-622758185216-PAY VIA RAZORPAY"]
 */
export function wrapHdfc(text: string, width = 40): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const raw of text.split(" ")) {
    let token = raw;
    if (!token) continue;
    if (token.length > width) {
      // a token that cannot fit on any line: fresh line, then hard-break at the column width
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      while (token.length > width) {
        lines.push(token.slice(0, width));
        token = token.slice(width);
      }
      cur = token; // the remainder continues on its own line and is joined by the following words
      continue;
    }
    if (!cur) cur = token;
    else if (cur.length + 1 + token.length <= width) cur += " " + token;
    else {
      lines.push(cur);
      cur = token;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

export interface RealPdfOptions {
  rows: RealRow[];
  official: OfficialFigures;
  /** Physical text lines of table body per page (controls how many pages the statement spans). */
  linesPerPage?: number;
  password?: string;
  wrapWidth?: number;
  /** Centre the "Narration" header label over its column instead of left-aligning it. */
  centeredHeaders?: boolean;
  /** Omit the STATEMENT SUMMARY block (to test the no-summary path). */
  omitSummary?: boolean;
}

const X = { date: 36, narr: 84, ref: 268, val: 340, wd: 392, dep: 458, bal: 520 };
const W = { wd: 60, dep: 58, bal: 60 };

export function generateRealHdfcPdf(opts: RealPdfOptions): Promise<Buffer> {
  const wrapWidth = opts.wrapWidth ?? 40;
  const linesPerPage = opts.linesPerPage ?? 27;
  const doc = new PDFDocument({
    size: "A4",
    margin: 36,
    ...(opts.password ? { userPassword: opts.password, ownerPassword: opts.password + "-o", pdfVersion: "1.6" as const } : {}),
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const lineH = 11;
  let page = 0;
  let used = 0; // body lines used on this page
  let y = 0;

  const header = () => {
    page++;
    doc.font("Helvetica-Bold").fontSize(9).text("HDFC BANK LIMITED", 36, 30);
    doc.font("Helvetica").fontSize(7);
    doc.text(`Page No .: ${page}`, 500, 30);
    doc.text("SYNTHETIC TEST STATEMENT - NOT A REAL BANK DOCUMENT", 36, 42);
    doc.text("Statement of account", 36, 54);
    // repeated customer / branch / account block (synthetic values, structure only)
    doc.text("MR SAMPLE CUSTOMER (DEMO)", 36, 68);
    doc.text("12 EXAMPLE STREET, DEMO CITY", 36, 77);
    doc.text("DEMO STATE 560001", 36, 86);
    doc.text("Account Branch : SAMPLE BRANCH", 36, 98);
    doc.text("Address : 1 BRANCH ROAD, DEMO CITY", 36, 107);
    doc.text("City : DEMO CITY   State : DEMO STATE", 36, 116);
    doc.text("Phone no. : 0000000000", 36, 125);
    doc.text("Currency : INR", 360, 68);
    doc.text("Email : demo@example.invalid", 360, 77);
    doc.text("Cust ID : 000000000", 360, 86);
    doc.text("Account No : 50100123456789    A/C Open Date : 12/03/2019", 360, 98);
    doc.text("Account Status : Regular", 360, 107);
    doc.text("IFSC : HDFC0000001   MICR : 000000000", 360, 116);
    doc.text("Branch Code : 0001   Account Type : SAVINGS", 360, 125);
    doc.text("Statement From : 01/08/2026 To : 31/08/2026", 360, 134);
    const yh = 150;
    doc.font("Helvetica-Bold").fontSize(7);
    doc.text("Date", X.date, yh, { lineBreak: false });
    doc.text("Narration", opts.centeredHeaders === false ? X.narr : 140, yh, { lineBreak: false });
    doc.text("Chq./Ref.No.", X.ref, yh, { lineBreak: false });
    doc.text("Value Dt", X.val, yh, { lineBreak: false });
    doc.text("Withdrawal Amt.", X.wd, yh, { lineBreak: false });
    doc.text("Deposit Amt.", X.dep, yh, { lineBreak: false });
    doc.text("Closing Balance", X.bal, yh, { lineBreak: false });
    doc.moveTo(36, yh + 10).lineTo(580, yh + 10).stroke();
    doc.font("Helvetica").fontSize(7);
    y = yh + 18;
    used = 0;
  };

  const footer = () => {
    doc.font("Helvetica").fontSize(6.5);
    doc.text("HDFC BANK LIMITED", 36, 745);
    doc.text("Registered Office Address: SAMPLE HOUSE, DEMO ROAD, MUMBAI 400013", 36, 754);
    doc.text("HDFC Bank GSTIN: 00XXXXX0000X0X0   State Account Branch GSTN: 00XXXXX0000X0X0", 36, 763);
    doc.text("Generated On: 01/09/2026 09:00:00   Generated By: DEMO   Requesting Branch Code: 0001", 36, 772);
    doc.text("This is a computer generated statement and does not require signature.", 36, 781);
    doc.font("Helvetica").fontSize(7);
  };

  const newPage = () => {
    footer();
    doc.addPage();
    header();
  };

  header();
  for (const r of opts.rows) {
    const lines = wrapHdfc(r.narration, wrapWidth);
    lines.forEach((ln, i) => {
      if (used >= linesPerPage) newPage(); // a transaction may be split across pages
      if (i === 0) {
        doc.text(ddmmyy(r.date), X.date, y, { lineBreak: false });
        doc.text(r.reference, X.ref, y, { lineBreak: false });
        doc.text(ddmmyy(r.valueDate), X.val, y, { lineBreak: false });
        if (r.debit > 0) doc.text(fmtIndian(r.debit), X.wd, y, { width: W.wd, align: "right", lineBreak: false });
        if (r.credit > 0) doc.text(fmtIndian(r.credit), X.dep, y, { width: W.dep, align: "right", lineBreak: false });
        doc.text(fmtIndian(r.balance), X.bal, y, { width: W.bal, align: "right", lineBreak: false });
      }
      doc.text(ln, X.narr, y, { lineBreak: false });
      y += lineH;
      used++;
    });
  }

  if (!opts.omitSummary) {
    if (used + 5 > linesPerPage) newPage();
    y += 8;
    const o = opts.official;
    doc.font("Helvetica-Bold").text("STATEMENT SUMMARY :-", 36, y);
    y += 12;
    doc.text("Opening Balance", 36, y).text("Dr Count", 140, y).text("Cr Count", 200, y).text("Debits", 270, y).text("Credits", 350, y).text("Closing Bal", 440, y);
    y += 11;
    doc.font("Helvetica");
    doc.text(fmtIndian(o.openingBalance), 36, y);
    doc.text(String(o.debitCount), 140, y);
    doc.text(String(o.creditCount), 200, y);
    doc.text(fmtIndian(o.totalDebits), 270, y);
    doc.text(fmtIndian(o.totalCredits), 350, y);
    doc.text(fmtIndian(o.closingBalance), 440, y);
  }
  footer();
  doc.end();
  return done;
}
