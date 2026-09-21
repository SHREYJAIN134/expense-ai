/**
 * Analytical / ranking questions ("which day had the most transactions", "which day did I spend the most",
 * "largest transaction", "top merchants"...). Every number is checked against INDEPENDENT SQL over the canonical rows,
 * with HDFC + Google Pay both imported so any double counting would show up as doubled figures.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db/client";
import { createUser } from "../src/lib/services/users";
import { confirmImport, stageParsed } from "../src/lib/pipeline/import";
import { parseGooglePayPages } from "../src/lib/parsers/googlepay/parser";
import { normalizeGooglePay } from "../src/lib/parsers/googlepay/normalizer";
import { normalizeTransactions } from "../src/lib/parsers/hdfc/normalizer";
import { answerQuery, type Answer } from "../src/lib/chat/answer";
import { detectRanking, parseQuestion } from "../src/lib/chat/intent";
import { chatTurn } from "../src/lib/chat/service";
import { narrate } from "../src/lib/chat/llm";
import { dataRange, loadAllTxns } from "../src/lib/services/data";
import { dayStats, largestTransactions, rankBy, rankDays, spendingByPeriod, topMerchantsBySpend } from "../src/lib/analytics/rankings";
import { pagesFromLayout } from "../scripts/gpay-pdf";
import type { AiProvider } from "../src/lib/ai/provider";
import type { ParsedStatement, ParsedTransaction } from "../src/lib/domain/types";
import { tx } from "./fixtures";
import { GPAY_ROWS, type GPayRow } from "./gpay-fixture";

const TODAY = "2026-09-21";
const db = () => getDb();

/* ------------------------------ builders ------------------------------ */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "user";
function hdfcParsed(rows: GPayRow[]): { statement: ParsedStatement; normalized: ReturnType<typeof normalizeTransactions> } {
  let balance = 100000;
  const txns: ParsedTransaction[] = rows.map((r, i) => {
    const narration = `UPI-${r.counterparty.toUpperCase()}-${slug(r.counterparty)}@okhdfcbank-HDFC0000001-${r.id}-UPI`;
    balance = Math.round((balance + (r.direction === "credit" ? r.amount : -r.amount)) * 100) / 100;
    return { date: r.date, rawDescription: narration, narrationLines: [narration], reference: "0000" + r.id, debit: r.direction === "debit" ? r.amount : 0, credit: r.direction === "credit" ? r.amount : 0, balance, rowIndex: i, warnings: [] };
  });
  const dates = rows.map((r) => r.date).sort();
  const statement: ParsedStatement = { bank: "HDFC", parserVersion: "test", account: { mask: "9332" }, period: { start: dates[0], end: dates[dates.length - 1] }, transactions: txns, warnings: [] };
  return { statement, normalized: normalizeTransactions(txns) };
}
const file = (n: string) => ({ name: n, size: 1, sha: crypto.createHash("sha256").update(n + Math.random()).digest("hex") });
async function newUser() {
  return (await createUser({ email: `rk${Math.random()}@example.com`, name: "Test Owner", password: "ranking questions password 1" })).id;
}
/** HDFC-only user (the baseline for "no double counting") and a user with BOTH sources for the same rows. */
async function importHdfc(u: string, rows: GPayRow[]) {
  const h = await stageParsed(u, file("bank.pdf"), hdfcParsed(rows));
  confirmImport(u, h.statementId, { acknowledgeReconciliation: true });
}
async function importGpay(u: string, rows: GPayRow[]) {
  const sent = Math.round(rows.filter((r) => r.direction === "debit").reduce((a, r) => a + r.amount, 0) * 100) / 100;
  const received = Math.round(rows.filter((r) => r.direction === "credit").reduce((a, r) => a + r.amount, 0) * 100) / 100;
  const st = parseGooglePayPages(pagesFromLayout({ rows, sent, received }));
  const g = await stageParsed(u, file("gpay.pdf"), { statement: st, normalized: normalizeGooglePay(st) });
  confirmImport(u, g.statementId, { acknowledgeReconciliation: true });
}
let cachedBoth: string | null = null;
async function both(): Promise<string> {
  if (cachedBoth) return cachedBoth;
  const u = await newUser();
  await importHdfc(u, GPAY_ROWS);
  await importGpay(u, GPAY_ROWS);
  return (cachedBoth = u);
}
const ask = (u: string, q: string, last?: Parameters<typeof parseQuestion>[1]["last"]): Answer => {
  const merchants = [...new Set(loadAllTxns(u).map((t) => t.merchant))];
  return answerQuery(u, parseQuestion(q, { today: TODAY, monthStartDay: 1, merchants, dataRange: dataRange(u), last }), TODAY);
};
interface DayFacts { winners: { date: string; transactions: number; totalSpent: number; totalReceived: number; moneyOut: number; value: number; largestPayment: { amount: number; merchant: string } | null }[]; best: number; tied: boolean; top: { date: string }[] }
const facts = (a: Answer) => a.facts as unknown as DayFacts;
const PRIMARY = "user_id = ? AND is_primary = 1";

/** Independent per-day SQL over canonical rows. */
function perDay(u: string, expr: string, where = "", from = "0000-01-01", to = "9999-12-31") {
  return db()
    .prepare(`SELECT txn_date d, ROUND(${expr},2) v FROM transactions WHERE ${PRIMARY} AND txn_date BETWEEN ? AND ? ${where} GROUP BY txn_date ORDER BY v DESC, d`)
    .all(u, from, to) as { d: string; v: number }[];
}
const winnersOf = (rows: { d: string; v: number }[]) => rows.filter((r) => Math.abs(r.v - rows[0].v) < 0.005).map((r) => r.d);

/* --------------------------------- intents --------------------------------- */

describe("intent routing for ranking questions", () => {
  const intent = (q: string) => parseQuestion(q, { today: TODAY, monthStartDay: 1, merchants: [], dataRange: { from: "2026-08-01", to: "2026-08-31" } }).intent;
  const cases: [string, string][] = [
    ["List all transactions on 24th August.", "transaction_list"],
    ["Which day had the highest number of transactions?", "busiest_day"],
    ["Which day had the highest transaction amount?", "top_value_day"],
    ["Which day did I spend the most?", "top_spending_day"],
    ["Which day received the most money?", "top_income_day"],
    ["What was my largest transaction?", "largest_transaction"],
    ["Show all transactions for that day.", "transaction_list"],
    ["busiest day last month", "busiest_day"],
    ["highest spending day in August", "top_spending_day"],
    ["which day had the most transactions", "busiest_day"],
    ["what day had the most payments", "busiest_day"],
    ["day with the most activity", "busiest_day"],
    ["highest income day", "top_income_day"],
    ["which day did I earn the most", "top_income_day"],
    ["which date had the maximum spending", "top_spending_day"],
    ["largest transaction this month", "largest_transaction"],
    ["what was my biggest single transaction", "largest_transaction"],
    ["what was my largest credit", "largest_transaction"],
    ["top merchants", "top_merchants"],
    ["which merchant did I spend the most at", "top_merchants"],
    ["what are my most frequent merchants", "top_merchants"],
    ["top categories in august", "top_categories"],
    ["which category did I spend the most on", "top_categories"],
    ["which week did I spend the most", "top_spending_period"],
    ["highest spending month", "top_spending_period"],
    ["top spending week", "top_spending_period"],
    ["What was my biggest expense this month?", "biggest_expense"],
    ["Where is most of my money going?", "top_categories"],
  ];
  it.each(cases)("%s -> %s", (q, expected) => expect(intent(q)).toBe(expected));

  it("'highest transaction amount' by day is a daily TOTAL; without 'day' it is genuinely ambiguous and asks", () => {
    expect(detectRanking("which day had the highest transaction amount")).toMatchObject({ intent: "top_value_day" });
    const amb = detectRanking("what was the highest transaction amount")!;
    expect(amb.clarification?.message).toMatch(/largest SINGLE transaction, or the day with the highest TOTAL/);
    expect(amb.clarification?.suggestions).toHaveLength(2);
    expect(detectRanking("what was my highest single transaction amount")?.clarification).toBeUndefined();
  });
  it("ranking words never turn into a plain list, and plain lists are unaffected", () => {
    expect(intent("show all transactions on 24 august")).toBe("transaction_list");
    expect(intent("what day had the most transactions")).not.toBe("transaction_list");
    expect(intent("how much did I spend on 24 august")).toBe("spend_total");
    expect(intent("what is my balance")).toBe("balance");
  });
});

/* ------------------------------ pure aggregation ------------------------------ */

describe("ranking aggregation (pure, canonical events)", () => {
  const D = (date: string, amount: number, cat = "FOOD", merchant = "Cafe", over: Record<string, unknown> = {}) => ({ ...tx(date, amount, "debit", cat, merchant), ...over });
  const C = (date: string, amount: number, cat = "TRANSFERS", merchant = "Friend", over: Record<string, unknown> = {}) => ({ ...tx(date, amount, "credit", cat, merchant), ...over });

  it("ties are reported as ties (every day sharing the top value wins)", () => {
    const rows = [D("2026-08-01", 100), D("2026-08-01", 50), D("2026-08-02", 120), D("2026-08-02", 30), D("2026-08-03", 90)];
    const stats = dayStats(rows);
    const byCount = rankDays(stats, "count");
    expect(byCount.winners.map((d) => d.date)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(byCount.best).toBe(2);
    const bySpend = rankDays(stats, "spending");
    expect(bySpend.winners.map((d) => [d.date, d.spending])).toEqual([["2026-08-01", 150], ["2026-08-02", 150]]);
  });
  it("counts events (any direction), spending rules exclude transfers and net refunds, received excludes own-account transfers", () => {
    const purchase = D("2026-08-05", 500, "SHOPPING", "Amazon");
    const refund = C("2026-08-06", 500, "REFUNDS", "Amazon", { refundFor: purchase.id });
    const rows = [
      purchase, refund,
      D("2026-08-05", 2000, "TRANSFERS", "Rahul Negi"), // person transfer: money out, not spending
      C("2026-08-05", 300, "TRANSFERS", "Friend"),
      C("2026-08-05", 900, "TRANSFERS", "Self", { subcategory: "Self Transfer" }), // own accounts: not received money
      C("2026-08-05", 1000, "SALARY/INCOME", "Acme"),
    ];
    const d5 = dayStats(rows).find((d) => d.date === "2026-08-05")!;
    expect(d5).toMatchObject({ count: 5, debitCount: 2, creditCount: 3, moneyOut: 2500, moneyIn: 1300, income: 1000, transfersIn: 300, value: 3800 });
    expect(d5.spending).toBe(0); // the purchase was refunded in full; the ₹2,000 is a transfer
    expect(dayStats(rows).find((d) => d.date === "2026-08-06")!.moneyIn).toBe(500);
    expect(rankDays(dayStats(rows), "income").winners.map((d) => d.date)).toEqual(["2026-08-05"]);
    expect(rankDays(dayStats(rows), "spending").winners).toEqual([]); // nothing was actually spent
  });
  it("largest single transaction: any direction, ties kept, own-account transfers ignored", () => {
    const rows = [D("2026-08-01", 300), C("2026-08-02", 900), D("2026-08-03", 900), C("2026-08-04", 5000, "TRANSFERS", "Self", { subcategory: "Self Transfer" })];
    const r = largestTransactions(rows);
    expect(r.best).toBe(900);
    expect(r.winners.map((t) => t.date).sort()).toEqual(["2026-08-02", "2026-08-03"]);
    expect(largestTransactions(rows, "debit").winners.map((t) => t.amount)).toEqual([900]);
    expect(largestTransactions(rows, "credit").winners.map((t) => t.date)).toEqual(["2026-08-02"]);
  });
  it("top merchants: refund-netted, shares add up, people are not merchants", () => {
    const p = D("2026-08-01", 400, "GROCERIES", "Blinkit");
    const rows = [p, C("2026-08-02", 400, "REFUNDS", "Blinkit", { refundFor: p.id }), D("2026-08-03", 300, "GROCERIES", "Zepto"), D("2026-08-04", 100, "GROCERIES", "Zepto"), D("2026-08-05", 100, "FOOD", "Swiggy"), D("2026-08-06", 999, "TRANSFERS", "Rahul Negi")];
    const m = topMerchantsBySpend(rows, rows).sort((a, b) => b.amount - a.amount);
    expect(m.map((x) => [x.merchant, x.amount, x.count])).toEqual([["Zepto", 400, 2], ["Swiggy", 100, 1]]); // Blinkit fully refunded; Rahul is a transfer
    expect(m.reduce((a, x) => a + x.share, 0)).toBeCloseTo(100, 0);
  });
  it("weeks and months by net spending", () => {
    const rows = [D("2026-08-03", 100), D("2026-08-05", 200), D("2026-08-12", 250), D("2026-09-01", 900)];
    const weeks = rankBy(spendingByPeriod(rows, "2026-08-01", "2026-08-31", "weekly"), (b) => b.spending, (b) => b.key);
    expect(weeks.winners.map((w) => w.spending)).toEqual([300]);
    const months = spendingByPeriod(rows, "2026-08-01", "2026-09-30", "monthly");
    expect(rankBy(months, (b) => b.spending, (b) => b.key).winners.map((m) => [m.label, m.spending])).toEqual([["Sep 2026", 900]]);
    expect(spendingByPeriod(rows, "2026-08-01", "2026-08-31", "monthly")).toHaveLength(1); // the range is respected
  });
});

/* -------------------------- the real data, both sources -------------------------- */

describe("answers from the canonical database (HDFC + Google Pay imported)", () => {
  it("baseline: the database really holds every payment twice (166 rows) but 83 events", async () => {
    const u = await both();
    expect((db().prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ?").get(u) as { n: number }).n).toBe(166);
    expect((db().prepare(`SELECT COUNT(*) n FROM transactions WHERE ${PRIMARY}`).get(u) as { n: number }).n).toBe(83);
  }, 60_000);

  it("'Which day had the highest number of transactions?' = COUNT of canonical events per day, ties included", async () => {
    const u = await both();
    const sql = perDay(u, "COUNT(*)");
    const a = ask(u, "Which day had the highest number of transactions?");
    expect(a.intent).toBe("busiest_day");
    expect(facts(a).best).toBe(sql[0].v);
    expect(facts(a).winners.map((w) => w.date)).toEqual(winnersOf(sql));
    expect(sql[0].v).toBe(6); // NOT 12: the HDFC and Google Pay rows of one payment are one event
    expect(winnersOf(sql).length).toBeGreaterThan(1);
    expect(facts(a).tied).toBe(true);
    expect(a.text).toMatch(/days tied\*\* for the highest transaction activity \(6 transactions each\)/);
    for (const w of facts(a).winners) expect(w.transactions).toBe(6);
    const day24 = facts(a).winners.find((w) => w.date === "2026-08-24")!;
    expect(day24).toMatchObject({ transactions: 6, totalSpent: 575, totalReceived: 314 });
    expect(a.table?.rows).toHaveLength(5);
    expect(a.focusDates).toEqual(winnersOf(sql));
  }, 60_000);

  it("'Which day did I spend the most?' = SUM of spending debits per day (transfers excluded), with the largest payment", async () => {
    const u = await both();
    const sql = perDay(u, "SUM(debit)", "AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS')");
    const a = ask(u, "Which day did I spend the most?");
    expect(a.intent).toBe("top_spending_day");
    expect(facts(a).winners.map((w) => w.date)).toEqual(winnersOf(sql));
    expect(facts(a).best).toBe(sql[0].v);
    expect(sql[0].v).toBeLessThan(2000); // not doubled (the same payments exist in both statements)
    const top = facts(a).winners[0];
    const big = db().prepare(`SELECT MAX(debit) m FROM transactions WHERE ${PRIMARY} AND txn_date = ? AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS')`).get(u, top.date) as { m: number };
    expect(top.largestPayment?.amount).toBe(big.m);
    expect(a.text).toMatch(new RegExp(`had the highest spending: \\*\\*₹${sql[0].v.toLocaleString("en-IN")}\\*\\*`));
    expect(a.text).toContain("Largest payment:");
    expect(a.text).toContain("Transactions:");
  }, 60_000);

  it("'Which day received the most money?' = SUM of credits per day, with a breakdown that adds up", async () => {
    const u = await both();
    const sql = perDay(u, "SUM(credit)", "AND direction = 'credit' AND subcategory != 'Self Transfer'");
    const a = ask(u, "Which day received the most money?");
    expect(a.intent).toBe("top_income_day");
    expect(facts(a).winners.map((w) => w.date)).toEqual(winnersOf(sql));
    expect(facts(a).best).toBe(sql[0].v);
    expect(facts(a).winners[0].totalReceived).toBe(sql[0].v);
    expect(sql[0].v).toBe(4920); // 1 Aug: 3,700 + 1,220 (+ nothing doubled)
    expect(a.text).toContain("**₹4,920**");
    expect(a.text).toMatch(/from people \/ transfers ₹3,700 · other credits ₹1,220/);
    // strict "income" (salary) is different: none exists, and the answer says so instead of guessing
    const inc = ask(u, "Which day was my highest income day?");
    expect(inc.noData).toBe(true);
    expect(inc.text).toMatch(/No income \(salary and similar\) was recorded/);
    expect(inc.suggestions).toEqual(["Which day received the most money?"]);
  }, 60_000);

  it("'Which day had the highest transaction amount?' = highest TOTAL value moved in a day (not the largest single one)", async () => {
    const u = await both();
    const sql = perDay(u, "SUM(amount)", "AND subcategory != 'Self Transfer'");
    const a = ask(u, "Which day had the highest transaction amount?");
    expect(a.intent).toBe("top_value_day");
    expect(facts(a).best).toBe(sql[0].v);
    expect(facts(a).winners.map((w) => w.date)).toEqual(winnersOf(sql));
    expect(a.text).toMatch(/had the highest total transaction value: \*\*₹5,625\*\*/);
    expect(facts(a).winners[0].value).toBe(facts(a).winners[0].moneyOut + facts(a).winners[0].totalReceived);
    // and it is a different question from the single largest transaction
    const single = ask(u, "What was my largest single transaction?");
    expect(single.intent).toBe("largest_transaction");
    expect((single.facts as { amount: number }).amount).toBe(3700);
    expect(facts(a).best).not.toBe(3700);
  }, 60_000);

  it("'What was my largest transaction?' = MAX(amount) with direction, category, date/time, method and source", async () => {
    const u = await both();
    const mx = db().prepare(`SELECT MAX(amount) m FROM transactions WHERE ${PRIMARY}`).get(u) as { m: number };
    const a = ask(u, "What was my largest transaction?");
    expect(a.intent).toBe("largest_transaction");
    const f = a.facts as { amount: number; tied: boolean; transactions: { amount: number; type: string; merchant: string; category: string; date: string; time: string | null; paymentMethod: string | null; source: string }[] };
    expect(f.amount).toBe(mx.m);
    expect(f.tied).toBe(false);
    expect(f.transactions[0]).toMatchObject({ amount: 3700, type: "Credit", merchant: "Nekkalapu Ramu", category: "Transfers", date: "2026-08-01", time: "16:37", paymentMethod: "UPI", source: "HDFC + Google Pay" });
    expect(a.text).toContain("**₹3,700**");
    expect(a.text).toContain("HDFC + Google Pay");
    expect(a.focusDates).toEqual(["2026-08-01"]);
    // direction-specific
    const debit = db().prepare(`SELECT MAX(debit) m FROM transactions WHERE ${PRIMARY} AND direction = 'debit'`).get(u) as { m: number };
    expect((ask(u, "what was my largest credit?").facts as { amount: number }).amount).toBe(3700);
    expect(debit.m).toBeLessThan(3700);
  }, 60_000);

  it("top merchants and top categories: deterministic GROUP BY over canonical events", async () => {
    const u = await both();
    const sql = db().prepare(`SELECT merchant m, ROUND(SUM(debit),2) s, COUNT(*) n FROM transactions WHERE ${PRIMARY} AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS') GROUP BY merchant ORDER BY s DESC, n DESC, m`).all(u) as { m: string; s: number; n: number }[];
    const a = ask(u, "Who are my top merchants?");
    expect(a.intent).toBe("top_merchants");
    const top = (a.facts as { top: { merchant: string; amount: number; transactions: number }[] }).top;
    expect(top.map((t) => [t.merchant, t.amount, t.transactions])).toEqual(sql.slice(0, 5).map((r) => [r.m, r.s, r.n]));
    expect(top[0]).toMatchObject({ merchant: "Zepto", transactions: 6 }); // 6, not 12
    const byCount = ask(u, "Which merchant did I visit most often?");
    expect((byCount.facts as { rankedBy: string }).rankedBy).toBe("count");
    expect(byCount.text).toMatch(/most frequent merchant/);
    const cats = db().prepare(`SELECT category c, ROUND(SUM(debit),2) s FROM transactions WHERE ${PRIMARY} AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS') GROUP BY category ORDER BY s DESC`).all(u) as { c: string; s: number }[];
    const c = ask(u, "Which category did I spend the most on in August?");
    expect(c.intent).toBe("top_categories");
    expect((c.facts as { categories: { category: string; amount: number }[] }).categories[0]).toMatchObject({ category: cats[0].c, amount: cats[0].s });
  }, 60_000);

  it("top spending week and month", async () => {
    const u = await both();
    const total = db().prepare(`SELECT ROUND(SUM(debit),2) s FROM transactions WHERE ${PRIMARY} AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS')`).get(u) as { s: number };
    const m = ask(u, "Which month did I spend the most?");
    expect(m.intent).toBe("top_spending_period");
    expect((m.facts as { best: number }).best).toBe(total.s);
    expect(m.text).toContain("Aug 2026");
    const w = ask(u, "Which week did I spend the most?");
    const wf = w.facts as { best: number; top: { spending: number }[] };
    expect(wf.best).toBe(Math.max(...wf.top.map((x) => x.spending)));
    expect(wf.top.reduce((a, x) => a + x.spending, 0)).toBeLessThanOrEqual(total.s + 0.01);
    expect(w.text).toMatch(/highest-spending week/);
  }, 60_000);

  it("date-filtered rankings resolve the range first", async () => {
    const u = await both();
    const from = "2026-08-20";
    const to = "2026-08-24";
    const sql = perDay(u, "SUM(debit)", "AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS')", from, to);
    const a = ask(u, "highest spending day from August 20 to August 24");
    expect(facts(a).winners.map((w) => w.date)).toEqual(winnersOf(sql));
    expect(facts(a).best).toBe(sql[0].v);
    expect(a.text).toContain("from 20 Aug 2026 to 24 Aug 2026");
    const cnt = perDay(u, "COUNT(*)", "", from, to);
    const b = ask(u, "busiest day from August 20 to August 24");
    expect(facts(b).winners.map((w) => w.date)).toEqual(winnersOf(cnt));
    expect(winnersOf(cnt)).toEqual(["2026-08-24"]); // a single winner in this window
    expect(b.text).toMatch(/^\*\*24 Aug 2026\*\* had the highest transaction activity/);
    // named month
    expect(ask(u, "busiest day in august").text).toMatch(/in August 2026/);
    // a period with no data
    expect(ask(u, "highest spending day this week").text).toMatch(/no transactions this week|There was no spending/);
    expect(ask(u, "largest transaction this month").text).toMatch(/found no transactions this month/);
    // outside the data
    expect(ask(u, "highest spending day in march 2026").noData).toBe(true);
    // largest within a window and direction
    const inWin = db().prepare(`SELECT MAX(amount) m FROM transactions WHERE ${PRIMARY} AND txn_date BETWEEN ? AND ?`).get(u, from, to) as { m: number };
    expect((ask(u, "largest transaction from august 20 to august 24").facts as { amount: number }).amount).toBe(inWin.m);
  }, 60_000);

  it("no double counting: the two-source rankings equal the HDFC-only rankings", async () => {
    const u = await both();
    const solo = await newUser();
    await importHdfc(solo, GPAY_ROWS);
    for (const q of ["Which day had the highest number of transactions?", "Which day did I spend the most?", "Which day received the most money?", "Which day had the highest transaction amount?"]) {
      const a = ask(u, q);
      const b = ask(solo, q);
      expect(facts(a).best, q).toBe(facts(b).best);
      expect(facts(a).winners.map((w) => w.date), q).toEqual(facts(b).winners.map((w) => w.date));
    }
    expect((ask(u, "What was my largest transaction?").facts as { amount: number }).amount).toBe((ask(solo, "What was my largest transaction?").facts as { amount: number }).amount);
    expect(JSON.stringify((ask(u, "top merchants").facts as { top: unknown }).top)).toBe(JSON.stringify((ask(solo, "top merchants").facts as { top: unknown }).top));
  }, 90_000);

  it("ambiguity is asked about, not guessed", async () => {
    const u = await both();
    const a = ask(u, "What was the highest transaction amount?");
    expect(a.text).toMatch(/largest SINGLE transaction, or the day with the highest TOTAL transaction value/);
    expect(a.suggestions).toEqual(["What was my largest single transaction?", "Which day had the highest total transaction value?"]);
    expect(a.facts).toEqual({ clarification: true });
  }, 60_000);
});

/* ---------------------------- "that day" follow-ups ---------------------------- */

describe("'Show all transactions for that day.'", () => {
  it("lists the day the previous answer was about (single winner)", async () => {
    const u = await both();
    const first = await chatTurn(u, { message: "What was my largest transaction?" }, TODAY);
    expect(first.intent).toBe("largest_transaction");
    const r = await chatTurn(u, { message: "Show all transactions for that day.", sessionId: first.sessionId }, TODAY);
    expect(r.intent).toBe("transaction_list");
    expect(r.message.content).toContain("Found **4 transactions** on 1 Aug 2026.");
    expect(r.message.content).toContain("Nekkalapu Ramu — ₹3,700");
    expect(r.message.content).not.toMatch(/balance/i);
  }, 60_000);
  it("when the previous answer was a tie it asks which day instead of guessing", async () => {
    const u = await both();
    const first = await chatTurn(u, { message: "Which day had the highest number of transactions?" }, TODAY);
    const r = await chatTurn(u, { message: "Show all transactions for that day.", sessionId: first.sessionId }, TODAY);
    expect(r.message.content).toMatch(/5 days that tied .* Which day do you mean\?/);
    expect(r.message.content).not.toMatch(/Found \*\*/);
    // and naming the day resolves it
    const r2 = await chatTurn(u, { message: "show all transactions on 24 August", sessionId: first.sessionId }, TODAY);
    expect(r2.message.content).toContain("Found **6 transactions** on 24 Aug 2026.");
  }, 60_000);
  it("with no previous day it asks which day, and the day carries over from a spending-day answer", async () => {
    const u = await both();
    const cold = await chatTurn(u, { message: "Show all transactions for that day." }, TODAY);
    expect(cold.message.content).toMatch(/Which day do you mean\?/);
    const first = await chatTurn(u, { message: "Which day did I spend the most?" }, TODAY);
    const r = await chatTurn(u, { message: "Show all transactions for that day.", sessionId: first.sessionId }, TODAY);
    expect(r.intent).toBe("transaction_list");
    expect(r.message.content).toContain("Found **6 transactions** on 5 Aug 2026.");
  }, 60_000);
  it("the exact bug still holds: the 24 Aug list is a list and never the balance", async () => {
    const u = await both();
    const a = ask(u, "List all transactions on 24th August.");
    expect(a.intent).toBe("transaction_list");
    expect(a.text).toContain("Found **6 transactions** on 24 Aug 2026.");
    expect(a.text).not.toMatch(/balance/i);
  }, 60_000);
});

describe("ranking answers are deterministic and never given to the language model", () => {
  it("the LLM is not asked to rank or rewrite anything it cannot verify", async () => {
    const u = await both();
    const a = ask(u, "Which day did I spend the most?");
    let prompt = "";
    const provider: AiProvider = { name: "mock", complete: async (r) => ((prompt = r.user), "**5 Aug 2026** had the highest spending: ₹1,263.") };
    const out = await narrate("Which day did I spend the most?", a, true, { provider });
    // the model only sees the already-computed result (no transactions) and its reply is checked against those numbers
    expect(prompt).toContain("1263");
    expect(prompt).not.toMatch(/Zepto Marketplace|621331236828|Naseeb/);
    expect(out.usedLlm).toBe(true);
    const liar: AiProvider = { name: "liar", complete: async () => "**7 Aug 2026** had the highest spending: ₹9,999." };
    expect(await narrate("Which day did I spend the most?", a, true, { provider: liar })).toEqual({ text: a.text, usedLlm: false });
  }, 60_000);
});
