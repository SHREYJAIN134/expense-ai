/**
 * Cross-source matching: deciding whether a row from one statement is the SAME real-world financial event as a
 * row already imported from another source (e.g. a Google Pay payment and the HDFC debit it produced).
 *
 * Principles
 *  - A shared UPI transaction id is the only automatic evidence. HDFC prints it in the narration (12-digit RRN) and in
 *    the Chq./Ref.No. column (zero padded); Google Pay prints it as "UPI Transaction ID". When two rows share an id and
 *    also agree on direction and amount (date within 2 days: banks sometimes post after midnight) they are merged.
 *  - Same date + same amount is NOT evidence: many legitimate payments look alike. If both rows carry ids and the ids
 *    differ, they are different events, full stop.
 *  - Only when one side has no id at all can other evidence (direction, amount, date within 1 day, same merchant,
 *    and a UNIQUE one-to-one pairing) raise a "potential" match. Potential matches are never merged automatically:
 *    a person decides.
 *  - One event holds at most one row per source, and one existing row can be claimed by at most one incoming row.
 */
import type { Direction, TransactionSource, TxnMatch } from "../domain/types";
import { daysBetween } from "../util/dates";

/** Which source is the ledger of record for an event: higher wins. A bank statement outranks an app statement. */
export const SOURCE_PRIORITY: Record<TransactionSource, number> = { HDFC: 2, GOOGLE_PAY: 1 };
export const SOURCE_LABEL: Record<TransactionSource, string> = { HDFC: "HDFC", GOOGLE_PAY: "Google Pay" };

export interface ExistingRow {
  id: string;
  eventId: string;
  source: TransactionSource;
  isPrimary: boolean;
  direction: Direction;
  amount: number;
  date: string;
  ids: string[];
  merchantKey: string;
  /** Sources already present in this row's event (an event has at most one row per source). */
  eventSources: TransactionSource[];
  /** The user said these two are different: never propose them again. */
  separated?: boolean;
}

export interface IncomingRow {
  index: number;
  source: TransactionSource;
  direction: Direction;
  amount: number;
  date: string;
  ids: string[];
  merchantKey: string;
}

/** Normalise the digit strings that identify a UPI payment: 10+ digits, leading zeros removed ("0000127425097485"). */
export function idKeys(...values: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const m of v.matchAll(/\d{10,20}/g)) {
      const k = m[0].replace(/^0+/, "");
      if (k.length >= 10) out.add(k);
    }
  }
  return [...out];
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;
const dateGap = (a: string, b: string) => Math.abs(daysBetween(a, b));

export function matchAcrossSources(incoming: IncomingRow[], existing: ExistingRow[]): Map<number, TxnMatch> {
  const result = new Map<number, TxnMatch>();
  const claimed = new Set<string>();
  const byId = new Map<string, ExistingRow[]>();
  for (const e of existing) for (const k of e.ids) byId.set(k, [...(byId.get(k) ?? []), e]);

  const toMatch = (e: ExistingRow, status: TxnMatch["status"], method: TxnMatch["method"], confidence: number, reason: string): TxnMatch => ({
    status,
    method,
    confidence,
    reason,
    existingId: e.id,
    existingEventId: e.eventId,
    existingSource: e.source,
    existingIsPrimary: e.isPrimary,
  });
  const available = (e: ExistingRow, r: IncomingRow) => !claimed.has(e.id) && !e.separated && !e.eventSources.includes(r.source);

  /* Tier 1: a shared transaction id */
  for (const r of incoming) {
    const cands = new Map<string, ExistingRow>();
    for (const k of r.ids) for (const e of byId.get(k) ?? []) if (available(e, r)) cands.set(e.id, e);
    if (!cands.size) continue;
    const agreeing = [...cands.values()].filter((e) => e.direction === r.direction && sameAmount(e.amount, r.amount) && dateGap(e.date, r.date) <= 2);
    if (agreeing.length) {
      const best = agreeing.sort((a, b) => dateGap(a.date, r.date) - dateGap(b.date, r.date))[0];
      claimed.add(best.id);
      const gap = dateGap(best.date, r.date);
      result.set(r.index, toMatch(best, "matched", "upi_id", gap <= 1 ? 0.99 : 0.95, `Same UPI transaction id, direction and amount${gap ? ` (dates ${gap} day${gap > 1 ? "s" : ""} apart)` : ""}.`));
    } else {
      const e = [...cands.values()][0];
      claimed.add(e.id);
      result.set(r.index, toMatch(e, "potential", "upi_id", 0.5, "Same UPI transaction id but a different amount, direction or date - check both entries."));
    }
  }

  /* Tier 2: no id on at least one side, unique one-to-one pairing on everything else */
  const loose = incoming.filter((r) => !result.has(r.index));
  const compatible = (r: IncomingRow, e: ExistingRow) =>
    available(e, r) &&
    e.direction === r.direction &&
    sameAmount(e.amount, r.amount) &&
    dateGap(e.date, r.date) <= 1 &&
    !!r.merchantKey &&
    r.merchantKey === e.merchantKey &&
    (r.ids.length === 0 || e.ids.length === 0); // both sides carry ids and they differ -> different events
  for (const r of loose) {
    const cands = existing.filter((e) => compatible(r, e));
    if (cands.length !== 1) continue; // none, or ambiguous
    const rivals = loose.filter((o) => compatible(o, cands[0]));
    if (rivals.length !== 1) continue; // another incoming row could equally be this one
    claimed.add(cands[0].id);
    result.set(r.index, toMatch(cands[0], "potential", "heuristic", 0.7, "Same direction, amount, merchant and date, but no shared transaction id to prove it - confirm to merge."));
  }
  return result;
}
