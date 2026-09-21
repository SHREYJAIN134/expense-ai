/**
 * Google Pay reconciliation. There is no bank balance model here, so the checks are:
 *
 *   SUM(paid rows)     = the statement's official "Sent"
 *   SUM(received rows) = the statement's official "Received"
 *
 * Google Pay states that SELF TRANSFERS are not included in those totals. Rows we know to be self transfers are
 * therefore left out of the calculated side. If the totals still differ, and a set of rows that MIGHT be self
 * transfers would explain the difference exactly, the result is `requires_review` (a person must decide) - never
 * `reconciled`. If nothing explains it, it is a plain `mismatch`.
 */
import { round2 } from "../../util/money";
import type { Direction, Reconciliation } from "../../domain/types";

export interface GPayRow {
  direction: Direction;
  amount: number;
  /** SELF_TRANSFER (known: excluded from the totals) | POSSIBLE_SELF_TRANSFER (unsure) | anything else. */
  semanticType?: string;
}

const EPS = 0.005;

/** Is there a subset of `candidates` (n <= 16) that sums to `target`? */
function subsetSums(candidates: number[], target: number): boolean {
  const n = Math.min(candidates.length, 16);
  for (let mask = 1; mask < 1 << n; mask++) {
    let t = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) t += candidates[i];
    if (Math.abs(t - target) < EPS) return true;
  }
  return false;
}

export function reconcileGooglePay(official: { sent: number; received: number } | undefined, rows: GPayRow[]): Reconciliation {
  const known = rows.filter((r) => r.semanticType === "SELF_TRANSFER");
  const counted = rows.filter((r) => r.semanticType !== "SELF_TRANSFER");
  const sum = (dir: Direction) => round2(counted.filter((r) => r.direction === dir).reduce((a, r) => a + r.amount, 0));
  const sent = sum("debit");
  const received = sum("credit");
  const debits = rows.filter((r) => r.direction === "debit");
  const credits = rows.filter((r) => r.direction === "credit");
  const base = {
    calculated: {
      debitCount: debits.length,
      creditCount: credits.length,
      totalDebits: round2(debits.reduce((a, r) => a + r.amount, 0)),
      totalCredits: round2(credits.reduce((a, r) => a + r.amount, 0)),
    },
    balanceChain: { checked: 0, breaks: [], corrections: 0 },
  };
  const excludedSelf = round2(known.reduce((a, r) => a + r.amount, 0));
  if (!official) {
    return { status: "no_summary", official: null, ...base, checks: [], issues: ["The statement's Sent / Received totals were not found, so it cannot be reconciled."] };
  }
  const sentOk = Math.abs(sent - official.sent) < EPS;
  const recvOk = Math.abs(received - official.received) < EPS;
  const checks = [
    { key: "sent", label: "Total sent (paid rows)", ok: sentOk, official: official.sent, calculated: sent },
    { key: "received", label: "Total received (received rows)", ok: recvOk, official: official.received, calculated: received },
  ];
  const issues: string[] = [];
  let status: Reconciliation["status"] = "reconciled";
  if (!sentOk || !recvOk) {
    // Could rows we are unsure about (possible self transfers) explain the gap exactly?
    const possible = rows.filter((r) => r.semanticType === "POSSIBLE_SELF_TRANSFER");
    const explains = (dir: Direction, diff: number) => diff < EPS || subsetSums(possible.filter((r) => r.direction === dir).map((r) => r.amount), diff);
    const sentGap = round2(sent - official.sent);
    const recvGap = round2(received - official.received);
    const explainable = (sentOk || (sentGap > 0 && explains("debit", sentGap))) && (recvOk || (recvGap > 0 && explains("credit", recvGap)));
    status = explainable && possible.length > 0 ? "requires_review" : "mismatch";
    if (!sentOk) issues.push(`Paid rows add up to ${sent} but the statement says Sent ${official.sent}.`);
    if (!recvOk) issues.push(`Received rows add up to ${received} but the statement says Received ${official.received}.`);
    if (status === "requires_review") issues.push("The difference would disappear if some transactions that may be transfers between your own accounts were excluded (Google Pay leaves those out of its totals). Review them before importing.");
  }
  return {
    status,
    official: null,
    providerTotals: { sent: official.sent, received: official.received, sentCalculated: sent, receivedCalculated: received, excludedSelfTransfers: excludedSelf },
    ...base,
    checks,
    issues,
  };
}
