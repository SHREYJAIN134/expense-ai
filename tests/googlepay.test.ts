/**
 * Google Pay statement support: detection, parsing (layout-level and on a rendered PDF), the REAL statement (when it
 * is available on this machine), reconciliation, normalisation, self-transfer evidence and error handling.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { StatementError } from "../src/lib/domain/types";
import { parseStatementPdf } from "../src/lib/parsers";
import { detectGooglePay } from "../src/lib/parsers/googlepay/detector";
import { detectHdfc } from "../src/lib/parsers/hdfc/detector";
import { parseGooglePayPages } from "../src/lib/parsers/googlepay/parser";
import { normalizeGooglePay, counterpartySemantics } from "../src/lib/parsers/googlepay/normalizer";
import { reconcileGooglePay } from "../src/lib/parsers/googlepay/reconcile";
import { classifyTransaction } from "../src/lib/classification/classifier";
import { detectSelfTransfer } from "../src/lib/matching/semantics";
import { findRupeeFont, generateGooglePayPdf, layoutGooglePay, pagesFromLayout, type GPayPdfRow } from "../scripts/gpay-pdf";
import { GPAY_OFFICIAL, GPAY_ROWS } from "./gpay-fixture";

const REAL_PDF = "C:/Users/ADMIN/Downloads/gpay_statement_20260801_20260831.pdf";
const full = { rows: GPAY_ROWS, sent: GPAY_OFFICIAL.sent, received: GPAY_OFFICIAL.received };
const parsed = () => parseGooglePayPages(pagesFromLayout(full));
const row = (p: Partial<GPayPdfRow> & { id: string }): GPayPdfRow => ({ date: "2026-08-10", time: "10:15", direction: "debit", counterparty: "Somebody Else", amount: 100, ...p });

describe("Google Pay statement detection", () => {
  it("recognises the format and never mistakes it for an HDFC statement (it only names HDFC as the funding bank)", () => {
    const pages = pagesFromLayout(full);
    const d = detectGooglePay(pages);
    expect(d.matched).toBe(true);
    expect(d.confidence).toBeGreaterThan(0.9);
    const h = detectHdfc(pages);
    expect(h.confidence).toBeLessThan(d.confidence); // even if the HDFC detector gets a weak hit, Google Pay wins
  });
  it("does not claim other documents", () => {
    const junk = [{ page: 1, width: 595, height: 842, items: [{ str: "Some other statement", x: 10, y: 800, w: 90, h: 9 }] }];
    expect(detectGooglePay(junk).matched).toBe(false);
  });
});

describe("Google Pay parser (layout level, all 83 real rows)", () => {
  const s = parsed();
  it("reads every page, every transaction, and nothing else", () => {
    expect(layoutGooglePay(full)).toHaveLength(9);
    expect(s.transactions).toHaveLength(GPAY_ROWS.length);
    expect(s.transactions.filter((t) => t.debit > 0)).toHaveLength(76);
    expect(s.transactions.filter((t) => t.credit > 0)).toHaveLength(7);
    expect(new Set(s.transactions.map((t) => t.providerTxnId)).size).toBe(83);
  });
  it("extracts date, time, direction, counterparty, UPI transaction id, bank and amount exactly", () => {
    s.transactions.forEach((t, i) => {
      const r = GPAY_ROWS[i];
      expect([t.date, t.time, t.debit > 0 ? "debit" : "credit", t.counterparty, t.providerTxnId, t.debit || t.credit, t.fundingBank, t.fundingMask]).toEqual([r.date, r.time, r.direction, r.counterparty, r.id, r.amount, r.bank, r.mask]);
    });
  });
  it("direction comes from the wording, and the page furniture is never parsed as data", () => {
    const first = s.transactions[0];
    expect(first).toMatchObject({ counterparty: "Rahul Negi", debit: 625, credit: 0, providerTxnId: "621331236828", time: "13:00" });
    expect(s.transactions[1]).toMatchObject({ counterparty: "DivyeshDiptanshu", credit: 1220, debit: 0, providerTxnId: "131924681432" });
    expect(s.transactions[2]).toMatchObject({ counterparty: "NEKKALAPU RAMU", credit: 3700, providerTxnId: "536373736492" });
    const everything = JSON.stringify(s);
    for (const noise of ["Note:", "Self transfer", "Page 1 of 9", "Transaction statement", "Date & time", "statement.owner@example.com", "9999999999", "Google Account"]) expect(everything, noise).not.toContain(noise);
  });
  it("preserves the raw transaction text and separates bank from merchant", () => {
    expect(s.transactions[0].narrationLines).toEqual(["Paid to Rahul Negi", "UPI Transaction ID: 621331236828", "Paid by HDFC Bank 9332"]);
    expect(s.transactions[1].narrationLines?.[2]).toBe("Paid to HDFC Bank 9332"); // the receiving account, not a counterparty
    expect(s.transactions.every((t) => t.counterparty && !/HDFC Bank/i.test(t.counterparty))).toBe(true);
    expect(s.transactions[0].rawDescription).toContain("UPI Transaction ID: 621331236828");
  });
  it("reads the statement period and the official Sent / Received totals", () => {
    expect(s.bank).toBe("GOOGLE_PAY");
    expect(s.period).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(s.providerSummary).toEqual({ sent: 12379.76, received: 5602 });
    expect(s.account.mask).toBe("9332");
    expect(s.warnings).toEqual([]);
  });
  it("counterparties that wrap onto a second line are joined, not split into two transactions", () => {
    const long = [row({ id: "900000000001", counterparty: "THE DEN Indoor Sports Academy And Recreation Centre", amount: 250 }), row({ id: "900000000002", counterparty: "Next", amount: 5 })];
    const st = parseGooglePayPages(pagesFromLayout({ rows: long, sent: 255, received: 0, wrapAt: 30 }));
    expect(st.transactions).toHaveLength(2);
    expect(st.transactions[0].counterparty).toBe("THE DEN Indoor Sports Academy And Recreation Centre");
    expect(st.reconciliation?.status).toBe("reconciled");
  });
  it("formats: times around midnight/noon and amounts with paise", () => {
    const st = parseGooglePayPages(pagesFromLayout({ rows: [row({ id: "900000000003", time: "00:05", amount: 231.4 }), row({ id: "900000000004", time: "12:30", amount: 102.36 }), row({ id: "900000000005", time: "23:59", amount: 2 })], sent: 335.76, received: 0 }));
    expect(st.transactions.map((t) => [t.time, t.debit])).toEqual([["00:05", 231.4], ["12:30", 102.36], ["23:59", 2]]);
    expect(st.reconciliation?.status).toBe("reconciled");
  });
});

describe("Google Pay reconciliation (Sent / Received, not a balance)", () => {
  it("reconciles when paid and received rows add up to the official totals", () => {
    const r = parsed().reconciliation!;
    expect(r.status).toBe("reconciled");
    expect(r.providerTotals).toMatchObject({ sent: 12379.76, sentCalculated: 12379.76, received: 5602, receivedCalculated: 5602 });
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
  it("is a mismatch (never 'reconciled') when the totals do not add up", () => {
    const wrong = parseGooglePayPages(pagesFromLayout({ ...full, sent: 12380.76 }));
    expect(wrong.reconciliation?.status).toBe("mismatch");
    expect(wrong.reconciliation?.issues.join(" ")).toMatch(/Sent 12380.76/);
  });
  it("without printed totals there is nothing to reconcile against", () => {
    const st = parseGooglePayPages(pagesFromLayout({ rows: GPAY_ROWS }));
    expect(st.reconciliation?.status).toBe("no_summary");
    expect(st.warnings.join(" ")).toMatch(/cannot be reconciled/);
  });
  it("self transfers are excluded from the calculated side (Google Pay leaves them out of its totals)", () => {
    const rows = [{ direction: "debit" as const, amount: 300 }, { direction: "debit" as const, amount: 700, semanticType: "SELF_TRANSFER" }, { direction: "credit" as const, amount: 50 }];
    const r = reconcileGooglePay({ sent: 300, received: 50 }, rows);
    expect(r.status).toBe("reconciled");
    expect(r.providerTotals?.excludedSelfTransfers).toBe(700);
  });
  it("requires review when only rows that MIGHT be self transfers explain the gap; a plain mismatch otherwise", () => {
    const maybe = [{ direction: "debit" as const, amount: 300 }, { direction: "debit" as const, amount: 700, semanticType: "POSSIBLE_SELF_TRANSFER" }];
    const r = reconcileGooglePay({ sent: 300, received: 0 }, maybe);
    expect(r.status).toBe("requires_review");
    expect(r.issues.join(" ")).toMatch(/transfers between your own accounts/);
    expect(reconcileGooglePay({ sent: 250, received: 0 }, maybe).status).toBe("mismatch"); // 700 cannot explain a 750 gap
    expect(reconcileGooglePay({ sent: 1000, received: 0 }, maybe).status).toBe("reconciled");
  });
});

describe("normalisation into the canonical model", () => {
  const n = normalizeGooglePay(parsed()).transactions;
  const find = (name: string) => n.filter((t) => t.counterparty === name);
  it("keeps the original counterparty, the UPI transaction id, the time and the funding bank apart from the merchant", () => {
    const t = n[0];
    expect(t).toMatchObject({ source: "GOOGLE_PAY", counterpartyRaw: "Rahul Negi", upiReference: "621331236828", txnTime: "13:00", txnDateTime: "2026-08-01T13:00", fundingBank: "HDFC Bank", fundingMask: "9332", paymentMethod: "UPI", paymentProvider: "Google Pay", transactionType: "UPI", amount: 625, direction: "debit" });
    expect(t.rawNarration).toContain("UPI Transaction ID: 621331236828");
  });
  it("gives every row a stable, source-scoped dedupe key", () => {
    expect(new Set(n.map((t) => t.dedupeKey)).size).toBe(83);
    expect(normalizeGooglePay(parsed()).transactions.map((t) => t.dedupeKey)).toEqual(n.map((t) => t.dedupeKey));
  });
  it("merchant names from Google Pay reach the same merchants and categories as HDFC narrations", () => {
    const cls = (name: string) => classifyTransaction(find(name)[0]);
    expect(cls("Zepto Marketplace Pr")).toMatchObject({ merchant: "Zepto", category: "GROCERIES", subcategory: "Quick Commerce" });
    expect(cls("ZEPTO MARKETPLACE PRIVATE LIMITED")).toMatchObject({ merchant: "Zepto", category: "GROCERIES" });
    expect(cls("Zepto")).toMatchObject({ merchant: "Zepto" });
    expect(cls("Blinkit")).toMatchObject({ merchant: "Blinkit", category: "GROCERIES", subcategory: "Quick Commerce" });
    expect(cls("BLINKIT COMMERCE PRIVATE LIMITED")).toMatchObject({ merchant: "Blinkit" });
    expect(cls("SWIGGY")).toMatchObject({ merchant: "Swiggy", category: "FOOD" });
    expect(cls("Bundl Technologies pvt Ltd")).toMatchObject({ merchant: "Swiggy" });
    expect(cls("SPOTIFY INDIA PVT LTD")).toMatchObject({ merchant: "Spotify", category: "ENTERTAINMENT" });
    expect(cls("Google Play")).toMatchObject({ merchant: "Google Play" });
    expect(cls("BIG SAVE SUPERMARKET")).toMatchObject({ merchant: "Big Save", category: "GROCERIES" });
    expect(cls("Bigsave Supermarket")).toMatchObject({ merchant: "Big Save" });
    expect(cls("Airtel Prepaid")).toMatchObject({ merchant: "Airtel", category: "UTILITIES", subcategory: "Mobile" });
    expect(cls("Rapido")).toMatchObject({ merchant: "Rapido", category: "TRANSPORTATION" });
  });
  it("classification confidence stays visible and known merchants are not over-trusted", () => {
    const z = classifyTransaction(find("Zepto")[0]);
    expect(z.confidence).toBeGreaterThan(0.5);
    expect(z.confidence).toBeLessThan(0.9); // quick commerce sells more than groceries
    expect(z.method).toBe("merchant");
  });
  it("people are not turned into merchants or spending categories", () => {
    for (const name of ["Rahul Negi", "NEKKALAPU RAMU", "DEVANSH KHANNA", "Bipin Kumar", "Shivansh Bansal"]) {
      const t = find(name)[0];
      expect(t.semanticType, name).toBe("PERSON_TO_PERSON");
      const c = classifyTransaction(t);
      expect(["TRANSFERS"]).toContain(c.category);
      expect(c.merchant.toLowerCase()).toBe(name.toLowerCase());
    }
    for (const name of ["ADITYA", "Kiddo", "JABIR"]) {
      const t = n.find((x) => x.counterparty?.toLowerCase() === name.toLowerCase())!;
      const c = classifyTransaction(t);
      expect(t.semanticType, name).toBe("UNKNOWN_COUNTERPARTY");
      expect(["FOOD", "SHOPPING", "GROCERIES"]).not.toContain(c.category); // never guessed from a first name
    }
    expect(counterpartySemantics("Zepto")).toBeUndefined();
    expect(counterpartySemantics("Rahul Negi")).toBe("PERSON_TO_PERSON");
  });
});

describe("self-transfer evidence", () => {
  it("is asserted only with proof", () => {
    expect(detectSelfTransfer("Shrey Kumar Jain", ["Shrey Kumar Jain"], [])).toBe("SELF_TRANSFER");
    expect(detectSelfTransfer("shrey  kumar jain", ["Shrey Kumar Jain"], [])).toBe("SELF_TRANSFER");
    expect(detectSelfTransfer("HDFC Bank 9332", [], ["9332"])).toBe("SELF_TRANSFER");
  });
  it("hints are only ever a review flag", () => {
    expect(detectSelfTransfer("Shrey Sharma", ["Shrey Kumar Jain"], [])).toBe("POSSIBLE_SELF_TRANSFER");
    expect(detectSelfTransfer("Self", ["Shrey Kumar Jain"], [])).toBe("POSSIBLE_SELF_TRANSFER");
  });
  it("no evidence, no claim", () => {
    expect(detectSelfTransfer("Rahul Negi", ["Shrey Kumar Jain"], ["9332"])).toBeUndefined();
    expect(detectSelfTransfer("Zepto", ["Shrey Kumar Jain"], ["9332"])).toBeUndefined();
    expect(detectSelfTransfer("Rahul", [], [])).toBeUndefined();
    expect(detectSelfTransfer(undefined, ["Shrey Kumar Jain"], [])).toBeUndefined();
  });
});

describe("errors: never a partial import", () => {
  it("a row missing its amount, id or direction aborts the whole statement", () => {
    const pages = pagesFromLayout({ rows: [row({ id: "900000000010" }), row({ id: "900000000011" })], sent: 200, received: 0 });
    const broken = pages.map((p) => ({ ...p, items: p.items.filter((i) => !(i.str === "UPI Transaction ID: 900000000011")) }));
    expect(() => parseGooglePayPages(broken)).toThrowError(StatementError);
    expect(() => parseGooglePayPages(broken)).toThrow(/Nothing was imported/);
    const noAmount = pages.map((p) => ({ ...p, items: p.items.filter((i) => !(i.x > 400 && i.y < 600 && i.y > 100)) }));
    expect(() => parseGooglePayPages(noAmount)).toThrow(/could not be read completely/);
  });
  it("transactions on a page without the table header are refused instead of silently dropped", () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ id: String(900000000100 + i) }));
    expect(() => parseGooglePayPages(pagesFromLayout({ rows: many, sent: 3000, received: 0, omitHeaderOnLaterPages: true }))).toThrow(/no table header/);
  });
  it("a statement with no transactions is reported as such", () => {
    expect(() => parseGooglePayPages(pagesFromLayout({ rows: [], sent: 0, received: 0, periodStart: "2026-08-01", periodEnd: "2026-08-31" }))).toThrow(/No transactions/);
  });
  it("unknown documents say 'Unsupported statement format'", async () => {
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
    doc.text("Quarterly newsletter with no transactions at all").end();
    await expect(parseStatementPdf(new Uint8Array(await done))).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", message: expect.stringMatching(/Unsupported statement format/) });
  });
});

describe.skipIf(!findRupeeFont())("Google Pay statement rendered as a real PDF (system font with the rupee sign)", () => {
  it("parses end-to-end through the same entry point as uploads, with auto-detection", async () => {
    const pdf = await generateGooglePayPdf(full);
    const r = await parseStatementPdf(new Uint8Array(pdf));
    expect(r).toMatchObject({ parserId: "googlepay", pageCount: 9 });
    expect(r.statement.transactions).toHaveLength(83);
    expect(r.statement.reconciliation?.status).toBe("reconciled");
    expect(r.normalized.transactions).toHaveLength(83);
  }, 60_000);
  it("a password-protected export needs the right password", async () => {
    const pdf = await generateGooglePayPdf({ ...full, password: "gpay-pass-1" });
    await expect(parseStatementPdf(new Uint8Array(pdf))).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    await expect(parseStatementPdf(new Uint8Array(pdf), "wrong")).rejects.toMatchObject({ code: "INCORRECT_PASSWORD" });
    expect((await parseStatementPdf(new Uint8Array(pdf), "gpay-pass-1")).statement.transactions).toHaveLength(83);
  }, 60_000);
});

describe.skipIf(!fs.existsSync(REAL_PDF))("the REAL Google Pay statement (gpay_statement_20260801_20260831.pdf)", () => {
  it("runs through the parser: 9 pages, 83 transactions, official totals reproduced, fixture identical", async () => {
    const r = await parseStatementPdf(new Uint8Array(fs.readFileSync(REAL_PDF)));
    const s = r.statement;
    expect(r).toMatchObject({ parserId: "googlepay", pageCount: 9 });
    expect(s.period).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(s.providerSummary).toEqual({ sent: 12379.76, received: 5602 });
    expect(s.transactions).toHaveLength(83);
    const sent = Math.round(s.transactions.reduce((a, t) => a + t.debit, 0) * 100) / 100;
    const received = Math.round(s.transactions.reduce((a, t) => a + t.credit, 0) * 100) / 100;
    expect([sent, received]).toEqual([12379.76, 5602]);
    expect(s.reconciliation?.status).toBe("reconciled");
    expect(new Set(s.transactions.map((t) => t.providerTxnId)).size).toBe(83);
    s.transactions.forEach((t, i) => {
      const f = GPAY_ROWS[i];
      expect([t.date, t.time, t.counterparty, t.providerTxnId, t.debit || t.credit, t.fundingMask]).toEqual([f.date, f.time, f.counterparty, f.id, f.amount, f.mask]);
    });
    // the contact line printed in the header is never carried into any parsed field
    expect(JSON.stringify(s)).not.toMatch(/@gmail|@example|\b\d{10}\b(?!\d)/);
  }, 60_000);
});
