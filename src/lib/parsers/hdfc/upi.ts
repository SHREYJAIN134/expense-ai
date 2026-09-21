/**
 * UPI narration intelligence.
 *
 * HDFC UPI narrations look like
 *     UPI-<MERCHANT OR PERSON>-<UPI ID>-<BANK CODE>-<12-digit RRN>-<NOTE>
 * e.g. UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY
 *      UPI-AUTOPAY-GOOGLE PLAY-...        (mandate / autopay debit)
 *
 * The important separation: MERCHANT (who was paid) vs UPI ID / BANK CODE / PAYMENT PROVIDER
 * (the rails: Razorpay, Paytm, Google Pay, PhonePe, a bank). Rails are never reported as the merchant.
 */
import type { UpiDetails } from "../../domain/types";

/** UPI handle (the part after @) -> app / PSP. */
const HANDLE_PROVIDERS: Record<string, string> = {
  okhdfcbank: "Google Pay", okaxis: "Google Pay", oksbi: "Google Pay", okicici: "Google Pay",
  ybl: "PhonePe", ibl: "PhonePe", axl: "PhonePe",
  paytm: "Paytm", pthdfc: "Paytm", ptyes: "Paytm", ptaxis: "Paytm", ptsbi: "Paytm",
  apl: "Amazon Pay", yapl: "Amazon Pay",
  rzp: "Razorpay", razorpay: "Razorpay", payu: "PayU", cashfree: "Cashfree", billdesk: "BillDesk",
  freecharge: "Freecharge", mbk: "MobiKwik", jupiteraxis: "Jupiter", fam: "FamPay",
  hdfcbank: "HDFC Bank UPI", axisbank: "Axis Bank UPI", icici: "ICICI Bank UPI", sbi: "SBI UPI", yesbank: "YES Bank UPI",
  upi: "UPI",
};

/** Words in a narration that name a payment gateway / processor. */
const PROVIDER_TEXT: [RegExp, string][] = [
  [/RAZORPAY|\bRZP\b/i, "Razorpay"],
  [/\bPAYU\b|PAYUMONEY/i, "PayU"],
  [/CASHFREE/i, "Cashfree"],
  [/BILLDESK/i, "BillDesk"],
  [/CCAVENUE/i, "CCAvenue"],
  [/PINE\s*LABS|PINELABS/i, "Pine Labs"],
  [/JUSPAY/i, "Juspay"],
  [/PHONEPE/i, "PhonePe"],
  [/PAYTM/i, "Paytm"],
  [/G\s?PAY|GOOGLE\s*PAY/i, "Google Pay"],
];

/**
 * A counterparty token that IS a payment gateway/processor/PSP rather than a merchant.
 * ("GOOGLE INDIA DIGITAL SERVICES" is a merchant; "RAZORPAY" or "PAYTM PAYMENTS" is rails.)
 */
export const GATEWAY_NAME_RE =
  /^(RAZORPAY|RAZORPAY SOFTWARE|PAYU|PAYU PAYMENTS?|PAYTM|PAYTM PAYMENTS?|PHONEPE|CASHFREE|CASHFREE PAYMENTS?|BILLDESK|CCAVENUE|PINE LABS|PINELABS|JUSPAY|EASEBUZZ|INSTAMOJO|BHARATPE|GPAY|GOOGLE PAY|NPCI|BHARAT BILL PAY|BBPS|UPI)(\s+(PVT|PRIVATE|LTD|LIMITED|SOFTWARE|TECHNOLOGIES|PAYMENTS?|SERVICES)\b.*)?$/i;

export function isGatewayName(name?: string): boolean {
  if (!name) return false;
  return GATEWAY_NAME_RE.test(name.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim());
}

export function detectPaymentProvider(upiId: string | undefined, text: string): string | undefined {
  if (upiId) {
    const [local, handle] = upiId.toLowerCase().split("@");
    if (/\brzp\b|[.\-_]rzp|razorpay/.test(local ?? "")) return "Razorpay";
    if (/payu/.test(local ?? "")) return "PayU";
    if (handle && HANDLE_PROVIDERS[handle]) return HANDLE_PROVIDERS[handle];
  }
  for (const [re, name] of PROVIDER_TEXT) if (re.test(text)) return name;
  return undefined;
}

const AUTOPAY_MARKER_RE = /^(AUTOPAY|AUTO\s?PAY|UPI\s?AUTOPAY|UPI\s?MANDATE|MANDATE|SI)$/i;
export const AUTOPAY_TEXT_RE = /\b(AUTOPAY|AUTO\s?PAY|UPI\s?MANDATE|UPIMANDATE|MANDATE)\b/i;
const BANK_CODE_RE = /\b([A-Z]{4}0[A-Z0-9]{5,7})\b/;
const RRN_RE = /(?<!\d)(\d{12})(?!\d)/;
export const REFUND_TEXT_RE = /\b(REFUND(?:ED)?|RFND|REVERSAL|REVERSED|REV|CANCELL?ED|CANCELLATION|RETURN(?:ED)?|CHARGEBACK)\b/i;

/** Returns null when the narration is not a UPI narration. */
export function parseUpiNarration(desc: string): UpiDetails | null {
  const s = desc.replace(/\s+/g, " ").trim();
  const parts = s.split("-").map((p) => p.trim());
  const idx = parts.findIndex((p) => /^UPI$/i.test(p));
  if (idx < 0) return null;
  let rest = parts.slice(idx + 1);
  let isAutopay = false;
  if (rest.length && AUTOPAY_MARKER_RE.test(rest[0])) {
    isAutopay = true;
    rest = rest.slice(1);
  }
  const vpaIdx = rest.findIndex((p) => p.includes("@"));
  let merchantName: string | undefined;
  let upiId: string | undefined;
  let after: string[];
  if (vpaIdx >= 0) {
    merchantName = rest.slice(0, vpaIdx).join("-").trim() || undefined;
    upiId = rest[vpaIdx].replace(/\s+/g, "");
    after = rest.slice(vpaIdx + 1);
  } else {
    merchantName = rest[0]?.trim() || undefined;
    after = rest.slice(1);
  }
  const bankCode = s.match(BANK_CODE_RE)?.[1];
  const upiReference = s.match(RRN_RE)?.[1];
  // Everything after the RRN (if present) is the free-text note.
  const rrnIdx = upiReference ? after.findIndex((p) => p.includes(upiReference)) : -1;
  const noteParts = rrnIdx >= 0 ? after.slice(rrnIdx + 1) : after.filter((p) => !BANK_CODE_RE.test(p));
  const note = noteParts.join("-").trim() || undefined;
  if (!isAutopay && note && AUTOPAY_TEXT_RE.test(note)) isAutopay = true;
  return {
    merchantName,
    upiId,
    bankCode,
    upiReference,
    note,
    isAutopay,
    paymentProvider: detectPaymentProvider(upiId, s),
  };
}
