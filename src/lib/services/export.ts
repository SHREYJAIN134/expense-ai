import { getDb } from "../db/client";
import { categoryLabel } from "../domain/categories";
import { calculateCategorySpend, calculateMerchantSpend, calculatePeriods, calculateSummary } from "../analytics/engine";
import { formatINR } from "../util/money";
import { formatDateLong, todayISO } from "../util/dates";
import { getSettings } from "./users";
import { loadTxns, type TxnFilter } from "./data";
import type { TxnRow } from "./transactions";

/** CSV cell escaping incl. spreadsheet formula-injection protection (=,+,-,@ prefixes). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

export function transactionsCsv(rows: TxnRow[]): string {
  return toCsv(
    ["Date", "Value Date", "Description", "Merchant", "Category", "Subcategory", "Type", "Payment Method", "Reference", "Debit", "Credit", "Balance", "Confidence", "Classified By", "Recurring", "Notes"],
    rows.map((r) => [r.date, r.valueDate, r.rawDescription, r.merchant, r.category, r.subcategory, r.type, r.paymentMethod, r.reference, r.debit || "", r.credit || "", r.balanceAfter, r.confidence, r.source, r.isRecurring ? "yes" : "", r.notes]),
  );
}

export function summaryRows(userId: string, f: TxnFilter) {
  const settings = getSettings(userId);
  const txns = loadTxns(userId, f);
  const s = calculateSummary(txns);
  return {
    summary: s,
    monthly: calculatePeriods(txns, "monthly", settings.monthStartDay),
    quarterly: calculatePeriods(txns, "quarterly", settings.monthStartDay),
    yearly: calculatePeriods(txns, "yearly"),
    categories: calculateCategorySpend(txns),
    merchants: calculateMerchantSpend(txns, { limit: 25 }),
  };
}

export function summaryCsv(userId: string, f: TxnFilter): string {
  const d = summaryRows(userId, f);
  const blocks: string[] = [];
  blocks.push(toCsv(["Metric", "Value"], [
    ["From", d.summary.from], ["To", d.summary.to], ["Total credits", d.summary.totalCredits], ["Total debits", d.summary.totalDebits],
    ["Net cash flow", d.summary.netCashFlow], ["Income", d.summary.income], ["Spending", d.summary.spending], ["Refunds", d.summary.refunds],
    ["Transfers in", d.summary.transfersIn], ["Transfers out", d.summary.transfersOut], ["Investments", d.summary.investmentsOut],
    ["Savings", d.summary.savings], ["Savings rate %", d.summary.savingsRate], ["Transactions", d.summary.transactionCount],
  ]));
  const periodRows = (name: string, rows: typeof d.monthly) => rows.map((p) => [name, p.key, p.income, p.spending, p.refunds, p.credits, p.debits, p.netCashFlow, p.savingsRate]);
  blocks.push(toCsv(["Granularity", "Period", "Income", "Spending", "Refunds", "Credits", "Debits", "Net cash flow", "Savings rate %"], [...periodRows("monthly", d.monthly), ...periodRows("quarterly", d.quarterly), ...periodRows("yearly", d.yearly)]));
  blocks.push(toCsv(["Category", "Amount", "Transactions", "Share %"], d.categories.map((c) => [categoryLabel(c.category), c.amount, c.count, c.pct])));
  blocks.push(toCsv(["Merchant", "Category", "Amount", "Transactions", "Average", "Last date"], d.merchants.map((m) => [m.merchant, categoryLabel(m.category), m.amount, m.count, m.average, m.lastDate])));
  return blocks.join("\r\n");
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Self-contained, printable financial report (open and "Print to PDF"). All values HTML-escaped. */
export function reportHtml(userId: string, f: TxnFilter, name: string): string {
  const d = summaryRows(userId, f);
  const s = d.summary;
  const table = (head: string[], rows: (string | number)[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "n" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Expense AI - Financial report</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:860px;margin:32px auto;padding:0 20px}h1{margin:0}h2{margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.k{border:1px solid #ddd;border-radius:8px;padding:10px}.k b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:5px 8px;border-bottom:1px solid #eee;text-align:left}td.n,th:not(:first-child){text-align:right}
.note{color:#555;font-size:12px}@media print{body{margin:0}}</style></head><body>
<h1>Expense AI - Financial report</h1>
<p class="note">Prepared for ${esc(name)} on ${esc(formatDateLong(todayISO()))}. Period: ${esc(s.from ?? "n/a")} to ${esc(s.to ?? "n/a")}. Generated from your imported statements; figures exclude nothing but categorisation is automatic and may contain errors.</p>
<div class="grid">
<div class="k">Income<b>${esc(formatINR(s.income))}</b></div><div class="k">Spending<b>${esc(formatINR(s.spending))}</b></div><div class="k">Net cash flow<b>${esc(formatINR(s.netCashFlow))}</b></div>
<div class="k">Total credits<b>${esc(formatINR(s.totalCredits))}</b></div><div class="k">Total debits<b>${esc(formatINR(s.totalDebits))}</b></div><div class="k">Savings rate<b>${s.savingsRate === null ? "n/a" : esc(s.savingsRate + "%")}</b></div></div>
<h2>Monthly</h2>${table(["Month", "Income", "Spending", "Net cash flow"], d.monthly.map((p) => [p.label, formatINR(p.income), formatINR(p.spending), formatINR(p.netCashFlow)]))}
<h2>Quarterly</h2>${table(["Quarter", "Income", "Spending", "Net cash flow"], d.quarterly.map((p) => [p.label, formatINR(p.income), formatINR(p.spending), formatINR(p.netCashFlow)]))}
<h2>Yearly</h2>${table(["Year", "Income", "Spending", "Net cash flow"], d.yearly.map((p) => [p.label, formatINR(p.income), formatINR(p.spending), formatINR(p.netCashFlow)]))}
<h2>Spending by category</h2>${table(["Category", "Amount", "Share", "Transactions"], d.categories.map((c) => [categoryLabel(c.category), formatINR(c.amount), c.pct + "%", c.count]))}
<h2>Top merchants</h2>${table(["Merchant", "Amount", "Transactions"], d.merchants.slice(0, 15).map((m) => [m.merchant, formatINR(m.amount), m.count]))}
</body></html>`;
}

/** Complete data export (portable backup). Never includes password hashes, session tokens or PDFs. */
export function fullExport(userId: string) {
  const db = getDb();
  const all = (sql: string) => db.prepare(sql).all(userId);
  const user = db.prepare("SELECT email, name, created_at FROM users WHERE id = ?").get(userId);
  return {
    exportedAt: new Date().toISOString(),
    user,
    settings: getSettings(userId),
    accounts: all("SELECT id, bank, account_mask, account_type, nickname, latest_balance, balance_as_of FROM accounts WHERE user_id = ?"),
    statements: all("SELECT id, filename, bank, period_start, period_end, status, txn_count, total_debits, total_credits, created_at FROM statements WHERE user_id = ? AND status = 'imported'"),
    transactions: all("SELECT * FROM transactions WHERE user_id = ? ORDER BY txn_date, seq"),
    categories: all("SELECT category, subcategory, color, is_system FROM transaction_categories WHERE user_id = ?"),
    merchantOverrides: all("SELECT merchant_key, merchant_name, category, subcategory FROM merchant_overrides WHERE user_id = ?"),
    budgets: all("SELECT category, amount, alert_threshold, is_active FROM budgets WHERE user_id = ?"),
    recurring: all("SELECT name, category, amount, frequency, due_day, start_date, kind, source, status, notes FROM recurring_expenses WHERE user_id = ?"),
    goals: all("SELECT name, target_amount, current_amount, target_date, status FROM financial_goals WHERE user_id = ?"),
    insights: all("SELECT kind, severity, title, body, generated_at FROM financial_insights WHERE user_id = ?"),
    chat: all("SELECT s.title, m.role, m.content, m.created_at FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE m.user_id = ? ORDER BY m.created_at"),
  };
}
