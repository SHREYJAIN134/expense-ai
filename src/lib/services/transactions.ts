import { anomalyFlags } from "./intelligence";
import { getDb, uid, withTransaction } from "../db/client";
import { getUserCategories } from "./users";
import { bumpDataVersion } from "./data";
import { linkRefunds } from "./refunds";
import { merchantKeyOf, normalizeMerchant } from "../classification/merchants";
import { detectTransactionType, extractCounterparty, type TxnType } from "../parsers/hdfc/normalizer";
import { ApiError } from "../auth/guard";

export interface TxnQuery {
  q?: string;
  from?: string;
  to?: string;
  category?: string;
  subcategory?: string;
  merchant?: string;
  direction?: "debit" | "credit";
  minAmount?: number;
  maxAmount?: number;
  statementId?: string;
  lowConfidence?: boolean;
  /** Show events that appear in this source (an event found in both HDFC and Google Pay matches either). */
  source?: string;
  /** "potential" = rows that might be the same payment as another source's row and await a decision. */
  matchStatus?: "potential";
  /** refund = credits that reverse a purchase; recurring = part of a recurring series; moved = transfers / investments (not spending). */
  flag?: "refund" | "recurring" | "moved";
  sort?: "date" | "amount" | "merchant" | "category";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

const SORT_COLUMNS: Record<string, string> = {
  date: "t.txn_date",
  amount: "t.amount",
  merchant: "t.merchant COLLATE NOCASE",
  category: "t.category",
};

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

function buildWhere(userId: string, q: TxnQuery) {
  // Only the row analytics counts is listed; corroborating copies from other sources are reachable through provenance.
  const where: string[] = ["t.user_id = ?", "t.is_primary = 1"];
  const args: (string | number)[] = [userId];
  if (q.q?.trim()) {
    const like = `%${escapeLike(q.q.trim())}%`;
    where.push("(t.description LIKE ? ESCAPE '\\' OR t.merchant LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\' OR t.reference_number LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const add = (clause: string, value: string | number) => {
    where.push(clause);
    args.push(value);
  };
  if (q.from) add("t.txn_date >= ?", q.from);
  if (q.to) add("t.txn_date <= ?", q.to);
  if (q.category) add("t.category = ?", q.category);
  if (q.subcategory) add("t.subcategory = ?", q.subcategory);
  if (q.merchant) add("t.merchant = ? COLLATE NOCASE", q.merchant);
  if (q.direction) add("t.direction = ?", q.direction);
  if (q.minAmount !== undefined) add("t.amount >= ?", q.minAmount);
  if (q.maxAmount !== undefined) add("t.amount <= ?", q.maxAmount);
  if (q.statementId) add("t.statement_id = ?", q.statementId);
  // "Needs review" = low confidence, unresolved gateway-only merchants, or parser warnings.
  if (q.lowConfidence) where.push("(t.needs_review = 1 OR t.classification_confidence < 0.6)");
  if (q.source) {
    where.push("EXISTS (SELECT 1 FROM transactions m WHERE m.user_id = t.user_id AND m.event_id = t.event_id AND m.source = ?)");
    args.push(q.source);
  }
  if (q.matchStatus === "potential") where.push("t.match_status = 'potential'");
  if (q.flag === "refund") where.push("t.is_refund = 1");
  if (q.flag === "recurring") where.push("t.is_recurring = 1");
  if (q.flag === "moved") where.push("t.category IN ('TRANSFERS', 'INVESTMENTS')");
  return { sql: where.join(" AND "), args };
}

export interface TxnRow {
  id: string;
  date: string;
  valueDate: string | null;
  description: string;
  rawDescription: string;
  reference: string | null;
  debit: number;
  credit: number;
  amount: number;
  direction: "debit" | "credit";
  type: string;
  balanceAfter: number | null;
  merchant: string | null;
  category: string;
  subcategory: string;
  confidence: number;
  source: string;
  paymentMethod: string | null;
  isRecurring: boolean;
  notes: string | null;
  userEdited: boolean;
  statementId: string | null;
  isDemo: boolean;
  rawNarration: string | null;
  merchantConfidence: number;
  paymentProvider: string | null;
  upiId: string | null;
  upiBankCode: string | null;
  upiReference: string | null;
  isRefund: boolean;
  refundReference: string | null;
  isRecurringCandidate: boolean;
  recurringConfidence: number;
  needsReview: boolean;
  /** Statement source of the counted row (HDFC / GOOGLE_PAY). `source` above is the classification method. */
  txnSource: string;
  /** Every source that reported this event, e.g. ["HDFC", "GOOGLE_PAY"]. */
  eventSources: string[];
  time: string | null;
  counterpartyRaw: string | null;
  fundingBank: string | null;
  fundingMask: string | null;
  semanticType: string | null;
  /** matched | potential | separate | null */
  matchStatus: string | null;
  matchConfidence: number | null;
  /** Strongest unusual-activity finding that references this transaction (statistical, not a fraud verdict). */
  unusual?: { id: string; type: string; severity: string; reason: string } | null;
}

const COLS = `t.id, t.txn_date, t.value_date, t.description, t.raw_description, t.reference_number, t.debit, t.credit, t.amount,
  t.direction, t.transaction_type, t.balance_after, t.merchant, t.category, t.subcategory, t.classification_confidence,
  t.classification_source, t.payment_method, t.is_recurring, t.notes, t.user_edited, t.statement_id, t.is_demo,
  t.raw_narration, t.merchant_confidence, t.payment_provider, t.upi_id, t.upi_bank_code, t.upi_reference,
  t.is_refund, t.refund_reference, t.is_recurring_candidate, t.recurring_confidence, t.needs_review,
  t.source AS txn_source, t.txn_time, t.counterparty_raw, t.funding_bank, t.funding_mask, t.semantic_type, t.match_status, t.match_confidence,
  (SELECT GROUP_CONCAT(DISTINCT m.source) FROM transactions m WHERE m.user_id = t.user_id AND m.event_id = t.event_id) AS event_sources`;

function mapRow(r: any): TxnRow {
  return {
    id: r.id,
    date: r.txn_date,
    valueDate: r.value_date,
    description: r.description,
    rawDescription: r.raw_description,
    reference: r.reference_number,
    debit: r.debit,
    credit: r.credit,
    amount: r.amount,
    direction: r.direction,
    type: r.transaction_type,
    balanceAfter: r.balance_after,
    merchant: r.merchant,
    category: r.category,
    subcategory: r.subcategory,
    confidence: r.classification_confidence,
    source: r.classification_source,
    paymentMethod: r.payment_method,
    isRecurring: !!r.is_recurring,
    notes: r.notes,
    userEdited: !!r.user_edited,
    statementId: r.statement_id,
    isDemo: !!r.is_demo,
    rawNarration: r.raw_narration,
    merchantConfidence: r.merchant_confidence,
    paymentProvider: r.payment_provider,
    upiId: r.upi_id,
    upiBankCode: r.upi_bank_code,
    upiReference: r.upi_reference,
    isRefund: !!r.is_refund,
    refundReference: r.refund_reference,
    isRecurringCandidate: !!r.is_recurring_candidate,
    recurringConfidence: r.recurring_confidence,
    needsReview: !!r.needs_review,
    txnSource: r.txn_source,
    eventSources: String(r.event_sources ?? r.txn_source ?? "HDFC").split(",").sort(),
    time: r.txn_time,
    counterpartyRaw: r.counterparty_raw,
    fundingBank: r.funding_bank,
    fundingMask: r.funding_mask,
    semanticType: r.semantic_type,
    matchStatus: r.match_status,
    matchConfidence: r.match_confidence,
  };
}

export function queryTransactions(userId: string, q: TxnQuery) {
  const db = getDb();
  const { sql, args } = buildWhere(userId, q);
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 25));
  const page = Math.max(1, q.page ?? 1);
  const sortCol = SORT_COLUMNS[q.sort ?? "date"] ?? SORT_COLUMNS.date;
  const dir = q.dir === "asc" ? "ASC" : "DESC";
  const flags = anomalyFlags(userId);
  const totals = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(t.debit),0) AS debits, COALESCE(SUM(t.credit),0) AS credits FROM transactions t WHERE ${sql}`)
    .get(...args) as { n: number; debits: number; credits: number };
  const rows = db
    .prepare(`SELECT ${COLS} FROM transactions t WHERE ${sql} ORDER BY ${sortCol} ${dir}, t.txn_date ${dir}, t.seq ${dir}, t.id LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as any[];
  return {
    rows: rows.map((r) => ({ ...mapRow(r), unusual: flags.get(r.id) ?? null })),
    total: totals.n,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(totals.n / pageSize)),
    totals: { debits: Math.round(totals.debits * 100) / 100, credits: Math.round(totals.credits * 100) / 100 },
  };
}

/** All rows matching the filter (for CSV export). Capped to protect memory. */
export function exportTransactions(userId: string, q: TxnQuery, cap = 200_000): TxnRow[] {
  const { sql, args } = buildWhere(userId, q);
  const dir = q.dir === "asc" ? "ASC" : "DESC";
  const sortCol = SORT_COLUMNS[q.sort ?? "date"] ?? SORT_COLUMNS.date;
  return (
    getDb()
      .prepare(`SELECT ${COLS} FROM transactions t WHERE ${sql} ORDER BY ${sortCol} ${dir}, t.seq ${dir} LIMIT ?`)
      .all(...args, cap) as any[]
  ).map(mapRow);
}

export function getTransaction(userId: string, id: string) {
  const row = getDb().prepare(`SELECT ${COLS} FROM transactions t WHERE t.user_id = ? AND t.id = ?`).get(userId, id);
  if (!row) return null;
  const history = getDb()
    .prepare("SELECT merchant, category, subcategory, confidence, method, reason, is_current, created_at FROM transaction_classifications WHERE transaction_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(id, userId);
  return { ...mapRow(row), unusual: anomalyFlags(userId).get(id) ?? null, classificationHistory: history };
}

export function filterOptions(userId: string) {
  const db = getDb();
  const merchants = db
    .prepare("SELECT merchant, COUNT(*) AS n FROM transactions WHERE user_id = ? AND is_primary = 1 AND merchant IS NOT NULL GROUP BY merchant ORDER BY n DESC LIMIT 500")
    .all(userId) as { merchant: string; n: number }[];
  return { merchants: merchants.map((m) => m.merchant), categories: getUserCategories(userId) };
}

/** Base merchant key derived deterministically from the original narration (independent of renames). */
export function baseMerchantKey(rawDescription: string): string {
  const desc = rawDescription.replace(/\s+/g, " ").trim();
  const type = detectTransactionType(desc) as TxnType;
  return normalizeMerchant(extractCounterparty(desc, type), desc, type).key;
}

export interface TxnPatch {
  category?: string;
  subcategory?: string;
  merchant?: string;
  notes?: string | null;
  /** Apply the category/merchant fix to all of this merchant's transactions and remember it for future imports. */
  applyToSimilar?: boolean;
}

export function updateTransaction(userId: string, id: string, patch: TxnPatch) {
  const db = getDb();
  const cur = db
    .prepare("SELECT id, merchant, category, subcategory, raw_description FROM transactions WHERE id = ? AND user_id = ?")
    .get(id, userId) as { id: string; merchant: string | null; category: string; subcategory: string; raw_description: string } | undefined;
  if (!cur) throw new ApiError(404, "NOT_FOUND", "Transaction not found.");

  if (patch.category !== undefined) {
    const cats = getUserCategories(userId);
    const c = cats.find((x) => x.name === patch.category);
    if (!c) throw new ApiError(400, "BAD_CATEGORY", "Unknown category.");
    if (patch.subcategory && !c.subcategories.some((s) => s.name === patch.subcategory)) {
      throw new ApiError(400, "BAD_CATEGORY", "Unknown subcategory for that category.");
    }
  }

  let affected = 1;
  withTransaction(() => {
    const newCategory = patch.category ?? cur.category;
    const newSub = patch.subcategory ?? (patch.category && patch.category !== cur.category ? "" : cur.subcategory);
    const categoryChanged = patch.category !== undefined && (patch.category !== cur.category || (patch.subcategory ?? cur.subcategory) !== cur.subcategory);
    const merchantChanged = patch.merchant !== undefined && patch.merchant.trim() !== (cur.merchant ?? "");
    const newMerchant = merchantChanged ? patch.merchant!.trim() : cur.merchant;

    db.prepare(
      `UPDATE transactions SET category = ?, subcategory = ?, merchant = ?, notes = COALESCE(?, notes),
         classification_confidence = CASE WHEN ? THEN 0.99 ELSE classification_confidence END,
         classification_source = CASE WHEN ? THEN 'user' ELSE classification_source END,
         user_edited = CASE WHEN ? OR ? THEN 1 ELSE user_edited END, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    ).run(
      newCategory,
      newSub || "Unclassified",
      newMerchant,
      patch.notes === undefined ? null : patch.notes,
      categoryChanged ? 1 : 0,
      categoryChanged ? 1 : 0,
      categoryChanged ? 1 : 0,
      merchantChanged ? 1 : 0,
      id,
      userId,
    );
    if (patch.notes === null) db.prepare("UPDATE transactions SET notes = NULL WHERE id = ? AND user_id = ?").run(id, userId);

    if (categoryChanged || merchantChanged) {
      db.prepare("UPDATE transaction_classifications SET is_current = 0 WHERE transaction_id = ?").run(id);
      db.prepare(
        "INSERT INTO transaction_classifications (id, transaction_id, user_id, merchant, category, subcategory, confidence, method, reason) VALUES (?, ?, ?, ?, ?, ?, 0.99, 'user', 'Manual correction')",
      ).run(uid(), id, userId, newMerchant, newCategory, newSub || "Unclassified");
    }

    // Learning: remember the correction for this merchant and re-apply to siblings.
    if ((categoryChanged || merchantChanged) && patch.applyToSimilar !== false) {
      const key = baseMerchantKey(cur.raw_description);
      db.prepare(
        `INSERT INTO merchant_overrides (id, user_id, merchant_key, merchant_name, category, subcategory)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, merchant_key) DO UPDATE SET
           merchant_name = COALESCE(excluded.merchant_name, merchant_name),
           category = COALESCE(excluded.category, category),
           subcategory = COALESCE(excluded.subcategory, subcategory),
           updated_at = datetime('now')`,
      ).run(uid(), userId, key, merchantChanged ? newMerchant : null, categoryChanged ? newCategory : null, categoryChanged ? newSub || null : null);

      if (cur.merchant) {
        const sib = db.prepare(
          `UPDATE transactions SET
             category = CASE WHEN ? THEN ? ELSE category END,
             subcategory = CASE WHEN ? THEN ? ELSE subcategory END,
             merchant = CASE WHEN ? THEN ? ELSE merchant END,
             classification_confidence = CASE WHEN ? THEN 0.99 ELSE classification_confidence END,
             classification_source = CASE WHEN ? THEN 'user' ELSE classification_source END,
             updated_at = datetime('now')
           WHERE user_id = ? AND merchant = ? AND id != ? AND user_edited = 0`,
        ).run(
          categoryChanged ? 1 : 0, newCategory,
          categoryChanged ? 1 : 0, newSub || "Unclassified",
          merchantChanged ? 1 : 0, newMerchant,
          categoryChanged ? 1 : 0,
          categoryChanged ? 1 : 0,
          userId, cur.merchant, id,
        );
        affected += sib.changes;
      }
    }
  });
  // A manual fix is a decision: it clears the review flag, and a re-categorised credit may become/stop being a refund.
  db.prepare("UPDATE transactions SET needs_review = 0 WHERE id = ? AND user_id = ? AND user_edited = 1").run(id, userId);
  bumpDataVersion(userId);
  if (patch.category !== undefined) linkRefunds(userId);
  return { updated: affected, transaction: getTransaction(userId, id) };
}

export { merchantKeyOf };
