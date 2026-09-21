/**
 * Generates SYNTHETIC HDFC-style statement PDFs (optionally password protected).
 * Dev/test only - never used at runtime by the app. No real data involved.
 */
import PDFDocument from "pdfkit";
import { MONTH_SHORT, type ISODate } from "../src/lib/util/dates";
import type { SyntheticTxn } from "../src/lib/demo/synthetic";

export type SampleVariant = "classic" | "compact";

export interface SamplePdfOptions {
  transactions: SyntheticTxn[];
  openingBalance: number;
  periodStart: ISODate;
  periodEnd: ISODate;
  password?: string;
  variant?: SampleVariant;
  /** Full number is synthetic; only the last 4 digits matter to the parser. */
  accountNumber?: string;
  pdfVersion?: "1.4" | "1.6" | "1.7ext3";
  rowsPerPage?: number;
}

const fmtAmt = (n: number) => {
  const [i, d] = n.toFixed(2).split(".");
  // Indian grouping: last 3 digits, then groups of 2
  const head = i.slice(0, -3);
  const tail = i.slice(-3);
  const grouped = head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail : tail;
  return `${grouped}.${d}`;
};

const ddmmyy = (d: ISODate) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
const ddMonYyyy = (d: ISODate) => `${d.slice(8, 10)} ${MONTH_SHORT[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const ddmmyyyyDash = (d: ISODate) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out.length ? out : [""];
}

export function generateSamplePdf(opts: SamplePdfOptions): Promise<Buffer> {
  const variant = opts.variant ?? "classic";
  const acct = opts.accountNumber ?? "50100123456789";
  const doc = new PDFDocument({
    size: "A4",
    margin: 36,
    ...(opts.password
      ? {
          userPassword: opts.password,
          ownerPassword: opts.password + "-owner",
          pdfVersion: opts.pdfVersion ?? "1.6",
          permissions: { printing: "highResolution" as const },
        }
      : {}),
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const cols =
    variant === "classic"
      ? {
          headers: ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
          x: [36, 84, 262, 344, 392, 458, 520],
          w: [44, 172, 80, 46, 60, 58, 60],
          date: ddmmyy,
        }
      : {
          headers: ["Txn Date", "Description", "Ref No", "Value Date", "Debit", "Credit", "Balance"],
          x: [36, 100, 276, 336, 400, 460, 515],
          w: [60, 172, 56, 60, 52, 50, 64],
          date: ddMonYyyy,
        };
  const wrapAt = variant === "classic" ? 34 : 36;
  const lineH = 9;
  const perPage = opts.rowsPerPage ?? 40;

  const drawHeader = (page: number) => {
    doc.font("Helvetica-Bold").fontSize(9).text("HDFC BANK LIMITED", 36, 36);
    doc.font("Helvetica").fontSize(7);
    doc.text("SYNTHETIC SAMPLE STATEMENT - NOT A REAL BANK DOCUMENT", 36, 48);
    if (page === 1) {
      doc.text("Statement of account", 36, 62);
      doc.text("MR SAMPLE USER (DEMO)", 36, 74);
      doc.text("12 EXAMPLE STREET, DEMO CITY 560001", 36, 84);
      doc.text(`Account No : ${acct}`, 360, 62);
      doc.text("Account Type : SAVINGS ACCOUNT", 360, 72);
      doc.text(
        variant === "classic"
          ? `Statement From : ${ddmmyyyySlash(opts.periodStart)} To : ${ddmmyyyySlash(opts.periodEnd)}`
          : `Statement Period : ${ddmmyyyyDash(opts.periodStart)} to ${ddmmyyyyDash(opts.periodEnd)}`,
        360,
        82,
      );
    }
    doc.text(`Page No .: ${page}`, 500, 36);
    const y = page === 1 ? 108 : 66;
    doc.font("Helvetica-Bold").fontSize(7);
    cols.headers.forEach((h, i) => doc.text(h, cols.x[i], y, { width: cols.w[i] + 4, lineBreak: false }));
    doc.moveTo(36, y + 10).lineTo(580, y + 10).stroke();
    doc.font("Helvetica").fontSize(7);
    return y + 16;
  };

  let page = 1;
  let y = drawHeader(page);
  let rowsOnPage = 0;

  for (const t of opts.transactions) {
    const lines = wrap(t.narration, wrapAt);
    if (rowsOnPage >= perPage || y + lines.length * lineH > 780) {
      doc.addPage();
      page += 1;
      y = drawHeader(page);
      rowsOnPage = 0;
    }
    lines.forEach((ln, i) => {
      doc.text(ln, cols.x[1], y + i * lineH, { width: cols.w[1], lineBreak: false });
    });
    doc.text(cols.date(t.date), cols.x[0], y, { width: cols.w[0] + 4, lineBreak: false });
    doc.text(t.reference, cols.x[2], y, { width: cols.w[2], lineBreak: false });
    doc.text(cols.date(t.date), cols.x[3], y, { width: cols.w[3] + 4, lineBreak: false });
    if (t.debit > 0) doc.text(fmtAmt(t.debit), cols.x[4], y, { width: cols.w[4], align: "right", lineBreak: false });
    if (t.credit > 0) doc.text(fmtAmt(t.credit), cols.x[5], y, { width: cols.w[5], align: "right", lineBreak: false });
    doc.text(fmtAmt(t.balance), cols.x[6], y, { width: cols.w[6], align: "right", lineBreak: false });
    y += lines.length * lineH + 3;
    rowsOnPage += 1;
  }

  // Statement summary block (used by the parser for cross-validation)
  const debits = opts.transactions.filter((t) => t.debit > 0);
  const credits = opts.transactions.filter((t) => t.credit > 0);
  const closing = opts.transactions.length ? opts.transactions[opts.transactions.length - 1].balance : opts.openingBalance;
  if (y > 700) {
    doc.addPage();
    page += 1;
    y = 60;
  }
  y += 16;
  doc.font("Helvetica-Bold").text("STATEMENT SUMMARY :-", 36, y);
  y += 12;
  doc.text("Opening Balance", 36, y).text("Dr Count", 140, y).text("Cr Count", 200, y).text("Debits", 270, y).text("Credits", 350, y).text("Closing Bal", 440, y);
  y += 11;
  doc.font("Helvetica");
  doc.text(fmtAmt(opts.openingBalance), 36, y);
  doc.text(String(debits.length), 140, y);
  doc.text(String(credits.length), 200, y);
  doc.text(fmtAmt(debits.reduce((a, t) => a + t.debit, 0)), 270, y);
  doc.text(fmtAmt(credits.reduce((a, t) => a + t.credit, 0)), 350, y);
  doc.text(fmtAmt(closing), 440, y);
  y += 24;
  doc.text("Generated On: 01/08/2026 09:00:00 AM        Generated By: DEMO", 36, y);
  doc.text("This is a computer generated statement and does not require signature.", 36, y + 10);
  doc.text("HDFC BANK LIMITED  Registered Office Address: SAMPLE HOUSE, DEMO ROAD, MUMBAI 400013", 36, y + 20);
  doc.end();
  return done;
}

function ddmmyyyySlash(d: ISODate) {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}
