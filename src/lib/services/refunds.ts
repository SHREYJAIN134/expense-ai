/**
 * Refund linking. A refund is a CREDIT categorised REFUNDS that reverses an earlier DEBIT to the same
 * merchant. It is never a duplicate of that debit (they differ in direction) and it is linked to it so
 * analytics can net the two: "spent ₹266 at Blinkit, refunded ₹266" = ₹0 net for Blinkit / groceries.
 *
 * Matching rules (all must hold):
 *   - credit is in REFUNDS, debit is a debit to the SAME merchant (case-insensitive);
 *   - the debit is on or before the refund and within 90 days;
 *   - the debit amount is >= the refund amount (partial refunds are allowed);
 *   - the debit has not already been claimed by another refund.
 * Preference: exact amount match first, then the most recent debit.
 */
import { getDb, withTransaction } from "../db/client";
import { bumpDataVersion } from "./data";

export const REFUND_WINDOW_DAYS = 90;

export function linkRefunds(userId: string): { refunds: number; linked: number } {
  const db = getDb();
  let linked = 0;
  let refunds = 0;
  withTransaction(() => {
    db.prepare("UPDATE transactions SET is_refund = CASE WHEN direction = 'credit' AND category = 'REFUNDS' THEN 1 ELSE 0 END WHERE user_id = ?").run(userId);
    // Re-evaluate every link: categories and data may have changed since the last run.
    db.prepare("UPDATE transactions SET refund_reference = NULL WHERE user_id = ? AND refund_reference IS NOT NULL").run(userId);

    const credits = db
      .prepare("SELECT id, txn_date, amount, merchant FROM transactions WHERE user_id = ? AND is_refund = 1 AND is_primary = 1 ORDER BY txn_date, seq")
      .all(userId) as { id: string; txn_date: string; amount: number; merchant: string | null }[];
    refunds = credits.length;
    const find = db.prepare(
      `SELECT d.id FROM transactions d
       WHERE d.user_id = ? AND d.is_primary = 1 AND d.direction = 'debit' AND d.merchant = ? COLLATE NOCASE
         AND d.txn_date <= ? AND d.txn_date >= date(?, ?)
         AND d.amount >= ? - 0.005
         AND d.id NOT IN (SELECT refund_reference FROM transactions WHERE user_id = ? AND refund_reference IS NOT NULL)
       ORDER BY (ABS(d.amount - ?) < 0.005) DESC, d.txn_date DESC, d.seq DESC
       LIMIT 1`,
    );
    const set = db.prepare("UPDATE transactions SET refund_reference = ? WHERE id = ?");
    for (const c of credits) {
      if (!c.merchant) continue;
      const hit = find.get(userId, c.merchant, c.txn_date, c.txn_date, `-${REFUND_WINDOW_DAYS} days`, c.amount, userId, c.amount) as { id: string } | undefined;
      if (hit) {
        set.run(hit.id, c.id);
        linked++;
      }
    }
  });
  // A refund that could not be tied to its purchase is flagged for a person to look at - never guessed.
  db.prepare("UPDATE transactions SET semantic_type = 'REFUND_REQUIRES_REVIEW' WHERE user_id = ? AND is_refund = 1 AND refund_reference IS NULL AND semantic_type IS NULL").run(userId);
  db.prepare("UPDATE transactions SET semantic_type = NULL WHERE user_id = ? AND semantic_type = 'REFUND_REQUIRES_REVIEW' AND (is_refund = 0 OR refund_reference IS NOT NULL)").run(userId);
  bumpDataVersion(userId);
  return { refunds, linked };
}
