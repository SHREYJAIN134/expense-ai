/**
 * Pipeline behaviour on the real HDFC structure (synthetic fixture): preview reporting, merchant vs
 * payment-provider separation, refund vs duplicate, AUTOPAY, value dates, stored fields, duplicate
 * evidence and reconciliation gating. Runs against a real in-memory SQLite database.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db/client";
import { createUser } from "../src/lib/services/users";
import { confirmImport, stageStatement, type PreviewResult, type PreviewRow } from "../src/lib/pipeline/import";
import { generateRealHdfcPdf } from "../scripts/real-pdf";
import { calculateCategorySpend, calculateMerchantSpend, calculateSummary } from "../src/lib/analytics/engine";
import { loadAllTxns } from "../src/lib/services/data";
import { linkRefunds } from "../src/lib/services/refunds";
import { ApiError } from "../src/lib/auth/guard";
import { buildRealStatement } from "./real-fixture";
import { round2 } from "../src/lib/util/money";

const { rows: ROWS, official: OFF } = buildRealStatement();
const PROVIDERS = ["Razorpay", "Paytm", "Google Pay", "PhonePe", "PayU", "Payu"];
let userId = "";
let preview: PreviewResult;
let pdf: Buffer;

const byRef = (ref: string) => preview.transactions.find((r) => r.reference === ref) as PreviewRow;
const dbRow = (ref: string) => getDb().prepare("SELECT * FROM transactions WHERE user_id = ? AND reference_number = ?").get(userId, ref) as any;

beforeAll(async () => {
  userId = (await createUser({ email: "real@example.com", name: "Real Fmt", password: "a long test password 1" })).id;
  pdf = await generateRealHdfcPdf({ rows: ROWS, official: OFF });
  preview = await stageStatement(userId, { name: "aug-2026.pdf", data: pdf }, undefined);
}, 60_000);

describe("preview (nothing imported yet)", () => {
  it("reports counts, balances, totals and the reconciliation result", () => {
    expect(preview.counts).toMatchObject({ total: 84, new: 84, duplicates: 0, debits: 76, credits: 8 });
    expect(preview.totals).toMatchObject({ debits: 12379.76, credits: 5868 });
    expect(preview.openingBalance).toBe(29004.97);
    expect(preview.closingBalance).toBe(22493.21);
    expect(preview.calculatedClosingBalance).toBe(22493.21);
    expect(preview.period).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(preview.reconciliation.status).toBe("reconciled");
    expect(preview.requiresAcknowledgement).toBe(false);
    expect(preview.warnings).toEqual([]);
  });

  it("reports refund, autopay, recurring-candidate, unclassified and needs-review counts and a confidence distribution", () => {
    expect(preview.counts.refunds).toBe(1);
    expect(preview.counts.autopay).toBe(2);
    expect(preview.counts.recurringCandidates).toBeGreaterThanOrEqual(2);
    expect(preview.counts.needsReview).toBeGreaterThanOrEqual(1); // the gateway-only row
    expect(preview.counts.unclassified).toBeGreaterThanOrEqual(1);
    const c = preview.confidence;
    expect(c.high + c.medium + c.low).toBe(preview.counts.new);
    expect(c.medium).toBeGreaterThan(0); // Blinkit/Zepto/person rows are deliberately NOT high-confidence
  });

  it("stored nothing before the user confirms", () => {
    expect((getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ?").get(userId) as any).n).toBe(0);
    const st = getDb().prepare("SELECT status, reconciliation_status FROM statements WHERE id = ?").get(preview.statementId) as any;
    expect(st).toEqual({ status: "preview", reconciliation_status: "reconciled" });
  });
});

describe("merchant vs payment provider vs UPI infrastructure", () => {
  it("Blinkit is the merchant; Razorpay / the UPI handle / the bank code are NOT", () => {
    const r = byRef("0000622758185216");
    expect(r.merchant).toBe("Blinkit");
    expect(r.paymentProvider).toBe("Razorpay");
    expect(r.merchantConfidence).toBeGreaterThanOrEqual(0.9);
    expect(r.category).toBe("GROCERIES");
    expect(r.subcategory).toBe("Quick Commerce");
    const stored = preview.transactions.every((t) => !PROVIDERS.includes(t.merchant));
    expect(stored).toBe(true);
    expect(preview.transactions.some((t) => /RZP|HDFC0MER|@/i.test(t.merchant))).toBe(false);
  });

  it("is conservative: a Blinkit/Zepto purchase is not asserted to be groceries at high confidence", () => {
    for (const r of preview.transactions.filter((t) => t.merchant === "Blinkit" || t.merchant === "Zepto")) {
      if (r.credit === 0) expect(r.confidence).toBeLessThanOrEqual(0.8);
    }
  });

  it("a gateway-only counterparty (Razorpay) is never guessed: NEEDS_REVIEW with low merchant confidence", () => {
    const r = preview.transactions.find((t) => t.description.startsWith("UPI-RAZORPAY-"))!;
    expect(r.category).toBe("NEEDS_REVIEW");
    expect(r.merchant).toBe("Unidentified merchant (Razorpay)");
    expect(r.merchantConfidence).toBeLessThan(0.4);
    expect(r.needsReview).toBe(true);
  });

  it("recognises the seed merchants from the statement", () => {
    const pick = (name: string) => preview.transactions.find((t) => t.merchant === name && t.debit > 0);
    expect(pick("Swiggy")).toMatchObject({ category: "FOOD", subcategory: "Food Delivery" });
    expect(pick("Zepto")).toMatchObject({ category: "GROCERIES", subcategory: "Quick Commerce" });
    expect(pick("Juice Cafe")).toMatchObject({ category: "FOOD", subcategory: "Cafes" });
    expect(pick("Big Save")).toMatchObject({ category: "GROCERIES" });
    expect(pick("Rapido")).toMatchObject({ category: "TRANSPORTATION", subcategory: "Cab" });
    expect(pick("Unstop")).toMatchObject({ category: "EDUCATION", subcategory: "Career & Events" });
    expect(pick("Google")).toMatchObject({ category: "ENTERTAINMENT", subcategory: "Digital Purchases" });
    expect(pick("Google")!.confidence).toBeLessThanOrEqual(0.65); // ambiguous (Play / YouTube / Ads)
  });

  it("does not turn individuals into food/shopping expenses: they are TRANSFERS, correctable by the user", () => {
    for (const name of ["Rahul Negi", "Mohan Lal", "Sunita Devi"]) {
      const r = preview.transactions.find((t) => t.merchant === name)!;
      expect(r.category, name).toBe("TRANSFERS");
      expect(r.subcategory).toBe("Person Transfer");
      expect(r.confidence).toBeLessThan(0.8);
    }
  });

  it("credits from people are transfers/reimbursements - never assumed to be income", () => {
    const credits = preview.transactions.filter((t) => t.credit > 0 && !t.isRefund);
    expect(credits).toHaveLength(7);
    for (const c of credits) expect(c.category).toBe("TRANSFERS");
    expect(preview.transactions.some((t) => t.category === "SALARY/INCOME")).toBe(false);
  });
});

describe("refunds are not duplicates", () => {
  it("Blinkit ₹266 debit and ₹266 refund credit are distinct; the refund is flagged", () => {
    const debit = byRef("0000622758185216");
    const refund = byRef("0000622758185299");
    expect(debit.debit).toBe(266);
    expect(refund.credit).toBe(266);
    expect(debit.isDuplicate).toBe(false);
    expect(refund.isDuplicate).toBe(false);
    expect(refund.isRefund).toBe(true);
    expect(refund.category).toBe("REFUNDS");
    expect(preview.counts.duplicates).toBe(0);
  });

  it("identical amounts on the same day are legitimately separate (identical debits, identical credits)", () => {
    const debits = preview.transactions.filter((t) => t.debit === 120 && t.date === "2026-08-12");
    expect(debits).toHaveLength(2);
    expect(debits.every((d) => !d.isDuplicate)).toBe(true);
    const credits = preview.transactions.filter((t) => t.credit === 500 && t.date === "2026-08-15");
    expect(credits).toHaveLength(2);
    expect(credits.every((c) => !c.isDuplicate)).toBe(true);
  });
});

describe("AUTOPAY", () => {
  it("detects autopay mandates, extracts the real merchant and marks them as recurring CANDIDATES only", () => {
    const gp = preview.transactions.find((t) => t.description.startsWith("UPI-AUTOPAY-GOOGLE PLAY"))!;
    expect(gp).toMatchObject({ paymentMethod: "AUTOPAY", merchant: "Google Play", category: "ENTERTAINMENT", subcategory: "Digital Purchases", isRecurringCandidate: true, debit: 129 });
    expect(gp.merchant).not.toMatch(/autopay/i);
    const sp = preview.transactions.find((t) => t.description.startsWith("UPI-AUTOPAY-SPOTIFY"))!;
    expect(sp).toMatchObject({ paymentMethod: "AUTOPAY", merchant: "Spotify", isRecurringCandidate: true, debit: 119 });
    // one payment is weak evidence: the candidate confidence is low until history confirms a pattern
    const staged = getDb().prepare("SELECT staged_json FROM statements WHERE id = ?").get(preview.statementId) as { staged_json: string };
    const rows = JSON.parse(staged.staged_json).transactions as any[];
    expect(rows.filter((r) => r.isAutopay).every((r) => r.recurringConfidence <= 0.4)).toBe(true);
    expect(preview.transactions.filter((t) => t.paymentMethod === "AUTOPAY")).toHaveLength(2);
  });
});

describe("confirmed import: stored fields, value dates, refund link, analytics", () => {
  let result: ReturnType<typeof confirmImport>;
  beforeAll(() => {
    result = confirmImport(userId, preview.statementId);
  });

  it("imports all 84 transactions atomically and links the refund to its purchase", () => {
    expect(result.imported).toBe(84);
    expect(result.refundsLinked).toBe(1);
    const debit = dbRow("0000622758185216");
    const refund = dbRow("0000622758185299");
    expect(refund).toMatchObject({ is_refund: 1, refund_reference: debit.id, direction: "credit" });
    expect(debit.refund_reference).toBeNull();
  });

  it("stores raw narration (with line breaks), verbatim reference, UPI fields and provider", () => {
    const r = dbRow("0000622758185216");
    expect(r.raw_narration).toBe("UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0ME\nRUPI-622758185216-PAY VIA RAZORPAY");
    expect(r.raw_description).toBe("UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY");
    expect(r.normalized_narration).toBe("UPI BLINKIT BLINKIT RZP HDFCBANK HDFC0MERUPI 622758185216 PAY VIA RAZORPAY");
    expect(r.reference_number).toBe("0000622758185216");
    expect(r).toMatchObject({ upi_id: "BLINKIT.RZP@HDFCBANK", upi_bank_code: "HDFC0MERUPI", upi_reference: "622758185216", payment_provider: "Razorpay", payment_method: "UPI", merchant: "Blinkit" });
    expect(r.merchant_confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.debit).toBe(266);
    expect(r.credit).toBe(0);
    expect(r.balance_after).toBeTypeOf("number");
  });

  it("stores transaction_date and value_date separately", () => {
    const rows = getDb().prepare("SELECT txn_date, value_date FROM transactions WHERE user_id = ? AND value_date != txn_date").all(userId);
    expect(rows).toEqual([{ txn_date: "2026-08-25", value_date: "2026-08-26" }]);
  });

  it("flags needs_review / recurring-candidate / autopay in the database", () => {
    const rz = getDb().prepare("SELECT needs_review, category FROM transactions WHERE user_id = ? AND merchant LIKE 'Unidentified merchant%'").get(userId) as any;
    expect(rz).toEqual({ needs_review: 1, category: "NEEDS_REVIEW" });
    const ap = getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND payment_method = 'AUTOPAY' AND is_recurring_candidate = 1").get(userId) as any;
    expect(ap.n).toBe(2);
  });

  it("persists the official summary and the reconciliation outcome on the statement", () => {
    const st = getDb().prepare("SELECT * FROM statements WHERE id = ?").get(preview.statementId) as any;
    expect(st).toMatchObject({
      status: "imported", opening_balance: 29004.97, closing_balance: 22493.21, official_debit_count: 76, official_credit_count: 8,
      official_total_debits: 12379.76, official_total_credits: 5868, calculated_closing_balance: 22493.21, reconciliation_status: "reconciled", staged_json: null,
    });
    expect(JSON.parse(st.reconciliation_json).status).toBe("reconciled");
  });

  it("nets the refund against the purchase in merchant/category analytics (Blinkit ₹266 + ₹266 refund = ₹0)", () => {
    const txns = loadAllTxns(userId);
    const blinkitDebitsGross = round2(txns.filter((t) => t.merchant === "Blinkit" && t.direction === "debit").reduce((a, t) => a + t.debit, 0));
    const net = calculateMerchantSpend(txns).find((m) => m.merchant === "Blinkit")!.amount;
    expect(net).toBe(round2(blinkitDebitsGross - 266));
    const groceries = calculateCategorySpend(txns).find((c) => c.category === "GROCERIES")!;
    const grossGroceries = round2(txns.filter((t) => t.category === "GROCERIES" && t.direction === "debit").reduce((a, t) => a + t.debit, 0));
    expect(groceries.amount).toBe(round2(grossGroceries - 266));
  });

  it("summary: refund counted once as a refund, person credits as transfers, income stays 0", () => {
    const s = calculateSummary(loadAllTxns(userId));
    expect(s).toMatchObject({ totalDebits: 12379.76, totalCredits: 5868, refunds: 266, transfersIn: round2(5868 - 266), income: 0, debitCount: 76, creditCount: 8 });
    expect(round2(s.netCashFlow)).toBe(round2(22493.21 - 29004.97));
  });

  it("analyses by transaction date by default and by value date only when asked", () => {
    const byTxn = loadAllTxns(userId).find((t) => t.description?.includes("SWIGGY.PAYU") && t.amount === 180)!;
    const byVal = loadAllTxns(userId, "value").find((t) => t.id === byTxn.id)!;
    expect(byTxn.date).toBe("2026-08-25");
    expect(byVal.date).toBe("2026-08-26");
  });

  it("linkRefunds is idempotent and never links a refund to a different merchant or an unrelated amount", () => {
    expect(linkRefunds(userId)).toEqual({ refunds: 1, linked: 1 });
    expect(linkRefunds(userId)).toEqual({ refunds: 1, linked: 1 });
  });
});

describe("duplicate detection with strong evidence", () => {
  it("re-uploading the same statement: every row is a duplicate", async () => {
    const p = await stageStatement(userId, { name: "again.pdf", data: pdf }, undefined);
    expect(p.counts).toMatchObject({ total: 84, new: 0, duplicates: 84 });
    expect(p.duplicateStatement).toBe(true);
  });

  it("still detects duplicates when the bank re-wraps narrations and re-aligns headers (reference number evidence)", async () => {
    const rewrapped = await generateRealHdfcPdf({ rows: ROWS, official: OFF, wrapWidth: 30, centeredHeaders: false, linesPerPage: 20 });
    const p = await stageStatement(userId, { name: "rewrapped.pdf", data: rewrapped }, undefined);
    expect(p.counts.total).toBe(84);
    expect(p.counts.duplicates).toBe(84);
    expect(p.counts.new).toBe(0);
  });

  it("does not treat two different transactions with the same amount as duplicates", async () => {
    const other = ROWS.map((r) => ({ ...r }));
    // same amounts/dates/merchants but different reference numbers and balances: a different account history
    other.forEach((r, i) => (r.reference = "0000" + String(700000000000 + i)));
    const p = await stageStatement(userId, { name: "other.pdf", data: await generateRealHdfcPdf({ rows: other, official: OFF }) }, undefined);
    expect(p.counts.duplicates).toBeLessThan(84);
  });
});

describe("reconciliation gate at import", () => {
  it("a statement that does not reconcile cannot be imported without an explicit acknowledgement", async () => {
    const otherUser = (await createUser({ email: "gate@example.com", name: "Gate", password: "another long password 2" })).id;
    const bad = await generateRealHdfcPdf({ rows: ROWS, official: { ...OFF, debitCount: 75, totalDebits: 12379.86 } });
    const p = await stageStatement(otherUser, { name: "bad.pdf", data: bad }, undefined);
    expect(p.reconciliation.status).toBe("mismatch");
    expect(p.requiresAcknowledgement).toBe(true);
    expect(p.warnings.join(" ")).toMatch(/Debit count|Total debits/);
    expect(() => confirmImport(otherUser, p.statementId)).toThrow(ApiError);
    try {
      confirmImport(otherUser, p.statementId);
    } catch (e) {
      expect((e as ApiError).code).toBe("RECONCILIATION_FAILED");
    }
    expect((getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ?").get(otherUser) as any).n).toBe(0); // nothing leaked in
    const res = confirmImport(otherUser, p.statementId, { acknowledgeReconciliation: true });
    expect(res.imported).toBe(84);
    expect((getDb().prepare("SELECT reconciliation_status s FROM statements WHERE id = ?").get(p.statementId) as any).s).toBe("mismatch");
  });
});
