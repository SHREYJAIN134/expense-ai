/**
 * Synthetic DEMO data. Runs through the real import pipeline (same parser output
 * shape -> normalise -> classify -> transactional insert) so the demo exercises
 * exactly what real statements do. Everything is flagged is_demo and removable.
 */
import crypto from "node:crypto";
import { getDb, withTransaction } from "../db/client";
import { demoRange, generateSyntheticTransactions } from "../demo/synthetic";
import { normalizeTransactions } from "../parsers/hdfc/normalizer";
import type { ParsedStatement, ParsedTransaction } from "../domain/types";
import { addMonths, endOfMonth, todayISO, type ISODate } from "../util/dates";
import { confirmImport, stageParsed } from "../pipeline/import";
import { bumpDataVersion } from "./data";
import { refreshRecurringFlags, regenerateInsights } from "./planning";

export function hasDemoData(userId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM statements WHERE user_id = ? AND is_demo = 1 LIMIT 1").get(userId);
}

export async function loadDemoData(userId: string, today: ISODate = todayISO()): Promise<{ statements: number; transactions: number }> {
  if (hasDemoData(userId)) return { statements: 0, transactions: 0 };
  const { start, end } = demoRange(today);
  const opening = 60000;
  const all = generateSyntheticTransactions({ start, end, seed: 20260921, openingBalance: opening });

  let month = start;
  let statements = 0;
  let transactions = 0;
  let prevClose = opening;
  while (month <= end) {
    const monthEnd = endOfMonth(month) < end ? endOfMonth(month) : end;
    const rows = all.filter((t) => t.date >= month && t.date <= monthEnd);
    if (rows.length) {
      const parsedRows: ParsedTransaction[] = rows.map((t, i) => ({
        date: t.date,
        valueDate: t.date,
        rawDescription: t.narration,
        reference: t.reference,
        debit: t.debit,
        credit: t.credit,
        balance: t.balance,
        rowIndex: i,
        warnings: [],
      }));
      const statement: ParsedStatement = {
        bank: "HDFC",
        parserVersion: "demo",
        account: { mask: "DEMO", type: "DEMO SAVINGS ACCOUNT" },
        period: { start: month, end: monthEnd },
        openingBalance: prevClose,
        closingBalance: rows[rows.length - 1].balance,
        transactions: parsedRows,
        warnings: ["DEMO DATA - synthetic transactions, not real."],
      };
      prevClose = rows[rows.length - 1].balance;
      const normalized = normalizeTransactions(parsedRows);
      const name = `DEMO-synthetic-${month.slice(0, 7)}.pdf`;
      const sha = crypto.createHash("sha256").update(`demo:${userId}:${month}`).digest("hex");
      const preview = await stageParsed(userId, { name, size: 0, sha }, { statement, normalized });
      const res = confirmImport(userId, preview.statementId);
      const db = getDb();
      db.prepare("UPDATE statements SET is_demo = 1 WHERE id = ?").run(preview.statementId);
      db.prepare("UPDATE transactions SET is_demo = 1 WHERE statement_id = ?").run(preview.statementId);
      db.prepare("UPDATE accounts SET is_demo = 1 WHERE id = ?").run(res.accountId);
      statements++;
      transactions += res.imported;
    }
    month = addMonths(month, 1, 1);
  }
  bumpDataVersion(userId);
  refreshRecurringFlags(userId);
  regenerateInsights(userId);
  return { statements, transactions };
}

export function removeDemoData(userId: string): { removed: number } {
  const db = getDb();
  const removed = withTransaction(() => {
    const r = db.prepare("DELETE FROM transactions WHERE user_id = ? AND is_demo = 1").run(userId);
    db.prepare("DELETE FROM statements WHERE user_id = ? AND is_demo = 1").run(userId);
    db.prepare("DELETE FROM accounts WHERE user_id = ? AND is_demo = 1").run(userId);
    return r.changes;
  });
  bumpDataVersion(userId);
  refreshRecurringFlags(userId);
  regenerateInsights(userId);
  return { removed };
}
