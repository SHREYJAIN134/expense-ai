/**
 * Normalisation: ParsedTransaction -> NormalizedTransaction.
 * The narration is preserved twice: `rawNarration` (original PDF line breaks) and the re-joined
 * `rawDescription`; `normalizedNarration` is the matching/dedupe form. Nothing is discarded.
 */
import crypto from "node:crypto";
import { round2 } from "../../util/money";
import type { NormalizedTransaction, ParsedTransaction } from "../../domain/types";
import { AUTOPAY_TEXT_RE, isGatewayName, parseUpiNarration, REFUND_TEXT_RE } from "./upi";

export type TxnType =
  | "UPI" | "NEFT" | "IMPS" | "RTGS" | "POS" | "ATM" | "ACH" | "CHEQUE" | "BILLPAY"
  | "INTEREST" | "FEE" | "EMI" | "TRANSFER" | "REVERSAL" | "CASH_DEPOSIT" | "OTHER";

const TYPE_RULES: [RegExp, TxnType][] = [
  [/^(REV[-\s]|REVERSAL|.*\bREVERSAL\b)/i, "REVERSAL"],
  [/^UPI[-/ ]|\bUPI[-/]/i, "UPI"],
  [/^(ATW|NWD|EAW|ATM|CASH\s*WDL|CASH\s*WITHDRAWAL)/i, "ATM"],
  [/CASH\s*DEP|CDM\b|CASH\s*DEPOSIT/i, "CASH_DEPOSIT"],
  [/^NEFT/i, "NEFT"],
  [/^IMPS/i, "IMPS"],
  [/^RTGS/i, "RTGS"],
  [/^(POS|PCD|ECOM|E-?COM|PUR)\b/i, "POS"],
  [/^ACH\s?[DC]|\bNACH\b|\bECS\b|^SI\b/i, "ACH"],
  [/BILLPAY|BILL\s*PAY|\bBBPS\b/i, "BILLPAY"],
  [/^EMI\b|\bEMI\b/i, "EMI"],
  [/^(CHQ|CHEQUE|CLG|CTS)/i, "CHEQUE"],
  [/INT\.?\s?PD|CREDIT\s*INTEREST|INTEREST\s*(PAID|CREDIT|CAPITALI[SZ]ED)/i, "INTEREST"],
  [/CHGS|CHARGES|CHRG|\bFEE\b|\bGST\b|PENAL|SMS\s*ALERT|MIN\s*BAL/i, "FEE"],
  [/FUNDS\s*TRANSFER|\bFT\b|\bTPT\b|IB\s*FUND|SELF/i, "TRANSFER"],
];

export function detectTransactionType(raw: string): TxnType {
  const s = raw.trim();
  for (const [re, t] of TYPE_RULES) if (re.test(s)) return t;
  return "OTHER";
}

export function paymentMethodFor(type: TxnType, isAutopay = false): string | undefined {
  switch (type) {
    case "UPI": return isAutopay ? "AUTOPAY" : "UPI";
    case "NEFT": case "IMPS": case "RTGS": return type;
    case "POS": return "Debit Card";
    case "ATM": return "ATM";
    case "ACH": case "EMI": return isAutopay ? "AUTOPAY" : "Auto-debit";
    case "CHEQUE": return "Cheque";
    case "BILLPAY": return "NetBanking";
    case "TRANSFER": return "NetBanking";
    default: return undefined;
  }
}

/** 12-digit UPI/IMPS RRN embedded in the narration (NOT the Chq./Ref.No. column). */
export function extractUpiReference(raw: string): string | undefined {
  return raw.match(/(?<!\d)(\d{12})(?!\d)/)?.[1];
}

/**
 * The reference number is the Chq./Ref.No. COLUMN, verbatim (leading zeros kept, never merged into
 * the narration). Only when that column is empty do we fall back to a reference found in the narration.
 */
export function extractReference(raw: string, refColumn?: string): string | undefined {
  const ref = refColumn?.replace(/\s+/g, "");
  if (ref) return ref;
  return extractUpiReference(raw) ?? raw.match(/\b([A-Z]{4}[NR]?\d{10,})\b/)?.[1];
}

/**
 * Extract the counterparty (merchant / person / company) token from the bank
 * narration. Formats seen on HDFC statements:
 *   UPI-NAME-VPA@BANK-IFSC-REF-NOTE      NEFT CR-IFSC-SENDER-BENEFICIARY-REF
 *   IMPS-REF-NAME-BANK-ACCT-NOTE         POS 4160XXXXXX1234 MERCHANT
 *   ACH D- BILLER NAME-1234              IB BILLPAY DR-BILLER-REF
 */
export function extractCounterparty(raw: string, type: TxnType): string | undefined {
  const s = raw.replace(/\s+/g, " ").trim();
  const parts = s.split("-").map((p) => p.trim());
  const clean = (v?: string) => {
    if (!v) return undefined;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length >= 2 ? t : undefined;
  };
  switch (type) {
    case "UPI":
    case "REVERSAL": {
      const upi = parseUpiNarration(s);
      if (upi) return clean(upi.merchantName);
      const i = parts.findIndex((p) => /^UPI$/i.test(p));
      return clean(parts[i >= 0 ? i + 1 : 1]);
    }
    case "NEFT":
    case "RTGS": {
      // NEFT CR-IFSC-SENDER-BENEFICIARY-REF ; NEFT DR-IFSC-BENEFICIARY-...
      const idx = parts.findIndex((p) => /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(p));
      return clean(parts[idx >= 0 ? idx + 1 : 2]);
    }
    case "IMPS":
      return clean(parts[2]) ?? clean(parts[1]);
    case "POS": {
      const m = s.match(/^POS\s+\S*[Xx*]{2,}\d{2,6}\s+(.+)$/i) ?? s.match(/^POS\s+(.+)$/i);
      return clean(m?.[1]);
    }
    case "ACH": {
      const m = s.match(/^ACH\s?[DC]\s*-\s*(.+?)(?:-\d+)?$/i);
      return clean(m?.[1]?.replace(/^TP ACH\s+/i, ""));
    }
    case "BILLPAY": {
      const bp = parts.filter((p) => !/BILLPAY|^HDFCVC$|^\d+$|^IB\b/i.test(p));
      return clean(bp[0]);
    }
    case "ATM":
      return "ATM";
    case "INTEREST":
      return "HDFC Bank Interest";
    case "FEE":
      return "HDFC Bank";
    default: {
      const m = s.match(/^[0-9]{6,}-TPT-(.+?)-(.+)$/i);
      if (m) return clean(m[2]);
      return clean(s.length > 40 ? s.slice(0, 40) : s);
    }
  }
}

/** Canonical form for comparing narrations across statement uploads. */
export function normalizeDescriptionForKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/**
 * Deterministic duplicate key. Uses ALL strong evidence: both dates, direction, amount, normalised
 * narration, the Chq./Ref.No. and the running balance. Direction is part of the key on purpose: a ₹266
 * debit and a ₹266 refund CREDIT from the same merchant are different transactions, never duplicates.
 */
export function buildDedupeBase(t: {
  txnDate: string;
  valueDate?: string;
  direction: string;
  amount: number;
  description: string;
  reference?: string;
  balanceAfter?: number;
}): string {
  return [
    t.txnDate,
    t.valueDate ?? "",
    t.direction,
    t.amount.toFixed(2),
    normalizeDescriptionForKey(t.description),
    (t.reference ?? "").replace(/^0+/, ""),
    t.balanceAfter === undefined ? "" : t.balanceAfter.toFixed(2),
  ].join("|");
}

export function hashKey(base: string, occurrence: number): string {
  return crypto.createHash("sha256").update(`${base}#${occurrence}`).digest("hex").slice(0, 40);
}

export interface NormalizeResult {
  transactions: NormalizedTransaction[];
  dropped: { rowIndex: number; reason: string }[];
}

export function normalizeTransactions(parsed: ParsedTransaction[]): NormalizeResult {
  const out: NormalizedTransaction[] = [];
  const dropped: NormalizeResult["dropped"] = [];
  const seen = new Map<string, number>();

  for (const p of parsed) {
    const warnings = [...p.warnings];
    const debit = round2(Math.abs(p.debit));
    const credit = round2(Math.abs(p.credit));
    if (debit === 0 && credit === 0) {
      dropped.push({ rowIndex: p.rowIndex, reason: "Row has no amount" });
      continue;
    }
    // If both are present, keep the net movement.
    let d = debit;
    let c = credit;
    if (d > 0 && c > 0) {
      const net = round2(c - d);
      d = net < 0 ? -net : 0;
      c = net > 0 ? net : 0;
      warnings.push("Row had both debit and credit; net amount used");
    }
    const direction = c > 0 ? "credit" : "debit";
    const amount = direction === "credit" ? c : d;
    const description = p.rawDescription.replace(/\s+/g, " ").trim();
    const rawNarration = (p.narrationLines?.length ? p.narrationLines : [p.rawDescription]).join("\n");
    const type = detectTransactionType(description);
    const upi = type === "UPI" || type === "REVERSAL" ? parseUpiNarration(description) : null;
    // UPI autopay mandates and ACH/NACH debits are standing instructions.
    const isAutopay = !!upi?.isAutopay || (type === "ACH" && direction === "debit") || (type === "EMI" && AUTOPAY_TEXT_RE.test(description));
    const referenceNumber = extractReference(description, p.reference);
    const counterparty = extractCounterparty(description, type);

    const base = buildDedupeBase({
      txnDate: p.date,
      valueDate: p.valueDate,
      direction,
      amount,
      description,
      reference: referenceNumber,
      balanceAfter: p.balance,
    });
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);

    out.push({
      txnDate: p.date,
      valueDate: p.valueDate,
      seq: out.length,
      rawNarration,
      rawDescription: p.rawDescription,
      description,
      normalizedNarration: normalizeDescriptionForKey(description),
      referenceNumber,
      upiReference: upi?.upiReference ?? extractUpiReference(description),
      upiId: upi?.upiId,
      upiBankCode: upi?.bankCode,
      paymentProvider: upi?.paymentProvider,
      debit: d,
      credit: c,
      amount,
      direction,
      transactionType: type,
      paymentMethod: paymentMethodFor(type, isAutopay),
      balanceAfter: p.balance,
      counterparty,
      counterpartyIsGateway: type === "UPI" ? isGatewayName(counterparty) : false,
      isAutopay,
      refundHint: type === "REVERSAL" || REFUND_TEXT_RE.test(upi?.note ?? description),
      dedupeKey: hashKey(base, occurrence),
      warnings,
    });
  }
  return { transactions: out, dropped };
}
