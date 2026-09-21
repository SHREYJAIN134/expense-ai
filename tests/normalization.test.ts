import { describe, expect, it } from "vitest";
import {
  detectTransactionType,
  extractCounterparty,
  extractReference,
  normalizeTransactions,
} from "../src/lib/parsers/hdfc/normalizer";
import type { ParsedTransaction } from "../src/lib/domain/types";
import { parseAmount } from "../src/lib/util/money";

const row = (over: Partial<ParsedTransaction> = {}): ParsedTransaction => ({
  date: "2026-05-01",
  rawDescription: "UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678901-ORDER",
  debit: 250,
  credit: 0,
  balance: 1000,
  rowIndex: 0,
  warnings: [],
  ...over,
});

describe("transaction type detection", () => {
  it.each([
    ["UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678901-ORDER", "UPI"],
    ["NEFT CR-HDFC0000240-ACME PVT LTD-SAMPLE-N123", "NEFT"],
    ["IMPS-412345678901-JOHN DOE-HDFC-XXXXXXXX1234-RENT", "IMPS"],
    ["POS 416021XXXXXX1234 AMAZON PAY INDIA", "POS"],
    ["ATW-416021XXXXXX1234-S1AW012345-BANGALORE", "ATM"],
    ["ACH D- GROWW MUTUAL FUND SIP-123456", "ACH"],
    ["IB BILLPAY DR-HDFCVC-BESCOM-123", "BILLPAY"],
    ["CREDIT INTEREST CAPITALISED", "INTEREST"],
    ["SMS ALERT CHGS Q3", "FEE"],
    ["REV-UPI-SOMETHING", "REVERSAL"],
    ["CHQ PAID-MICR CTS-MU-JOHN", "CHEQUE"],
    ["SOMETHING UNRECOGNISED", "OTHER"],
  ])("%s -> %s", (raw, type) => {
    expect(detectTransactionType(raw)).toBe(type);
  });
});

describe("counterparty & reference extraction", () => {
  it("pulls the merchant out of each HDFC narration format", () => {
    expect(extractCounterparty("UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678901-ORDER", "UPI")).toBe("SWIGGY");
    expect(extractCounterparty("NEFT CR-HDFC0000240-ACME TECHNOLOGIES PVT LTD-SAMPLE-N123", "NEFT")).toBe("ACME TECHNOLOGIES PVT LTD");
    expect(extractCounterparty("IMPS-412345678901-MR RAJESH SHARMA-HDFC-XXXXXXXX1234-RENT", "IMPS")).toBe("MR RAJESH SHARMA");
    expect(extractCounterparty("POS 416021XXXXXX1234 AMAZON PAY INDIA", "POS")).toBe("AMAZON PAY INDIA");
    expect(extractCounterparty("ACH D- GROWW MUTUAL FUND SIP-123456", "ACH")).toBe("GROWW MUTUAL FUND SIP");
    expect(extractCounterparty("IB BILLPAY DR-HDFCVC-BESCOM ELECTRICITY-9876543210", "BILLPAY")).toBe("BESCOM ELECTRICITY");
  });
  it("keeps the Chq./Ref.No. column verbatim (leading zeros) and never merges it with the narration", () => {
    expect(extractReference("UPI-X-Y@Z-IFSC-412345678901-N", "0000412345678901")).toBe("0000412345678901");
    expect(extractReference("NEFT CR-XX", "000123")).toBe("000123");
  });
  it("falls back to the reference embedded in the narration only when the column is empty", () => {
    expect(extractReference("UPI-X-Y@Z-IFSC-412345678901-N", undefined)).toBe("412345678901");
    expect(extractReference("SOMETHING", undefined)).toBeUndefined();
  });
});

describe("normalizeTransactions", () => {
  it("preserves the raw description and derives direction/amount/type", () => {
    const { transactions } = normalizeTransactions([row({ rawDescription: "UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678901-ORDER" })]);
    const t = transactions[0];
    expect(t.rawDescription).toBe("UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678901-ORDER");
    expect(t.direction).toBe("debit");
    expect(t.amount).toBe(250);
    expect(t.transactionType).toBe("UPI");
    expect(t.paymentMethod).toBe("UPI");
    expect(t.referenceNumber).toBe("412345678901");
    expect(t.counterparty).toBe("SWIGGY");
  });

  it("handles refunds/credits", () => {
    const { transactions } = normalizeTransactions([row({ debit: 0, credit: 499, rawDescription: "UPI-AMAZON PAY-AMAZONPAY@APL-YESB0YBLUPI-412345678902-REFUND" })]);
    expect(transactions[0].direction).toBe("credit");
    expect(transactions[0].amount).toBe(499);
  });

  it("treats negative amounts as magnitudes and nets rows with both sides", () => {
    const { transactions } = normalizeTransactions([row({ debit: -300, credit: 0 }), row({ rowIndex: 1, debit: 100, credit: 400, rawDescription: "SOMETHING ELSE" })]);
    expect(transactions[0].amount).toBe(300);
    expect(transactions[0].direction).toBe("debit");
    expect(transactions[1].direction).toBe("credit");
    expect(transactions[1].amount).toBe(300);
    expect(transactions[1].warnings.join()).toMatch(/both debit and credit/i);
  });

  it("drops malformed rows that have no amount instead of importing garbage", () => {
    const res = normalizeTransactions([row(), row({ rowIndex: 1, debit: 0, credit: 0 })]);
    expect(res.transactions).toHaveLength(1);
    expect(res.dropped).toEqual([{ rowIndex: 1, reason: "Row has no amount" }]);
  });

  it("handles missing balance and very large amounts", () => {
    const { transactions } = normalizeTransactions([row({ balance: undefined, debit: 99999999.99 })]);
    expect(transactions[0].balanceAfter).toBeUndefined();
    expect(transactions[0].amount).toBe(99999999.99);
  });
});

describe("duplicate detection keys", () => {
  it("is deterministic: the same statement always yields the same keys", () => {
    const rows = [row(), row({ rowIndex: 1, debit: 90, balance: 910, rawDescription: "UPI-ZOMATO-Z@ICICI-IFSC-412345678903-ORD" })];
    const a = normalizeTransactions(rows).transactions.map((t) => t.dedupeKey);
    const b = normalizeTransactions(rows).transactions.map((t) => t.dedupeKey);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });

  it("keeps two genuinely identical rows in one statement distinct (occurrence index)", () => {
    const same = row({ balance: undefined, rawDescription: "UPI-CHAI-CHAI@OKAXIS-IFSC-NOREF-CHAI" });
    const keys = normalizeTransactions([same, { ...same, rowIndex: 1 }]).transactions.map((t) => t.dedupeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("changes when amount, date, direction or reference changes", () => {
    const k = (over: Partial<ParsedTransaction>) => normalizeTransactions([row(over)]).transactions[0].dedupeKey;
    const base = k({});
    expect(k({ debit: 251 })).not.toBe(base);
    expect(k({ date: "2026-05-02" })).not.toBe(base);
    expect(k({ debit: 0, credit: 250 })).not.toBe(base);
    expect(k({ rawDescription: "UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-412345678999-ORDER" })).not.toBe(base);
  });

  it("is insensitive to whitespace differences in the narration", () => {
    const a = normalizeTransactions([row({ rawDescription: "UPI-SWIGGY  -SWIGGY@YBL" })]).transactions[0].dedupeKey;
    const b = normalizeTransactions([row({ rawDescription: "UPI-SWIGGY -SWIGGY@YBL" })]).transactions[0].dedupeKey;
    expect(a).toBe(b);
  });
});

describe("amount parsing", () => {
  it("parses Indian-format numbers and Cr/Dr suffixes", () => {
    expect(parseAmount("1,23,456.78")).toEqual({ value: 123456.78, sign: null });
    expect(parseAmount("500.00Cr")).toEqual({ value: 500, sign: "cr" });
    expect(parseAmount("500.00 Dr")).toEqual({ value: 500, sign: "dr" });
    expect(parseAmount("(250.50)")).toEqual({ value: 250.5, sign: "dr" });
    expect(parseAmount("-10")).toEqual({ value: 10, sign: "dr" });
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});
