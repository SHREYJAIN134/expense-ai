/**
 * Generator for Google Pay "Transaction statement" documents that reproduce the layout of the real export
 * (9 pages for 83 rows: title + contact line + table header on every page, summary on page 1, the explanatory
 * note and "Page x of y" at the bottom of every page, three printed lines per transaction).
 *
 * `layoutGooglePay` is a pure function that produces positioned text items; it is used
 *   - directly as parser input (`pagesFromLayout`): portable, needs no fonts;
 *   - by `generateGooglePayPdf` to render a real PDF (needs a system font that has the rupee sign, see `findRupeeFont`).
 * Dev/test only. The contact line uses a placeholder phone number and e-mail.
 */
import fs from "node:fs";
import PDFDocument from "pdfkit";
import type { PdfPage, TextItem } from "../src/lib/parsers/pdf-reader";

export interface GPayPdfRow {
  date: string; // ISO
  time: string; // 24h HH:MM
  direction: "debit" | "credit";
  counterparty: string;
  id: string;
  amount: number;
  bank?: string;
  mask?: string;
}

export interface GPayPdfOptions {
  rows: GPayPdfRow[];
  /** Official totals printed on page 1. Omit both to leave the summary out entirely. */
  sent?: number;
  received?: number;
  periodStart?: string;
  periodEnd?: string;
  password?: string;
  /** Rows per page: [first page, other pages]. */
  perPage?: [number, number];
  /** Break long "Paid to ..." text onto a second line, like the real export does for very long names. */
  wrapAt?: number;
  /** Leave the table header off pages after the first (a layout the parser must refuse). */
  omitHeaderOnLaterPages?: boolean;
}

interface LItem {
  str: string;
  x: number;
  y: number; // PDF coordinates (origin bottom-left)
  size: number;
  bold?: boolean;
  right?: boolean; // x is the RIGHT edge
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dmy = (iso: string) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}, ${iso.slice(0, 4)}`;
const longDmy = (iso: string) => `${iso.slice(8, 10)} ${LONG_MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const time12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
export const rupees = (n: number) => {
  const [i, d] = n.toFixed(2).split(".");
  const head = i.slice(0, -3);
  const grouped = head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + i.slice(-3) : i;
  return `₹${grouped}${d === "00" ? "" : "." + d}`;
};

export function layoutGooglePay(opts: GPayPdfOptions): LItem[][] {
  const [firstPage, otherPages] = opts.perPage ?? [8, 10];
  const pages: GPayPdfRow[][] = [];
  let i = 0;
  while (i < opts.rows.length || pages.length === 0) {
    const n = pages.length === 0 ? firstPage : otherPages;
    pages.push(opts.rows.slice(i, i + n));
    i += n;
  }
  const dates = opts.rows.map((r) => r.date).sort();
  const start = opts.periodStart ?? dates[0];
  const end = opts.periodEnd ?? dates[dates.length - 1];
  return pages.map((rows, p) => {
    const it: LItem[] = [];
    const put = (str: string, x: number, y: number, size = 9, bold = false, right = false) => it.push({ str, x, y, size, bold, right });
    put("Transaction statement", 448, 806, 12, true);
    put("9999999999, statement.owner@example.com", 366, 791);
    let y: number;
    if (p === 0) {
      if (opts.sent !== undefined && opts.received !== undefined) {
        put("Transaction statement period", 24, 704, 9, true);
        put("Sent", 327, 704, 9, true);
        put("Received", 488, 704, 9, true);
        put(`${longDmy(start)} - ${longDmy(end)}`, 24, 686);
        put(rupees(opts.sent), 312, 686);
        put(rupees(opts.received), 493, 686);
      }
      y = 622;
    } else y = 728;
    if (p === 0 || !opts.omitHeaderOnLaterPages) {
      put("Date & time", 24, y, 9, true);
      put("Transaction details", 154, y, 9, true);
      put("Amount", 536, y, 9, true);
    }
    y -= 29;
    for (const r of rows) {
      const verb = r.direction === "debit" ? "Paid to" : "Received from";
      let name = `${verb} ${r.counterparty}`;
      let second: string | undefined;
      if (opts.wrapAt && name.length > opts.wrapAt) {
        const cut = name.lastIndexOf(" ", opts.wrapAt);
        second = name.slice(cut + 1);
        name = name.slice(0, cut);
      }
      put(dmy(r.date), 24, y);
      put(name, 154, y);
      put(rupees(r.amount), 570, y, 9, false, true);
      let yy = y;
      if (second) {
        yy -= 15.5;
        put(second, 154, yy);
      }
      yy -= 15.5;
      put(time12(r.time), 24, yy);
      put(`UPI Transaction ID: ${r.id}`, 154, yy);
      yy -= 15.5;
      put(`${r.direction === "debit" ? "Paid by" : "Paid to"} ${r.bank ?? "HDFC Bank"} ${r.mask ?? "9332"}`, 171, yy);
      y -= 63.5 + (second ? 15.5 : 0);
    }
    put("Note: This statement reflects payments made by you on the Google Pay app. Self transfer payments are not included in the total money paid and", 24, 68, 8);
    put("received. Any payments transactions and activity deleted from your Google Account will not show up in this statement.", 24, 58, 8);
    put(`Page ${p + 1} of ${pages.length}`, 539, 18, 8);
    return it;
  });
}

/** Parser input built straight from the layout (no PDF involved). Widths are estimated at 4.6pt per character. */
export function pagesFromLayout(opts: GPayPdfOptions): PdfPage[] {
  return layoutGooglePay(opts).map((items, p) => ({
    page: p + 1,
    width: 595.28,
    height: 841.89,
    items: items.map<TextItem>((i) => {
      const w = i.str.length * i.size * 0.5;
      return { str: i.str, x: i.right ? i.x - w : i.x, y: i.y, w, h: i.size };
    }),
  }));
}

/** A system font that contains the rupee sign (U+20B9), or null. The fonts bundled with pdfkit / pdfjs do not. */
export function findRupeeFont(): string | null {
  const candidates = [
    process.env.GPAY_TEST_FONT,
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter((f): f is string => !!f);
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

export async function generateGooglePayPdf(opts: GPayPdfOptions): Promise<Buffer> {
  const font = findRupeeFont();
  if (!font) throw new Error("No system font with the rupee sign was found (set GPAY_TEST_FONT).");
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    ...(opts.password ? { userPassword: opts.password, ownerPassword: opts.password + "-owner" } : {}),
  } as any);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  doc.registerFont("body", font);
  const H = 841.89;
  layoutGooglePay(opts).forEach((items, p) => {
    if (p > 0) doc.addPage();
    for (const i of items) {
      doc.font("body").fontSize(i.size);
      const x = i.right ? i.x - doc.widthOfString(i.str) : i.x;
      doc.text(i.str, x, H - i.y - i.size * 0.8, { lineBreak: false });
    }
  });
  doc.end();
  return done;
}
