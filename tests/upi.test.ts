import { describe, expect, it } from "vitest";
import { detectPaymentProvider, isGatewayName, parseUpiNarration } from "../src/lib/parsers/hdfc/upi";
import { detectTransactionType, normalizeTransactions, paymentMethodFor } from "../src/lib/parsers/hdfc/normalizer";
import { normalizeMerchant } from "../src/lib/classification/merchants";
import type { ParsedTransaction } from "../src/lib/domain/types";

describe("UPI narration parsing", () => {
  it("splits merchant / UPI id / bank code / RRN / note", () => {
    const u = parseUpiNarration("UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY")!;
    expect(u).toMatchObject({ merchantName: "BLINKIT", upiId: "BLINKIT.RZP@HDFCBANK", bankCode: "HDFC0MERUPI", upiReference: "622758185216", note: "PAY VIA RAZORPAY", isAutopay: false });
    expect(u.paymentProvider).toBe("Razorpay");
  });

  it("person-to-person: name, handle-based provider (Google Pay), bank code", () => {
    const u = parseUpiNarration("UPI-RAHUL NEGI-RAKHINEGI634@OKHDFCBANK-PUNB0123456-621331236828-UPI")!;
    expect(u).toMatchObject({ merchantName: "RAHUL NEGI", upiId: "RAKHINEGI634@OKHDFCBANK", bankCode: "PUNB0123456", upiReference: "621331236828" });
    expect(u.paymentProvider).toBe("Google Pay");
  });

  it("AUTOPAY marker is not the merchant", () => {
    const g = parseUpiNarration("UPI-AUTOPAY-GOOGLE PLAY-GOOGLEPLAY@OKAXIS-UTIB0000000-623411111111-AUTOPAY")!;
    expect(g).toMatchObject({ merchantName: "GOOGLE PLAY", isAutopay: true });
    const s = parseUpiNarration("UPI-AUTOPAY-SPOTIFY INDIA PVT LTD-SPOTIFYINDIA.RZP@HDFCBANK-HDFC0MERUPI-623422222222-MANDATE")!;
    expect(s).toMatchObject({ merchantName: "SPOTIFY INDIA PVT LTD", isAutopay: true });
  });

  it("returns null for non-UPI narrations; tolerates truncated / malformed ones", () => {
    expect(parseUpiNarration("NEFT CR-HDFC0000240-ACME LTD-SALARY")).toBeNull();
    expect(parseUpiNarration("UPI-")).toMatchObject({ isAutopay: false });
    expect(parseUpiNarration("UPI-RAHUL NEGI-RAKHINEGI634@OKHDFCBANK-P")).toMatchObject({ merchantName: "RAHUL NEGI", upiId: "RAKHINEGI634@OKHDFCBANK" });
  });

  it("distinguishes payment gateways from merchants", () => {
    for (const g of ["RAZORPAY", "Razorpay Software Pvt Ltd", "PAYU", "PAYTM", "PAYTM PAYMENTS", "PhonePe", "CASHFREE", "BILLDESK", "GPAY"]) expect(isGatewayName(g), g).toBe(true);
    for (const m of ["BLINKIT", "GOOGLE INDIA DIGITAL SERVICES", "SPOTIFY INDIA PVT LTD", "PAYTM WALLET TOPUP", "RAHUL NEGI", "PAYTM INSIDER"]) expect(isGatewayName(m), m).toBe(false);
  });

  it("infers the payment provider from the handle or the narration text", () => {
    expect(detectPaymentProvider("x@ybl", "")).toBe("PhonePe");
    expect(detectPaymentProvider("x@paytm", "")).toBe("Paytm");
    expect(detectPaymentProvider("shop.rzp@icici", "")).toBe("Razorpay");
    expect(detectPaymentProvider(undefined, "PAY VIA RAZORPAY")).toBe("Razorpay");
    expect(detectPaymentProvider(undefined, "SOMETHING ELSE")).toBeUndefined();
  });
});

describe("payment method / merchant rules", () => {
  const norm = (desc: string, over: Partial<ParsedTransaction> = {}) =>
    normalizeTransactions([{ date: "2026-08-01", rawDescription: desc, debit: 100, credit: 0, rowIndex: 0, warnings: [], ...over }]).transactions[0];

  it("UPI autopay -> AUTOPAY; plain UPI -> UPI; ACH debit mandate -> AUTOPAY; ACH credit is not autopay", () => {
    expect(norm("UPI-AUTOPAY-GOOGLE PLAY-G@OKAXIS-UTIB0000000-623411111111-AUTOPAY").paymentMethod).toBe("AUTOPAY");
    expect(norm("UPI-SWIGGY-S@YBL-YESB0YBLUPI-623411111112-UPI").paymentMethod).toBe("UPI");
    expect(norm("ACH D- GROWW MUTUAL FUND SIP-123").paymentMethod).toBe("AUTOPAY");
    expect(norm("ACH C- DIVIDEND CO-123", { debit: 0, credit: 50 }).isAutopay).toBe(false);
    expect(paymentMethodFor(detectTransactionType("POS 416021XXXXXX1234 AMAZON"))).toBe("Debit Card");
  });

  it("refund wording is detected on the note, not on merchant names that merely contain 'rev'", () => {
    expect(norm("UPI-BLINKIT-B@YBL-YESB0YBLUPI-623411111113-REFUND", { debit: 0, credit: 266 }).refundHint).toBe(true);
    expect(norm("UPI-REVLON STORE-R@YBL-YESB0YBLUPI-623411111114-UPI").refundHint).toBe(false);
    expect(norm("REV-UPI-SOMETHING").refundHint).toBe(true);
  });

  it("marks gateway-only counterparties and never names the gateway as the merchant", () => {
    const t = norm("UPI-RAZORPAY-RAZORPAY@ICICI-ICIC0000001-623411111115-PAYMENT");
    expect(t.counterpartyIsGateway).toBe(true);
    const m = normalizeMerchant(t.counterparty, t.description, "UPI", { upiId: t.upiId, paymentProvider: t.paymentProvider, isGateway: t.counterpartyIsGateway });
    expect(m.gateway).toBe(true);
    expect(m.name).toBe("Unidentified merchant (Razorpay)");
    expect(m.confidence).toBeLessThan(0.4);
  });

  it("UPI notes never create a merchant: 'PAY VIA RAZORPAY' on an unknown merchant stays that merchant", () => {
    const m = normalizeMerchant("QWXZ1 KLPT", "UPI-QWXZ1 KLPT-Q@YBL-YESB0YBLUPI-623411111116-PAY VIA RAZORPAY", "UPI", { upiId: "Q@YBL", paymentProvider: "PhonePe", isGateway: false });
    expect(m.name).toBe("Qwxz1 Klpt");
    expect(m.gateway).toBeUndefined();
    expect(m.confidence).toBeLessThan(0.7); // unknown business: modest merchant confidence
  });
});
