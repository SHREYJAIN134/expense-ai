/**
 * Regression: "list all the transaction on 24th of august" was answered with the latest balance.
 * Root causes fixed here: (1) no transaction-list intent, (2) "unknown + a date" inherited the PREVIOUS intent
 * (balance), (3) "24th of August" was read as the whole month. These tests pin intent + filter extraction, the date
 * resolver, and the answers against a real database holding BOTH HDFC and Google Pay data.
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
import { parseQuestion, type ParsedQuery } from "../src/lib/chat/intent";
import { resolveExplicitDates } from "../src/lib/chat/dates";
import { resolvePeriod } from "../src/lib/chat/period";
import { chatTurn } from "../src/lib/chat/service";
import { narrate } from "../src/lib/chat/llm";
import { dataRange, loadAllTxns } from "../src/lib/services/data";
import { pagesFromLayout } from "../scripts/gpay-pdf";
import type { AiProvider } from "../src/lib/ai/provider";
import type { ParsedStatement, ParsedTransaction } from "../src/lib/domain/types";
import { GPAY_ROWS, type GPayRow } from "./gpay-fixture";

const TODAY = "2026-09-21"; // a Monday
const AUG = { from: "2026-08-01", to: "2026-08-31" };
const ctx = { today: TODAY, monthStartDay: 1, merchants: ["Zepto", "Blinkit", "Swiggy"], dataRange: AUG };
const parse = (q: string, extra: Partial<typeof ctx> & { last?: never } = {}): ParsedQuery => parseQuestion(q, { ...ctx, ...extra });
const day = (p: ParsedQuery) => p.period && [p.period.from, p.period.to];

describe("the exact bug", () => {
  it("'list all the transaction on 24th of august' is a TRANSACTION_LIST for 2026-08-24, never a balance", () => {
    const p = parse("list all the transaction on 24th of august");
    expect(p.intent).toBe("transaction_list");
    expect(day(p)).toEqual(["2026-08-24", "2026-08-24"]);
    expect(p.direction).toBeUndefined();
    expect(p.dateProblem).toBeUndefined();
  });
  it("even straight after a balance question (the follow-up path that caused the bug)", () => {
    const p = parseQuestion("list all the transaction on 24th of august", { ...ctx, last: { intent: "balance" } });
    expect(p).toMatchObject({ intent: "transaction_list", followUp: false });
    // and a bare follow-up must not resurrect a balance answer either
    const bare = parseQuestion("what about last month?", { ...ctx, last: { intent: "balance" } });
    expect(bare.intent).toBe("unknown");
    for (const last of ["safe_to_spend", "upcoming_payments", "afford"] as const) expect(parseQuestion("what about august?", { ...ctx, last: { intent: last } }).intent).toBe("unknown");
    // ...while a legitimate follow-up still works
    expect(parseQuestion("what about last month?", { ...ctx, last: { intent: "transaction_list", direction: "credit" } })).toMatchObject({ intent: "transaction_list", followUp: true, direction: "credit" });
  });
});

describe("intent precedence: similar questions do not collapse into one", () => {
  const cases: [string, string][] = [
    ["show all transactions on August 24", "transaction_list"],
    ["transactions on 24 August", "transaction_list"],
    ["list transactions on August 24", "transaction_list"],
    ["show payments on August 24", "transaction_list"],
    ["show credits on August 24", "transaction_list"],
    ["show debits on August 24", "transaction_list"],
    ["show transactions from August 20 to August 24", "transaction_list"],
    ["show my transactions from August 20 to August 24", "transaction_list"],
    ["list my transactions from August 20 to August 24", "transaction_list"],
    ["show all payments I made on August 24", "transaction_list"],
    ["what transactions did I receive on August 24?", "transaction_list"],
    ["what did I spend yesterday?", "transaction_list"],
    ["transactions on 24/08", "transaction_list"],
    ["transactions on 24-08", "transaction_list"],
    ["show all transactions today", "transaction_list"],
    ["how many transactions did I make on August 24?", "transaction_list"],
    ["how much did I spend on August 24?", "spend_total"],
    ["what is my balance?", "balance"],
    ["what is my current balance?", "balance"],
    ["what was my balance on August 24?", "historical_balance"],
    ["how much did I spend on food on August 24?", "spend_category"],
    ["what did I spend on Blinkit on August 24?", "spend_merchant"],
    ["list transactions of Zepto on August 24", "transaction_list"],
  ];
  it.each(cases)("%s -> %s", (q, intent) => expect(parse(q).intent).toBe(intent));

  it("extracts intent + date range + direction + merchant + category before querying", () => {
    expect(parse("show all credits on August 24")).toMatchObject({ intent: "transaction_list", direction: "credit" });
    expect(parse("show all debits on August 24")).toMatchObject({ intent: "transaction_list", direction: "debit" });
    expect(parse("show payments on August 24").direction).toBe("debit");
    expect(parse("what transactions did I receive on August 24?").direction).toBe("credit");
    expect(day(parse("show transactions from August 20 to August 24"))).toEqual(["2026-08-20", "2026-08-24"]);
    expect(parse("list transactions of Zepto on August 24")).toMatchObject({ merchant: "Zepto" });
    expect(parse("show food transactions on August 24")).toMatchObject({ intent: "transaction_list", category: "FOOD" });
    expect(day(parse("what did I spend yesterday?"))).toEqual(["2026-09-20", "2026-09-20"]);
    expect(parse("what did I spend yesterday?").direction).toBe("debit");
  });
  it("the same date gives different query plans for different questions", () => {
    const [a, b, c, d] = ["show all transactions on 24 August 2026", "how much did I spend on 24 August 2026?", "what was my balance on 24 August 2026?", "what is my balance?"].map((q) => parse(q));
    expect([a.intent, b.intent, c.intent, d.intent]).toEqual(["transaction_list", "spend_total", "historical_balance", "balance"]);
    expect(day(a)).toEqual(day(b));
    expect(day(b)).toEqual(day(c));
  });
  it("analytical questions that mention transactions are not turned into lists", () => {
    expect(parse("what was my biggest transaction this month?").intent).toBe("largest_transaction"); // one event, any direction
    expect(parse("what was my biggest expense this month?").intent).toBe("biggest_expense"); // spending only
    expect(parse("what are unusual transactions?").intent).toBe("anomalies");
    expect(parse("show my recurring payments").intent).toBe("recurring_list");
    expect(parse("what payments are coming up in the next 30 days?").intent).toBe("upcoming_payments");
    expect(parse("compare my transactions this month with last month").intent).toBe("compare_periods");
  });
});

describe("date resolution", () => {
  const r = (t: string, data: { from: string; to: string } | undefined = AUG) => resolveExplicitDates(t, TODAY, data);
  const one = (t: string, data?: { from: string; to: string }) => {
    const x = r(t, data);
    return x && [x.from, x.to, x.error, x.clarify];
  };
  it("day + month in every common spelling", () => {
    for (const t of ["24th of august", "24 august", "august 24", "on august 24", "24th aug", "aug 24th", "24 Aug 2026", "August 24, 2026", "2026-08-24", "24/08", "24-08", "24/08/2026", "24-08-26", "the 24th of August", "24 AUGUST"]) {
      expect(one(t), t).toEqual(["2026-08-24", "2026-08-24", undefined, undefined]);
    }
  });
  it("ranges, in either order and with shared months", () => {
    expect(one("from august 20 to august 24")).toEqual(["2026-08-20", "2026-08-24", undefined, undefined]);
    expect(one("between 20 aug and 24 aug")).toEqual(["2026-08-20", "2026-08-24", undefined, undefined]);
    expect(one("from 24 august to 20 august")).toEqual(["2026-08-20", "2026-08-24", undefined, undefined]);
    expect(one("from 20 to 24 august")).toEqual(["2026-08-20", "2026-08-24", undefined, undefined]);
    expect(one("between 20th and 24th of august 2026")).toEqual(["2026-08-20", "2026-08-24", undefined, undefined]);
  });
  it("relative dates use the application's current date", () => {
    expect(resolvePeriod("yesterday", TODAY)).toMatchObject({ from: "2026-09-20", to: "2026-09-20" });
    expect(resolvePeriod("today", TODAY)).toMatchObject({ from: TODAY, to: TODAY });
    expect(one("last monday")).toEqual(["2026-09-14", "2026-09-14", undefined, undefined]); // today is a Monday: strictly before today
    expect(one("last friday")).toEqual(["2026-09-18", "2026-09-18", undefined, undefined]);
    expect(one("this wednesday")).toEqual(["2026-09-23", "2026-09-23", undefined, undefined]);
    expect(resolveExplicitDates("last monday", "2026-09-23")).toMatchObject({ from: "2026-09-21" });
  });
  it("impossible dates are an error, never silently reinterpreted", () => {
    expect(r("august 35")?.error).toMatch(/not a valid date/);
    expect(r("35 august")?.error).toMatch(/not a valid date/);
    expect(r("31 feb")?.error).toMatch(/never has 31 days/);
    expect(r("30 february 2026")?.error).toMatch(/not a valid date/);
    expect(r("29 february 2026")?.error).toMatch(/28 days/);
    expect(r("29 february 2024")?.error).toBeUndefined();
    expect(one("31 apr 2026")?.[2]).toBeTruthy();
  });
  it("no year: the statement's year is used when unambiguous; several possible years means asking", () => {
    expect(one("24 august", { from: "2026-08-01", to: "2026-08-31" })).toEqual(["2026-08-24", "2026-08-24", undefined, undefined]);
    expect(one("24 august", { from: "2025-08-10", to: "2025-09-05" })).toEqual(["2025-08-24", "2025-08-24", undefined, undefined]);
    const amb = r("24 august", { from: "2025-06-01", to: "2026-09-01" })!;
    expect(amb.clarify).toMatch(/2025 and 2026.*Which year/);
    expect(one("24 august 2025", { from: "2025-06-01", to: "2026-09-01" })).toEqual(["2025-08-24", "2025-08-24", undefined, undefined]);
    // without any data the most recent non-future date is used
    expect(one("24 august", undefined)).toEqual(["2026-08-24", "2026-08-24", undefined, undefined]);
    expect(one("24 december", undefined)).toEqual(["2025-12-24", "2025-12-24", undefined, undefined]);
  });
  it("problems surface through the parser as dateProblem (and the intent still reflects the question)", () => {
    expect(parse("show transactions on August 35")).toMatchObject({ intent: "transaction_list", period: null, dateProblem: { kind: "error" } });
    expect(parse("what was my balance on 31 feb").intent).toBe("historical_balance");
    expect(parse("how much did I spend on august 35?").intent).toBe("spend_total");
    expect(parse("show transactions on 24 august", { dataRange: { from: "2025-06-01", to: "2026-09-01" } } as never)).toMatchObject({ dateProblem: { kind: "clarify" } });
  });
  it("month-level and older phrasing keep working", () => {
    expect(resolvePeriod("in august", TODAY, 1, AUG)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(resolvePeriod("last month", TODAY)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(resolvePeriod("last 30 days", TODAY)).toMatchObject({ from: "2026-08-23", to: TODAY });
    expect(resolvePeriod("how much may I spend", TODAY)).toBeNull();
  });
});

/* -------------------------- real database, both sources -------------------------- */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "user";
function hdfcParsed(rows: GPayRow[]): { statement: ParsedStatement; normalized: ReturnType<typeof normalizeTransactions> } {
  let balance = 100000;
  const txns: ParsedTransaction[] = rows.map((r, i) => {
    const narration = `UPI-${r.counterparty.toUpperCase()}-${slug(r.counterparty)}@okhdfcbank-HDFC0000001-${r.id}-UPI`;
    balance = Math.round((balance + (r.direction === "credit" ? r.amount : -r.amount)) * 100) / 100;
    return { date: r.date, rawDescription: narration, narrationLines: [narration], reference: "0000" + r.id, debit: r.direction === "debit" ? r.amount : 0, credit: r.direction === "credit" ? r.amount : 0, balance, rowIndex: i, warnings: [] };
  });
  const statement: ParsedStatement = { bank: "HDFC", parserVersion: "test", account: { mask: "9332" }, period: { start: rows[0].date, end: rows[rows.length - 1].date }, transactions: txns, warnings: [] };
  return { statement, normalized: normalizeTransactions(txns) };
}
const file = (n: string) => ({ name: n, size: 1, sha: crypto.createHash("sha256").update(n + Math.random()).digest("hex") });
const db = () => getDb();

async function bothSources(): Promise<string> {
  const u = (await createUser({ email: `tl${Math.random()}@example.com`, name: "Test Owner", password: "transaction list password 1" })).id;
  const h = await stageParsed(u, file("bank.pdf"), hdfcParsed(GPAY_ROWS));
  confirmImport(u, h.statementId, { acknowledgeReconciliation: true });
  const st = parseGooglePayPages(pagesFromLayout({ rows: GPAY_ROWS, sent: 12379.76, received: 5602 }));
  const g = await stageParsed(u, file("gpay.pdf"), { statement: st, normalized: normalizeGooglePay(st) });
  confirmImport(u, g.statementId, { acknowledgeReconciliation: true });
  return u;
}
const ask = (u: string, q: string): Answer => {
  const merchants = [...new Set(loadAllTxns(u).map((t) => t.merchant))];
  return answerQuery(u, parseQuestion(q, { today: TODAY, monthStartDay: 1, merchants, dataRange: dataRange(u) }), TODAY);
};
const AUG24 = GPAY_ROWS.filter((r) => r.date === "2026-08-24");

describe("the actual answer, from the real database (HDFC + Google Pay both imported)", () => {
  it("lists the real transactions for 24 Aug 2026 once each, with source, category and method - never the balance", async () => {
    const u = await bothSources();
    expect(AUG24).toHaveLength(6);
    const a = ask(u, "list all the transaction on 24th of august");
    expect(a.intent).toBe("transaction_list");
    expect(a.text).toContain("Found **6 transactions** on 24 Aug 2026.");
    expect(a.text).not.toMatch(/balance/i);
    const f = a.facts as { count: number; debitCount: number; creditCount: number; transactions: { merchant: string; amount: number; type: string; category: string; source: string; time: string | null; paymentMethod: string | null }[] };
    expect(f).toMatchObject({ count: 6, debitCount: 3, creditCount: 3 });
    // canonical events: 12 statement rows (6 HDFC + 6 Google Pay) but 6 payments
    expect((db().prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND txn_date = '2026-08-24'").get(u) as { n: number }).n).toBe(12);
    expect(f.transactions.every((t) => t.source === "HDFC + Google Pay")).toBe(true);
    // every real Google Pay row of that day appears exactly once, with its real amount, direction and time
    for (const r of AUG24) {
      const hit = f.transactions.filter((t) => t.amount === r.amount && t.type === (r.direction === "debit" ? "Debit" : "Credit") && t.time === r.time);
      expect(hit, `${r.counterparty} ${r.amount}`).toHaveLength(1);
    }
    const zepto = f.transactions.find((t) => t.amount === 325)!;
    expect(zepto).toMatchObject({ merchant: "Zepto", type: "Debit", category: "Groceries", paymentMethod: "UPI", source: "HDFC + Google Pay" });
    expect(a.text).toMatch(/\d+\. 1[0-9]:\d\d · Zepto — ₹325 — Debit — Groceries — UPI — HDFC \+ Google Pay/);
    // sorted by time; numbered; all lines present
    const lines = a.text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines).toHaveLength(6);
    const times = f.transactions.map((t) => t.time!);
    expect([...times].sort()).toEqual(times);
    expect(f.debitCount + f.creditCount).toBe(6);
  }, 60_000);

  it("filters by direction, merchant and category", async () => {
    const u = await bothSources();
    const credits = ask(u, "show all credits on August 24");
    expect(credits.facts).toMatchObject({ count: 3, direction: "credit", creditCount: 3, debitCount: 0, creditTotal: 50 + 150 + 114 });
    expect(credits.text).toContain("Found **3 transactions** on 24 Aug 2026 (credits (money in))");
    const debits = ask(u, "show all debits on August 24");
    expect(debits.facts).toMatchObject({ count: 3, direction: "debit", debitTotal: 100 + 325 + 250 });
    expect(ask(u, "show all payments I made on August 24").facts).toMatchObject({ count: 3, direction: "debit" });
    expect(ask(u, "what transactions did I receive on August 24?").facts).toMatchObject({ count: 3, direction: "credit" });
    const zepto = ask(u, "list transactions of Zepto on August 24");
    expect(zepto.facts).toMatchObject({ count: 1, merchant: "Zepto" });
  }, 60_000);

  it("ranges list every day in between, canonical and ordered", async () => {
    const u = await bothSources();
    const a = ask(u, "show transactions from August 20 to August 24");
    const expected = (db().prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND is_primary = 1 AND txn_date BETWEEN '2026-08-20' AND '2026-08-24'").get(u) as { n: number }).n;
    expect(expected).toBe(GPAY_ROWS.filter((r) => r.date >= "2026-08-20" && r.date <= "2026-08-24").length);
    expect((a.facts as { count: number }).count).toBe(expected);
    expect(a.text).toContain(`Found **${expected} transactions** from 20 Aug 2026 to 24 Aug 2026.`);
    const dates = (a.facts as { transactions: { date: string }[] }).transactions.map((t) => t.date);
    expect([...dates].sort()).toEqual(dates);
    expect(a.text).toMatch(/1\. 20 Aug 2026 · /); // date shown on every line of a range
  }, 60_000);

  it("gives the complete list, not the first few", async () => {
    const u = await bothSources();
    const a = ask(u, "show all transactions from 1 August to 31 August 2026");
    expect((a.facts as { count: number }).count).toBe(83);
    expect(a.text.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(83);
    expect(a.text).toContain("Found **83 transactions**");
  }, 60_000);

  it("one question, three different query behaviours", async () => {
    const u = await bothSources();
    const list = ask(u, "show all transactions on 24 August 2026");
    const spend = ask(u, "how much did I spend on 24 August 2026?");
    const bal = ask(u, "what is my balance?");
    expect([list.intent, spend.intent, bal.intent]).toEqual(["transaction_list", "spend_total", "balance"]);
    // spending on that day = debits that are not transfers to people (Zepto + The Den), not the full-month figure
    const sql = (db().prepare("SELECT ROUND(SUM(debit),2) s FROM transactions WHERE user_id = ? AND is_primary = 1 AND txn_date = '2026-08-24' AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS')").get(u) as { s: number }).s;
    expect(spend.facts.spending).toBe(sql);
    expect(sql).toBe(325 + 250);
    expect(spend.text).toMatch(/On 24 Aug 2026 you spent/);
    // current balance = the last bank balance on record
    const last = db().prepare("SELECT balance_after b FROM transactions WHERE user_id = ? AND is_primary = 1 AND balance_after IS NOT NULL ORDER BY txn_date DESC, seq DESC LIMIT 1").get(u) as { b: number };
    expect(bal.facts.balance).toBe(last.b);
    expect(list.text).not.toContain("latest known balance");
    expect(bal.text).toContain("latest known balance");
  }, 60_000);

  it("balance on a date is the bank balance at the end of that day", async () => {
    const u = await bothSources();
    const a = ask(u, "what was my balance on August 24?");
    expect(a.intent).toBe("historical_balance");
    const sql = db().prepare("SELECT balance_after b FROM transactions WHERE user_id = ? AND is_primary = 1 AND balance_after IS NOT NULL AND txn_date <= '2026-08-24' ORDER BY txn_date DESC, seq DESC LIMIT 1").get(u) as { b: number };
    expect(a.facts).toMatchObject({ date: "2026-08-24", balance: sql.b });
    expect(a.text).toContain("Your balance at the end of 24 Aug 2026");
    const before = ask(u, "what was my balance on 15 july 2026?");
    expect(before.noData).toBe(true);
    expect(before.text).toMatch(/don't have a recorded balance/);
    const future = ask(u, "what was my balance on 15 september 2026?");
    expect(future.text).toMatch(/only have data up to/);
  }, 60_000);

  it("an empty day says so - and does not fall back to the balance", async () => {
    const u = await bothSources();
    expect(GPAY_ROWS.some((r) => r.date === "2026-08-22")).toBe(false);
    const a = ask(u, "show all transactions on August 22");
    expect(a.text).toContain("No transactions were found for 22 Aug 2026.");
    expect(a.text).not.toMatch(/balance/i);
    expect(a.facts).toMatchObject({ count: 0 });
    const out = ask(u, "show transactions on 3 march 2026");
    expect(out.text).toMatch(/No transactions were found for 3 Mar 2026/);
    expect(out.text).toMatch(/covers/); // and explains what the data does cover
  }, 60_000);

  it("invalid dates are reported; ambiguous years are asked about; nothing is guessed", async () => {
    const u = await bothSources();
    const bad = ask(u, "show transactions on August 35");
    expect(bad.text).toMatch(/couldn't read that date/);
    expect(bad.text).not.toMatch(/balance/i);
    expect(bad.noData).toBe(true);
    expect(ask(u, "show transactions on 31 feb").text).toMatch(/never has 31 days/);
  }, 60_000);

  it("through the full chat pipeline: a balance question first, then the exact failing question in the same conversation", async () => {
    const u = await bothSources();
    const first = await chatTurn(u, { message: "what is my balance?" }, TODAY);
    expect(first.intent).toBe("balance");
    const second = await chatTurn(u, { message: "list all the transaction on 24th of august", sessionId: first.sessionId }, TODAY);
    expect(second.intent).toBe("transaction_list");
    expect(second.message.content).toContain("Found **6 transactions** on 24 Aug 2026.");
    expect(second.message.content).toContain("Zepto — ₹325");
    expect(second.message.content).not.toMatch(/latest known balance/);
    expect(second.understood).toMatchObject({ intent: "transaction_list", followUp: false, period: "on 24 Aug 2026" });
    // a real follow-up on the list re-parameterises the list, not the balance
    const third = await chatTurn(u, { message: "what about the 25th of august?", sessionId: first.sessionId }, TODAY);
    expect(third.intent).toBe("transaction_list");
    expect(third.understood.followUp).toBe(true);
  }, 60_000);

  it("the language model never sees or rewrites a transaction list", async () => {
    const u = await bothSources();
    let called = 0;
    const provider: AiProvider = { name: "mock", complete: async () => (called++, "Here are some transactions.") };
    const a = ask(u, "list all the transaction on 24th of august");
    const out = await narrate("list all the transaction on 24th of august", a, true, { provider });
    expect(called).toBe(0);
    expect(out).toEqual({ text: a.text, usedLlm: false });
  }, 60_000);

  it("a single-source (HDFC only) list shows only HDFC", async () => {
    const u = (await createUser({ email: `tl${Math.random()}@example.com`, name: "Solo", password: "transaction list password 2" })).id;
    const h = await stageParsed(u, file("bank.pdf"), hdfcParsed(GPAY_ROWS));
    confirmImport(u, h.statementId, { acknowledgeReconciliation: true });
    const a = ask(u, "show all transactions on August 24");
    expect((a.facts as { transactions: { source: string }[] }).transactions.every((t) => t.source === "HDFC")).toBe(true);
    expect((a.facts as { count: number }).count).toBe(6);
  }, 60_000);
});
