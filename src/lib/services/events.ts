/**
 * Canonical financial events.
 *
 * `transactions` keeps one row per statement row (nothing is ever destroyed). Rows that describe the SAME real-world
 * event share an `event_id`; exactly one of them - the "primary" - is counted by analytics (`is_primary = 1`); the
 * others are corroborating copies (`is_primary = 0`) kept for provenance. A bank statement outranks an app statement,
 * so once the HDFC row for a Google Pay payment arrives, the HDFC row is the primary.
 *
 * Every function is scoped to a single user id.
 */
import { getDb, withTransaction, type DB } from "../db/client";
import type { Direction, TransactionSource, TxnMatch } from "../domain/types";
import { idKeys, SOURCE_LABEL, SOURCE_PRIORITY, type ExistingRow } from "../matching/cross-source";
import { addDays } from "../util/dates";
import { merchantKeyOf } from "../classification/merchants";
import { bumpDataVersion } from "./data";
import { linkRefunds } from "./refunds";

const priority = (s: string) => SOURCE_PRIORITY[s as TransactionSource] ?? 0;

/** Twelve-digit tokens inside a narration (UPI RRNs), the only narration digits trusted as identifiers. */
export function rrnTokens(text?: string | null): string[] {
  return text ? [...text.matchAll(/(?<!\d)\d{12}(?!\d)/g)].map((m) => m[0].replace(/^0+/, "")).filter((k) => k.length >= 10) : [];
}

/** Rows from OTHER sources that could be the same event as rows of `source` dated within [from, to] (+/- 3 days). */
export function loadMatchCandidates(userId: string, source: TransactionSource, from: string, to: string): ExistingRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, event_id, source, is_primary, direction, amount, txn_date, upi_reference, reference_number, normalized_narration, merchant, match_status
       FROM transactions WHERE user_id = ? AND source != ? AND txn_date BETWEEN ? AND ?`,
    )
    .all(userId, source, addDays(from, -3), addDays(to, 3)) as any[];
  if (!rows.length) return [];
  const evSources = new Map<string, TransactionSource[]>();
  for (const r of db.prepare("SELECT event_id, source FROM transactions WHERE user_id = ? AND event_id IN (SELECT event_id FROM transactions WHERE user_id = ? AND source != ? AND txn_date BETWEEN ? AND ?)").all(userId, userId, source, addDays(from, -3), addDays(to, 3)) as { event_id: string; source: TransactionSource }[]) {
    evSources.set(r.event_id, [...(evSources.get(r.event_id) ?? []), r.source]);
  }
  return rows.map<ExistingRow>((r) => ({
    id: r.id,
    eventId: r.event_id ?? r.id,
    source: r.source,
    isPrimary: !!r.is_primary,
    direction: r.direction as Direction,
    amount: r.amount,
    date: r.txn_date,
    ids: [...new Set([...idKeys(r.upi_reference, r.reference_number), ...rrnTokens(r.normalized_narration)])],
    merchantKey: merchantKeyOf(r.merchant ?? ""),
    eventSources: evSources.get(r.event_id ?? r.id) ?? [r.source],
    separated: r.match_status === "separate",
  }));
}

/** Short human label for the row a match points at ("HDFC · Blinkit · 2026-08-15 · ₹266"). */
export function describeExisting(db: DB, userId: string, id: string): string {
  const r = db.prepare("SELECT source, merchant, txn_date, amount FROM transactions WHERE id = ? AND user_id = ?").get(id, userId) as { source: string; merchant: string | null; txn_date: string; amount: number } | undefined;
  return r ? `${SOURCE_LABEL[r.source as TransactionSource] ?? r.source} · ${r.merchant ?? "Unknown"} · ${r.txn_date} · ₹${r.amount}` : "an earlier row";
}

interface RowLite {
  id: string;
  event_id: string;
  source: string;
  is_primary: number;
  user_edited: number;
  txn_time: string | null;
  counterparty_raw: string | null;
  semantic_type: string | null;
  category: string;
  subcategory: string;
  merchant: string | null;
  notes: string | null;
}
const LITE = "id, COALESCE(event_id, id) AS event_id, source, is_primary, user_edited, txn_time, counterparty_raw, semantic_type, category, subcategory, merchant, notes";

/**
 * Link the freshly inserted row `newId` to an existing row according to `match` (already validated by the matcher).
 * Runs inside the caller's DB transaction. Returns what happened, or null if the link is no longer valid.
 */
export function applyMatch(db: DB, userId: string, newId: string, newSource: TransactionSource, match: TxnMatch): { primaryId: string; merged: boolean } | null {
  const ex = db.prepare(`SELECT ${LITE} FROM transactions WHERE id = ? AND user_id = ?`).get(match.existingId, userId) as RowLite | undefined;
  if (!ex) return null;
  const clash = db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND event_id = ? AND source = ? AND id != ?").get(userId, ex.event_id, newSource, newId);
  if (clash) return null; // the event already has a row from this source: never two per source

  if (match.status === "potential") {
    db.prepare("UPDATE transactions SET match_status = 'potential', match_method = ?, match_confidence = ?, match_candidate_id = ? WHERE id = ? AND user_id = ?").run(match.method, match.confidence, ex.id, newId, userId);
    db.prepare("UPDATE transactions SET match_status = 'potential', match_method = ?, match_confidence = ?, match_candidate_id = ? WHERE id = ? AND user_id = ? AND match_status IS NULL").run(match.method, match.confidence, newId, ex.id, userId);
    return { primaryId: newId, merged: false };
  }
  return mergeRows(db, userId, newId, ex.id, match.method, match.confidence);
}

/** Put two rows into one event and decide which one analytics counts. */
function mergeRows(db: DB, userId: string, aId: string, bId: string, method: string, confidence: number): { primaryId: string; merged: boolean } {
  const a = db.prepare(`SELECT ${LITE} FROM transactions WHERE id = ? AND user_id = ?`).get(aId, userId) as RowLite;
  const b = db.prepare(`SELECT ${LITE} FROM transactions WHERE id = ? AND user_id = ?`).get(bId, userId) as RowLite;
  const eventId = b.event_id;
  const oldPrimary = db.prepare(`SELECT ${LITE} FROM transactions WHERE user_id = ? AND event_id = ? AND is_primary = 1`).get(userId, eventId) as RowLite | undefined;
  const aWins = !oldPrimary || priority(a.source) > priority(oldPrimary.source);
  const primary = aWins ? a : oldPrimary!;
  // a's own single-row event is absorbed
  db.prepare("UPDATE transactions SET event_id = ? WHERE user_id = ? AND event_id = ?").run(eventId, userId, a.event_id);
  db.prepare("UPDATE transactions SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ? AND event_id = ?").run(primary.id, userId, eventId);
  db.prepare("UPDATE transactions SET match_status = 'matched', match_method = ?, match_confidence = ?, match_candidate_id = CASE WHEN id = ? THEN ? ELSE ? END WHERE user_id = ? AND event_id = ?").run(method, confidence, a.id, b.id, a.id, userId, eventId);

  // Carry over what the user or the other source knows, without destroying anything on either row.
  const others = [a, b, ...(oldPrimary ? [oldPrimary] : [])].filter((r) => r.id !== primary.id);
  for (const o of others) {
    const edited = db.prepare(`SELECT ${LITE} FROM transactions WHERE id = ?`).get(o.id) as RowLite;
    if (edited.user_edited && !(db.prepare("SELECT user_edited FROM transactions WHERE id = ?").get(primary.id) as { user_edited: number }).user_edited) {
      // the user classified the other copy by hand: that decision follows the event
      db.prepare("UPDATE transactions SET category = ?, subcategory = ?, merchant = ?, notes = COALESCE(notes, ?), user_edited = 1, needs_review = 0 WHERE id = ? AND user_id = ?").run(edited.category, edited.subcategory, edited.merchant, edited.notes, primary.id, userId);
    }
    db.prepare(
      "UPDATE transactions SET txn_time = COALESCE(txn_time, ?), txn_datetime = COALESCE(txn_datetime, (SELECT txn_datetime FROM transactions WHERE id = ?)), counterparty_raw = COALESCE(counterparty_raw, ?), semantic_type = COALESCE(semantic_type, ?) WHERE id = ? AND user_id = ?",
    ).run(edited.txn_time, o.id, edited.counterparty_raw, edited.semantic_type, primary.id, userId);
  }
  return { primaryId: primary.id, merged: true };
}

/** After rows are deleted: any event left without a counted row promotes its highest-priority survivor. */
export function repairEvents(userId: string): number {
  const db = getDb();
  const orphans = db
    .prepare(
      `SELECT DISTINCT event_id FROM transactions WHERE user_id = ? AND event_id IS NOT NULL
       AND event_id NOT IN (SELECT event_id FROM transactions WHERE user_id = ? AND is_primary = 1 AND event_id IS NOT NULL)`,
    )
    .all(userId, userId) as { event_id: string }[];
  let promoted = 0;
  withTransaction(() => {
    for (const o of orphans) {
      const members = db.prepare("SELECT id, source FROM transactions WHERE user_id = ? AND event_id = ?").all(userId, o.event_id) as { id: string; source: string }[];
      if (!members.length) continue;
      members.sort((x, y) => priority(y.source) - priority(x.source));
      db.prepare("UPDATE transactions SET is_primary = 1 WHERE id = ?").run(members[0].id);
      promoted++;
    }
    // a row whose partner is gone is no longer "matched"
    db.prepare(
      `UPDATE transactions SET match_status = NULL, match_method = NULL, match_confidence = NULL, match_candidate_id = NULL
       WHERE user_id = ? AND match_status = 'matched'
         AND (SELECT COUNT(*) FROM transactions o WHERE o.user_id = transactions.user_id AND o.event_id = transactions.event_id) = 1`,
    ).run(userId);
    db.prepare(
      `UPDATE transactions SET match_status = NULL, match_method = NULL, match_confidence = NULL, match_candidate_id = NULL
       WHERE user_id = ? AND match_status = 'potential' AND (match_candidate_id IS NULL OR match_candidate_id NOT IN (SELECT id FROM transactions WHERE user_id = ?))`,
    ).run(userId, userId);
  });
  return promoted;
}

/** The user's decision on a potential match: merge the two rows into one event, or keep them separate for good. */
export function resolveMatch(userId: string, rowId: string, action: "merge" | "separate"): { ok: true; action: string } {
  const db = getDb();
  const row = db.prepare("SELECT id, match_status, match_candidate_id FROM transactions WHERE id = ? AND user_id = ?").get(rowId, userId) as { id: string; match_status: string | null; match_candidate_id: string | null } | undefined;
  if (!row || row.match_status !== "potential" || !row.match_candidate_id) return { ok: true, action: "nothing-to-resolve" };
  const other = db.prepare("SELECT id FROM transactions WHERE id = ? AND user_id = ?").get(row.match_candidate_id, userId) as { id: string } | undefined;
  withTransaction(() => {
    if (!other || action === "separate") {
      db.prepare("UPDATE transactions SET match_status = 'separate', match_method = 'user', match_confidence = NULL WHERE user_id = ? AND id IN (?, ?)").run(userId, row.id, row.match_candidate_id);
    } else {
      db.prepare("UPDATE transactions SET match_status = NULL WHERE user_id = ? AND id IN (?, ?)").run(userId, row.id, other.id);
      mergeRows(db, userId, row.id, other.id, "user", 1);
    }
  });
  bumpDataVersion(userId);
  if (action === "merge") linkRefunds(userId);
  return { ok: true, action };
}

export interface ProvenanceRow {
  id: string;
  source: TransactionSource;
  sourceLabel: string;
  isPrimary: boolean;
  date: string;
  time: string | null;
  amount: number;
  direction: Direction;
  description: string;
  counterparty: string | null;
  fundingBank: string | null;
  fundingMask: string | null;
  statementFile: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
}

export interface Provenance {
  eventId: string;
  members: ProvenanceRow[];
  sources: string[];
  potential: { id: string; source: string; date: string; amount: number; merchant: string | null; confidence: number | null } | null;
}

/** Every statement row behind the event of `txnId` (the user's own data, shown only to them). */
export function getProvenance(userId: string, txnId: string): Provenance | null {
  const db = getDb();
  const t = db.prepare("SELECT event_id, match_status, match_candidate_id, match_confidence FROM transactions WHERE id = ? AND user_id = ?").get(txnId, userId) as { event_id: string | null; match_status: string | null; match_candidate_id: string | null; match_confidence: number | null } | undefined;
  if (!t) return null;
  const eventId = t.event_id ?? txnId;
  const rows = db
    .prepare(
      `SELECT t.id, t.source, t.is_primary, t.txn_date, t.txn_time, t.amount, t.direction, t.description, t.counterparty_raw, t.funding_bank, t.funding_mask,
              t.match_method, t.match_confidence, s.filename
       FROM transactions t LEFT JOIN statements s ON s.id = t.statement_id
       WHERE t.user_id = ? AND COALESCE(t.event_id, t.id) = ? ORDER BY t.is_primary DESC, t.source`,
    )
    .all(userId, eventId) as any[];
  const members = rows.map<ProvenanceRow>((r) => ({
    id: r.id, source: r.source, sourceLabel: SOURCE_LABEL[r.source as TransactionSource] ?? r.source, isPrimary: !!r.is_primary, date: r.txn_date, time: r.txn_time,
    amount: r.amount, direction: r.direction, description: r.description, counterparty: r.counterparty_raw, fundingBank: r.funding_bank, fundingMask: r.funding_mask,
    statementFile: r.filename, matchMethod: r.match_method, matchConfidence: r.match_confidence,
  }));
  let potential: Provenance["potential"] = null;
  if (t.match_status === "potential" && t.match_candidate_id) {
    const c = db.prepare("SELECT id, source, txn_date, amount, merchant FROM transactions WHERE id = ? AND user_id = ?").get(t.match_candidate_id, userId) as any;
    if (c) potential = { id: c.id, source: SOURCE_LABEL[c.source as TransactionSource] ?? c.source, date: c.txn_date, amount: c.amount, merchant: c.merchant, confidence: t.match_confidence };
  }
  return { eventId, members, sources: [...new Set(members.map((m) => m.sourceLabel))], potential };
}
