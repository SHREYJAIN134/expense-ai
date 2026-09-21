import { describe, expect, it } from "vitest";
import { classifyTransaction, emptyContext, type ClassifierContext } from "../src/lib/classification/classifier";
import { KNOWN_MERCHANTS, looksLikePerson, merchantKeyOf, normalizeMerchant } from "../src/lib/classification/merchants";
import { refineWithAi } from "../src/lib/classification/ai-classifier";
import { CATEGORIES, isValidCategory } from "../src/lib/domain/categories";
import { normalizeTransactions } from "../src/lib/parsers/hdfc/normalizer";
import type { Classification, ClassifiedTransaction, NormalizedTransaction, ParsedTransaction } from "../src/lib/domain/types";
import type { AiProvider } from "../src/lib/ai/provider";

function norm(raw: string, debit = 500, credit = 0): NormalizedTransaction {
  const p: ParsedTransaction = { date: "2026-05-01", rawDescription: raw, debit, credit, rowIndex: 0, warnings: [] };
  return normalizeTransactions([p]).transactions[0];
}
const cls = (raw: string, debit = 500, credit = 0, ctx?: ClassifierContext) => classifyTransaction(norm(raw, debit, credit), ctx);

describe("taxonomy integrity", () => {
  it("every known merchant maps to a valid category/subcategory", () => {
    for (const m of KNOWN_MERCHANTS) {
      expect(isValidCategory(m.category, m.subcategory), `${m.name}: ${m.category}/${m.subcategory}`).toBe(true);
    }
  });
  it("has the 20 required top-level categories", () => {
    expect(CATEGORIES.map((c) => c.name)).toEqual(
      expect.arrayContaining(["FOOD", "GROCERIES", "TRANSPORTATION", "SHOPPING", "ENTERTAINMENT", "EDUCATION", "SUBSCRIPTIONS", "UTILITIES", "RENT", "HEALTHCARE", "TRAVEL", "BILLS", "PERSONAL", "TRANSFERS", "ATM/CASH", "BANKING FEES", "INVESTMENTS", "SALARY/INCOME", "REFUNDS", "OTHER"]),
    );
  });
});

describe("merchant normalization", () => {
  it.each([
    "UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678901-ORDER",
    "UPI-SWIGGY*12345-SWIGGY.PAYU@HDFCBANK-HDFC0MERCUPI-412345678902-UPI",
    "POS 416021XXXXXX1234 SWIGGY ONLINE",
  ])("collapses Swiggy variants: %s", (raw) => {
    expect(cls(raw).merchant).toBe("Swiggy");
  });

  it("keeps Swiggy Instamart distinct from Swiggy (and puts it in groceries)", () => {
    const c = cls("UPI-SWIGGY INSTAMART-SWIGGY@YBL-YESB0YBLUPI-412345678903-ORDER");
    expect(c.merchant).toBe("Swiggy Instamart");
    expect(c.category).toBe("GROCERIES");
  });

  it("cleans unknown counterparties (ids, VPAs, casing)", () => {
    const m = normalizeMerchant("RAMESH TEA STALL*9876", "UPI-RAMESH TEA STALL*9876-x@ybl", "UPI");
    expect(m.name).toBe("Ramesh Tea Stall");
    expect(m.key).toBe(merchantKeyOf("Ramesh Tea Stall"));
  });

  it("distinguishes people from businesses", () => {
    expect(looksLikePerson("ANITA VERMA").person).toBe(true);
    expect(looksLikePerson("MR RAJESH SHARMA").person).toBe(true);
    expect(looksLikePerson("SHARMA GENERAL STORES").person).toBe(false);
    expect(looksLikePerson("ACME TECHNOLOGIES PVT LTD").person).toBe(false);
    expect(looksLikePerson("SWIGGY").person).toBe(false);
  });
});

describe("category classification", () => {
  it("classifies well-known merchants with high confidence (spec examples)", () => {
    const z = cls("UPI-ZOMATO-ZOMATOONLINE@ICICI-ICIC0000001-412345678901-ORDER");
    expect(z).toMatchObject({ merchant: "Zomato", category: "FOOD", subcategory: "Food Delivery", method: "merchant" });
    expect(z.confidence).toBeGreaterThanOrEqual(0.95);
    const u = cls("UPI-UDEMY-UDEMY@OKICICI-ICIC0000001-412345678901-COURSE");
    expect(u).toMatchObject({ merchant: "Udemy", category: "EDUCATION" });
    expect(u.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("applies deterministic rules by transaction type", () => {
    expect(cls("ATW-416021XXXXXX1234-S1AW012345-BANGALORE", 2000)).toMatchObject({ category: "ATM/CASH", subcategory: "Cash Withdrawal" });
    expect(cls("SMS ALERT CHGS Q3", 17.7)).toMatchObject({ category: "BANKING FEES", subcategory: "Bank Charges" });
    expect(cls("CREDIT INTEREST CAPITALISED", 0, 250)).toMatchObject({ category: "SALARY/INCOME", subcategory: "Interest" });
    expect(cls("NEFT CR-HDFC0000240-ACME PVT LTD-SALARY-N1", 0, 95000)).toMatchObject({ category: "SALARY/INCOME", subcategory: "Salary" });
    expect(cls("IMPS-412345678901-MR RAJESH SHARMA-HDFC-XXXX4321-RENT", 25000)).toMatchObject({ category: "RENT", subcategory: "Rent" });
    expect(cls("REV-UPI-AMAZON-REFUND", 0, 300)).toMatchObject({ category: "REFUNDS" });
  });

  it("treats a credit from a shopping/food merchant as a refund, not income", () => {
    const c = cls("UPI-AMAZON PAY-AMAZONPAY@APL-YESB0YBLUPI-412345678904-REFUND", 0, 999);
    expect(c.category).toBe("REFUNDS");
  });

  it("uses keyword analysis for unknown merchants at lower confidence", () => {
    const c = cls("POS 416021XXXXXX1234 SHARMA MEDICAL STORE");
    expect(c.category).toBe("HEALTHCARE");
    expect(c.method).toBe("keyword");
    expect(c.confidence).toBeLessThan(0.9);
  });

  it("marks person-to-person UPI as transfers, with Family when hinted", () => {
    expect(cls("UPI-ANITA VERMA-ANITA@OKSBI-SBIN0001-412345678905-SPLIT")).toMatchObject({ category: "TRANSFERS", subcategory: "Person Transfer" });
    expect(cls("UPI-PAPA-PAPA@OKHDFCBANK-HDFC0001-412345678906-FAMILY", 0, 5000)).toMatchObject({ category: "TRANSFERS", subcategory: "Family" });
  });

  it("falls back to OTHER / Unclassified with a low confidence when nothing matches", () => {
    const c = cls("UPI-QWXZ1 KLPT-XKQ@YBL-YESB0YBLUPI-412345678907-UPI");
    expect(c).toMatchObject({ category: "OTHER", subcategory: "Unclassified", method: "none" });
    expect(c.confidence).toBeLessThan(0.5);
  });

  it("user corrections override everything (learning)", () => {
    const ctx = emptyContext();
    ctx.overrides.set(merchantKeyOf("Swiggy"), { category: "GROCERIES", subcategory: "Online Grocery" });
    const c = cls("UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678901-ORDER", 300, 0, ctx);
    expect(c).toMatchObject({ category: "GROCERIES", method: "user" });
    expect(c.confidence).toBeGreaterThanOrEqual(0.99);
  });

  it("can rename merchants via overrides while keeping the key stable", () => {
    const ctx = emptyContext();
    ctx.overrides.set(merchantKeyOf("Ramesh Tea Stall"), { name: "Ramesh Chai", category: "FOOD", subcategory: "Cafes" });
    const c = cls("UPI-RAMESH TEA STALL-R@YBL-YESB0YBLUPI-412345678908-TEA", 20, 0, ctx);
    expect(c.merchant).toBe("Ramesh Chai");
    expect(c.category).toBe("FOOD");
  });

  it("reuses consistent history for an otherwise unknown merchant", () => {
    const ctx = emptyContext();
    ctx.history.set(merchantKeyOf("Qwxz1 Klpt"), { category: "PERSONAL", subcategory: "Personal Care", count: 4, confidence: 0.9 });
    const c = cls("UPI-QWXZ1 KLPT-XKQ@YBL-YESB0YBLUPI-412345678907-UPI", 300, 0, ctx);
    expect(c).toMatchObject({ category: "PERSONAL", method: "history" });
  });
});

describe("AI classification (fails soft)", () => {
  const makeRow = (raw: string): ClassifiedTransaction => ({ ...norm(raw), ...classifyTransaction(norm(raw)) });

  it("applies valid AI suggestions to ambiguous rows only, capped below rule confidence", async () => {
    const rows = [makeRow("UPI-QWXZ1 KLPT-XKQ@YBL-YESB0YBLUPI-412345678907-UPI"), makeRow("UPI-ZOMATO-Z@ICICI-ICIC0001-412345678901-ORD")];
    let sent = "";
    const provider: AiProvider = {
      name: "mock",
      async complete(req) {
        sent = req.user;
        return '```json\n[{"k":0,"category":"PERSONAL","subcategory":"Salon & Grooming","confidence":0.97}]\n```';
      },
    };
    const res = await refineWithAi(rows, provider);
    expect(res).toMatchObject({ attempted: true, failed: false, applied: 1 });
    expect(rows[0]).toMatchObject({ category: "PERSONAL", method: "ai" });
    expect(rows[0].confidence).toBeLessThanOrEqual(0.8);
    expect(rows[1].method).toBe("merchant"); // untouched
    // privacy: only merchant/narration/direction are sent - no amounts, dates or reference numbers
    expect(sent).not.toMatch(/412345678907/);
    expect(sent).not.toMatch(/500/);
    expect(sent).not.toMatch(/2026-05-01/);
  });

  it("rejects hallucinated categories", async () => {
    const rows = [makeRow("UPI-QWXZ1 KLPT-XKQ@YBL-YESB0YBLUPI-412345678907-UPI")];
    const provider: AiProvider = { name: "mock", complete: async () => '[{"k":0,"category":"SPACESHIPS","subcategory":"x","confidence":0.9}]' };
    const res = await refineWithAi(rows, provider);
    expect(res.applied).toBe(0);
    expect(rows[0].category).toBe("OTHER");
  });

  it("leaves rows as OTHER / Unclassified when the provider fails or is absent", async () => {
    const rows = [makeRow("UPI-QWXZ1 KLPT-XKQ@YBL-YESB0YBLUPI-412345678907-UPI")];
    const failing: AiProvider = { name: "mock", complete: async () => { throw new Error("network down"); } };
    const res = await refineWithAi(rows, failing);
    expect(res.failed).toBe(true);
    expect(rows[0]).toMatchObject({ category: "OTHER", subcategory: "Unclassified" });
    expect(await refineWithAi(rows, null)).toMatchObject({ attempted: false });
  });

  it("never touches the type shape of classification results", () => {
    const c: Classification = classifyTransaction(norm("UPI-ZOMATO-Z@ICICI-ICIC0001-412345678901-ORD"));
    expect(Object.keys(c).sort()).toEqual(["category", "confidence", "merchant", "merchantConfidence", "merchantKey", "method", "reason", "subcategory"].sort());
  });
});
