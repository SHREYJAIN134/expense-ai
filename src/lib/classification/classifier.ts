/**
 * Classification pipeline (deterministic part).
 *
 *   1. user override (learned from corrections)   conf 0.99
 *   2. structural rules (ATM, fees, interest, salary/rent words, EMI, reversals)
 *   3. known merchant dictionary
 *   4. history (this merchant was classified consistently before)
 *   5. keyword analysis
 *   6. person-transfer / probable-income heuristics
 *   7. fallback OTHER / Unclassified with a low confidence
 * AI (step 8) is layered on afterwards in ai-classifier.ts, only for low-confidence rows.
 */
import { INCOME_CATEGORY, UNCLASSIFIED } from "../domain/categories";
import type { Classification, NormalizedTransaction } from "../domain/types";
import type { TxnType } from "../parsers/hdfc/normalizer";
import { looksLikePerson, matchKnownMerchant, merchantKeyOf, normalizeMerchant, titleCase } from "./merchants";
import { matchKeywords } from "./keywords";

export interface MerchantOverride {
  name?: string | null;
  category?: string | null;
  subcategory?: string | null;
}
export interface HistoryEntry {
  category: string;
  subcategory: string;
  count: number;
  confidence: number;
}
export interface ClassifierContext {
  overrides: Map<string, MerchantOverride>;
  history: Map<string, HistoryEntry>;
}

export const emptyContext = (): ClassifierContext => ({ overrides: new Map(), history: new Map() });

const FAMILY_RE = /\b(PAPA|MUMMY|MOM|MAA|DAD|FATHER|MOTHER|BRO|BHAI|SIS|DIDI|FAMILY|WIFE|HUSBAND|PARENTS?|AMMA|APPA|SON|DAUGHTER)\b/i;
const SPEND_CATEGORIES_FOR_REFUND = new Set([
  "FOOD", "GROCERIES", "TRANSPORTATION", "SHOPPING", "ENTERTAINMENT", "EDUCATION", "SUBSCRIPTIONS",
  "UTILITIES", "HEALTHCARE", "TRAVEL", "PERSONAL",
]);

/** Text safe to keyword-match: drop IFSC codes, VPAs, long numbers and masked cards. */
export function keywordText(txn: Pick<NormalizedTransaction, "description" | "counterparty">): string {
  return `${txn.counterparty ?? ""} ${txn.description}`
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, " ")
    .replace(/[\w.\-]+@[\w.\-]+/g, " ")
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/\b\d{4,6}X+\d*\b|X{4,}\d*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type MerchantRef = { name: string; key: string; confidence?: number };

function result(
  merchant: MerchantRef,
  category: string,
  subcategory: string,
  confidence: number,
  method: Classification["method"],
  reason: string,
): Classification {
  return { merchant: merchant.name, merchantKey: merchant.key, merchantConfidence: merchant.confidence ?? 0.6, category, subcategory, confidence, method, reason };
}

function structuralRule(txn: NormalizedTransaction, m: MerchantRef): Classification | undefined {
  const type = txn.transactionType as TxnType;
  const d = txn.description.toUpperCase();
  const isDebit = txn.direction === "debit";

  if (type === "ATM" && isDebit) return result(m, "ATM/CASH", "Cash Withdrawal", 0.97, "rule", "ATM withdrawal narration");
  if (type === "CASH_DEPOSIT" && !isDebit) return result(m, "ATM/CASH", "Cash Deposit", 0.9, "rule", "Cash deposit narration");
  if (type === "REVERSAL" && !isDebit) return result(m, "REFUNDS", "Reversal", 0.9, "rule", "Reversal narration");
  if (type === "FEE") {
    if (!isDebit) return result(m, "REFUNDS", "Reversal", 0.8, "rule", "Fee reversal");
    const sub = /\bGST\b|IGST|CGST|SGST/.test(d) ? "GST on Charges" : /PENAL|LATE|DISHONOU?R|RETURN|NON\s*MAINT|MIN\s*BAL/.test(d) ? "Penalties" : /INT(EREST)?\s*(CHRG|CHARGE|DEBIT)/.test(d) ? "Interest Charges" : "Bank Charges";
    return result(m, "BANKING FEES", sub, 0.95, "rule", "Bank charge narration");
  }
  if (type === "INTEREST") {
    return isDebit
      ? result(m, "BANKING FEES", "Interest Charges", 0.9, "rule", "Interest debit")
      : result(m, INCOME_CATEGORY, "Interest", 0.95, "rule", "Savings interest credit");
  }
  if (!isDebit && /\b(SALARY|PAYROLL)\b/.test(d)) return result(m, INCOME_CATEGORY, "Salary", 0.95, "rule", "Salary keyword on credit");
  if (isDebit && /\bRENT\b/.test(d) && !/\bPARENT/.test(d)) return result(m, "RENT", "Rent", 0.92, "rule", "Rent keyword");
  if (isDebit && type === "EMI") return result(m, "BILLS", "Loan EMI", 0.9, "rule", "EMI debit");
  return undefined;
}

export function classifyTransaction(txn: NormalizedTransaction, ctx: ClassifierContext = emptyContext()): Classification {
  const type = txn.transactionType as TxnType;
  const base = normalizeMerchant(txn.counterparty, txn.description, type, {
    upiId: txn.upiId,
    paymentProvider: txn.paymentProvider,
    isGateway: txn.counterpartyIsGateway,
  });
  const override = ctx.overrides.get(base.key);
  const merchant: MerchantRef = override?.name ? { name: override.name, key: base.key, confidence: 0.99 } : { name: base.name, key: base.key, confidence: base.confidence };

  // 1. user override
  if (override?.category) {
    return result(merchant, override.category, override.subcategory || UNCLASSIFIED.subcategory, 0.99, "user", "Learned from your correction");
  }

  // 2. structural rules
  const rule = structuralRule(txn, merchant);
  if (rule) return rule;

  // 2b. Only payment rails are visible (Razorpay / Paytm / ...): the real merchant is unknown. Never guess.
  if (base.gateway) {
    if (txn.direction === "credit" && txn.refundHint) return result(merchant, "REFUNDS", "Refund", 0.7, "rule", "Refund wording on a credit via a payment gateway");
    return result(merchant, "NEEDS_REVIEW", "Unresolved", 0.3, "rule", `Only the payment gateway${txn.paymentProvider ? ` (${txn.paymentProvider})` : ""} is visible; underlying merchant unknown`);
  }

  // 3. known merchant
  const known = base.known;
  if (known) {
    if (txn.direction === "credit" && SPEND_CATEGORIES_FOR_REFUND.has(known.category)) {
      return result(merchant, "REFUNDS", "Refund", Math.min(0.85, known.confidence), "merchant", `Credit from known merchant ${known.name}`);
    }
    return result(merchant, known.category, known.subcategory, known.confidence, "merchant", `Known merchant: ${known.name}`);
  }

  // 4. history
  const hist = ctx.history.get(base.key);
  if (hist && hist.count >= 2 && hist.confidence >= 0.75 && hist.category !== UNCLASSIFIED.category) {
    return result(merchant, hist.category, hist.subcategory, Math.min(0.88, hist.confidence), "history", `Classified consistently ${hist.count} times before`);
  }

  // 4b. A payment to/from an individual is a TRANSFER, whatever the free-text note says ("food", "rent share"...).
  //     Never turn a person's name into a FOOD/SHOPPING expense on a keyword.
  const railType = type === "UPI" || type === "IMPS" || type === "NEFT" || type === "RTGS" || type === "TRANSFER";
  if (railType) {
    const p = looksLikePerson(txn.counterparty);
    if (p.person) {
      if (FAMILY_RE.test(txn.counterparty ?? "") || FAMILY_RE.test(txn.description)) return result(merchant, "TRANSFERS", "Family", 0.8, "rule", "Family keyword in narration");
      return result(merchant, "TRANSFERS", "Person Transfer", p.titled ? 0.72 : 0.62, "rule", "Counterparty looks like a person - could be a friend, reimbursement, gift or shared expense");
    }
  }

  // 5. keyword analysis
  const kw = matchKeywords(keywordText(txn), txn.direction);
  if (kw) return result(merchant, kw.category, kw.subcategory, kw.confidence, "keyword", "Keyword match in narration");

  // 6. heuristics: people & probable salary
  const isBankRail = type === "UPI" || type === "IMPS" || type === "NEFT" || type === "RTGS" || type === "TRANSFER";
  if (isBankRail) {
    const { person, titled } = looksLikePerson(txn.counterparty);
    const family = FAMILY_RE.test(txn.counterparty ?? "") || (person && FAMILY_RE.test(txn.description));
    if (family) return result(merchant, "TRANSFERS", "Family", 0.8, "rule", "Family keyword in narration");
    if (person) {
      return result(merchant, "TRANSFERS", "Person Transfer", titled ? 0.72 : 0.62, "rule", "Counterparty looks like a person");
    }
    // A credit that says refund/reversal from something that is not a person is a merchant refund.
    if (txn.direction === "credit" && txn.refundHint) return result(merchant, "REFUNDS", "Refund", 0.8, "rule", "Refund wording on a credit");
    if (txn.direction === "credit" && (type === "NEFT" || type === "RTGS") && txn.counterparty) {
      return txn.amount >= 15000
        ? result(merchant, INCOME_CATEGORY, "Salary", 0.62, "rule", "Large NEFT credit from a company (probable salary)")
        : result(merchant, INCOME_CATEGORY, "Other Income", 0.5, "rule", "NEFT credit from a company");
    }
  }

  // 7. fallback
  return result(merchant, UNCLASSIFIED.category, UNCLASSIFIED.subcategory, txn.direction === "credit" ? 0.35 : 0.4, "none", "No rule matched");
}

export function classifyAll(txns: NormalizedTransaction[], ctx: ClassifierContext = emptyContext()): Classification[] {
  return txns.map((t) => classifyTransaction(t, ctx));
}

/** Convenience used by tests and the chat layer. */
export function quickMerchantKey(name: string): string {
  return merchantKeyOf(name);
}
export { matchKnownMerchant, titleCase };
