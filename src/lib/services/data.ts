/**
 * Cached loaders that turn SQLite rows into TxnLite[] for the analytics engine.
 * The cache is keyed per user and invalidated by `bumpDataVersion` on every write,
 * so repeated dashboard requests do not re-scan the table.
 */
import { getDb } from "../db/client";
import type { TxnLite } from "../domain/types";
import type { ISODate } from "../util/dates";

const versions = new Map<string, number>();
const cache = new Map<string, { version: number; txns: TxnLite[] }>();

/** Which date drives analytics. Default is the transaction date; "value" uses the bank's value date. */
export type DateBasis = "transaction" | "value";
const memo = new Map<string, { version: number; value: unknown }>();

export function bumpDataVersion(userId: string) {
  versions.set(userId, (versions.get(userId) ?? 0) + 1);
  cache.delete(userId);
  cache.delete(`${userId}:value`);
  for (const k of memo.keys()) if (k.startsWith(userId + ":")) memo.delete(k);
}

export const dataVersion = (userId: string) => versions.get(userId) ?? 0;

/** Memoise an expensive per-user computation until the next write. */
export function memoize<T>(userId: string, key: string, compute: () => T): T {
  const k = `${userId}:${key}`;
  const v = dataVersion(userId);
  const hit = memo.get(k);
  if (hit && hit.version === v) return hit.value as T;
  const value = compute();
  memo.set(k, { version: v, value });
  if (memo.size > 500) memo.delete(memo.keys().next().value as string);
  return value;
}

interface Row {
  id: string;
  txn_date: string;
  debit: number;
  credit: number;
  amount: number;
  direction: "debit" | "credit";
  category: string;
  subcategory: string;
  merchant: string | null;
  description: string;
  balance_after: number | null;
  is_recurring: number;
  classification_confidence: number;
  value_date: string | null;
  refund_reference: string | null;
  is_refund: number;
  payment_method: string | null;
}

export function loadAllTxns(userId: string, basis: DateBasis = "transaction"): TxnLite[] {
  const v = dataVersion(userId);
  const ckey = basis === "value" ? `${userId}:value` : userId;
  const hit = cache.get(ckey);
  if (hit && hit.version === v) return hit.txns;
  const rows = getDb()
    .prepare(
      `SELECT id, txn_date, debit, credit, amount, direction, category, subcategory, merchant, description,
              balance_after, is_recurring, classification_confidence, value_date, refund_reference, is_refund, payment_method
       FROM transactions WHERE user_id = ? AND is_primary = 1 ORDER BY txn_date, seq, id`,
    )
    .all(userId) as Row[];
  const txns: TxnLite[] = rows.map((r) => ({
    id: r.id,
    date: basis === "value" ? r.value_date ?? r.txn_date : r.txn_date,
    debit: r.debit,
    credit: r.credit,
    amount: r.amount,
    direction: r.direction,
    category: r.category,
    subcategory: r.subcategory,
    merchant: r.merchant || "Unknown",
    description: r.description,
    balanceAfter: r.balance_after,
    isRecurring: !!r.is_recurring,
    confidence: r.classification_confidence,
    refundFor: r.refund_reference,
    isRefund: !!r.is_refund,
    paymentMethod: r.payment_method,
  }));
  if (basis === "value") txns.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  cache.set(ckey, { version: v, txns });
  return txns;
}

export interface TxnFilter {
  /** "value" = analyse by value date instead of transaction date. */
  basis?: DateBasis;
  from?: ISODate | null;
  to?: ISODate | null;
  category?: string | null;
  merchant?: string | null;
}

export function loadTxns(userId: string, f: TxnFilter = {}): TxnLite[] {
  let rows = loadAllTxns(userId, f.basis ?? "transaction");
  if (f.from) rows = rows.filter((t) => t.date >= f.from!);
  if (f.to) rows = rows.filter((t) => t.date <= f.to!);
  if (f.category) rows = rows.filter((t) => t.category === f.category);
  if (f.merchant) rows = rows.filter((t) => t.merchant.toLowerCase() === f.merchant!.toLowerCase());
  return rows;
}

/**
 * Latest known balance = balance printed on the most recent transaction that has one.
 * Returns null when statements carry no balance information.
 */
export function currentBalance(userId: string): { balance: number; asOf: ISODate } | null {
  const row = getDb()
    .prepare(
      `SELECT balance_after, txn_date FROM transactions
       WHERE user_id = ? AND balance_after IS NOT NULL AND is_primary = 1
       ORDER BY txn_date DESC, seq DESC, id DESC LIMIT 1`,
    )
    .get(userId) as { balance_after: number; txn_date: string } | undefined;
  return row ? { balance: row.balance_after, asOf: row.txn_date } : null;
}

export function dataRange(userId: string): { from: ISODate; to: ISODate; count: number } | null {
  const r = getDb()
    .prepare("SELECT MIN(txn_date) AS f, MAX(txn_date) AS t, COUNT(*) AS n FROM transactions WHERE user_id = ? AND is_primary = 1")
    .get(userId) as { f: string | null; t: string | null; n: number };
  return r.n ? { from: r.f!, to: r.t!, count: r.n } : null;
}
