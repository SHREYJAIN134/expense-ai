import type { PdfPage } from "../pdf-reader";
import type { Detection } from "../hdfc/detector";

/**
 * Google Pay "Transaction statement" (PDF exported from the Google Pay app).
 * Signals: the "Transaction statement period / Sent / Received" summary, the "Date & time / Transaction details /
 * Amount" table header and per-row "UPI Transaction ID:" lines. No single signal is trusted on its own.
 */
export function detectGooglePay(pages: PdfPage[]): Detection {
  const reasons: string[] = [];
  let score = 0;
  const text = pages
    .slice(0, 2)
    .map((p) => p.items.map((i) => i.str).join(" "))
    .join(" ");
  if (/transaction\s+statement\s+period/i.test(text)) {
    score += 0.35;
    reasons.push("Transaction statement period / Sent / Received summary");
  }
  if (/date\s*&\s*time/i.test(text) && /transaction\s+details/i.test(text)) {
    score += 0.2;
    reasons.push("Date & time / Transaction details table header");
  }
  if (/UPI\s+Transaction\s+ID\s*:/i.test(text)) {
    score += 0.25;
    reasons.push("UPI Transaction ID lines");
  }
  if (/\b(Paid to|Received from)\b/.test(text)) {
    score += 0.1;
    reasons.push("Paid to / Received from rows");
  }
  if (/google\s*pay/i.test(text)) {
    score += 0.1;
    reasons.push("Google Pay wording");
  }
  const matched = score >= 0.7;
  // isHdfc stays false: a Google Pay PDF mentions "HDFC Bank 1234" as the funding bank but is not an HDFC statement.
  return { isHdfc: false, matched, hasTable: /date\s*&\s*time/i.test(text), confidence: Math.min(1, score), reasons };
}
