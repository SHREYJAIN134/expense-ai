/**
 * Google Pay ParsedStatement -> canonical NormalizedTransaction.
 *
 * Kept deliberately literal: the counterparty is preserved as printed (`counterpartyRaw`); merchant normalisation
 * ("Zepto Marketplace Pr" -> Zepto) happens later in the shared classifier, and personal names are never merged or
 * turned into merchants. The funding bank is recorded separately and is never the merchant.
 */
import crypto from "node:crypto";
import type { NormalizedTransaction, ParsedStatement } from "../../domain/types";
import { round2 } from "../../util/money";
import { looksLikePerson, matchKnownMerchant } from "../../classification/merchants";
import { isGatewayName } from "../hdfc/upi";
import type { NormalizeResult } from "../hdfc/normalizer";

export function gpayDedupeKey(providerTxnId: string, direction: string, amount: number): string {
  return crypto.createHash("sha256").update(`GOOGLE_PAY|${providerTxnId}|${direction}|${amount.toFixed(2)}`).digest("hex").slice(0, 40);
}

/** Person / unknown-counterparty semantics from the name alone. Never a category; only a "look at this" signal. */
export function counterpartySemantics(name: string): "PERSON_TO_PERSON" | "UNKNOWN_COUNTERPARTY" | undefined {
  if (matchKnownMerchant(name) || isGatewayName(name)) return undefined;
  if (looksLikePerson(name).person) return "PERSON_TO_PERSON";
  // One bare alphabetic word ("Aditya", "Kiddo") could be a person or a tiny shop: cannot tell, so say so.
  if (/^[A-Za-z]{2,}$/.test(name.trim())) return "UNKNOWN_COUNTERPARTY";
  return undefined;
}

export function normalizeGooglePay(statement: ParsedStatement): NormalizeResult {
  const out: NormalizedTransaction[] = [];
  const dropped: NormalizeResult["dropped"] = [];
  statement.transactions.forEach((p, i) => {
    const debit = round2(Math.abs(p.debit));
    const credit = round2(Math.abs(p.credit));
    if ((debit === 0 && credit === 0) || !p.providerTxnId || !p.counterparty) {
      dropped.push({ rowIndex: p.rowIndex, reason: "Row is missing an amount, counterparty or transaction id" });
      return;
    }
    const direction = debit > 0 ? "debit" : "credit";
    const amount = debit > 0 ? debit : credit;
    const counterparty = p.counterparty;
    const description = `UPI ${counterparty}`;
    out.push({
      txnDate: p.date,
      seq: i,
      rawNarration: (p.narrationLines ?? [p.rawDescription]).join("\n"),
      rawDescription: p.rawDescription,
      description,
      normalizedNarration: `${counterparty} ${p.providerTxnId}`.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(),
      upiReference: p.providerTxnId,
      paymentProvider: "Google Pay",
      debit,
      credit,
      amount,
      direction,
      transactionType: "UPI",
      paymentMethod: "UPI",
      counterparty,
      counterpartyIsGateway: isGatewayName(counterparty),
      isAutopay: false,
      refundHint: false,
      dedupeKey: gpayDedupeKey(p.providerTxnId, direction, amount),
      warnings: [...p.warnings],
      source: "GOOGLE_PAY",
      txnTime: p.time,
      txnDateTime: p.time ? `${p.date}T${p.time}` : undefined,
      counterpartyRaw: counterparty,
      fundingBank: p.fundingBank,
      fundingMask: p.fundingMask,
      semanticType: counterpartySemantics(counterparty),
    });
  });
  return { transactions: out, dropped };
}
