/**
 * V2 financial intelligence against a real (in-memory) SQLite database: chatbot numerical answers cross-checked
 * with independent SQL, user isolation, settings, the migration, overlapping statements and AI payload privacy.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db/client";
import { createUser, getSettings, updateSettings } from "../src/lib/services/users";
import { confirmImport, stageStatement } from "../src/lib/pipeline/import";
import { loadDemoData } from "../src/lib/services/demo";
import { loadAllTxns } from "../src/lib/services/data";
import { queryTransactions } from "../src/lib/services/transactions";
import { upsertBudget, getUpcoming } from "../src/lib/services/planning";
import { anomalyFlags, getAnomalies, getInsights, getProjection, getSafeToSpend, getSnapshot, getSpendingIntelligence } from "../src/lib/services/intelligence";
import { answerQuery, type Answer } from "../src/lib/chat/answer";
import { parseQuestion } from "../src/lib/chat/intent";
import { resolvePeriod } from "../src/lib/chat/period";
import { narrate } from "../src/lib/chat/llm";
import { buildAiPayload, maskSensitiveText, Redactor, sanitizeFacts } from "../src/lib/chat/privacy";
import { chatTurn } from "../src/lib/chat/service";
import { generateRealHdfcPdf } from "../scripts/real-pdf";
import type { AiProvider } from "../src/lib/ai/provider";
import { buildRealStatement } from "./real-fixture";

const TODAY = "2026-09-21"; // Monday; the demo data runs up to this date
const AUG_END = "2026-08-31"; // the synthetic real-format statement covers August 2026

let demo = "";
let real = "";
let stranger = "";

const db = () => getDb();
const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** Independent SQL: net spending (debits excluding transfers/investments, minus refunds linked to each debit). */
function netSpendSql(userId: string, from: string, to: string, where = ""): number {
  const r = db()
    .prepare(
      `SELECT ROUND(COALESCE(SUM(MAX(0, t.debit - COALESCE((SELECT SUM(x.credit) FROM transactions x WHERE x.user_id = t.user_id AND x.refund_reference = t.id), 0))), 0), 2) AS s
       FROM transactions t
       WHERE t.user_id = ? AND t.direction = 'debit' AND t.category NOT IN ('TRANSFERS','INVESTMENTS') AND t.txn_date BETWEEN ? AND ? ${where}`,
    )
    .get(userId, from, to) as { s: number };
  return r.s;
}

function categoriesSql(userId: string, from: string, to: string) {
  return db()
    .prepare(
      `SELECT t.category AS c, ROUND(SUM(MAX(0, t.debit - COALESCE((SELECT SUM(x.credit) FROM transactions x WHERE x.user_id = t.user_id AND x.refund_reference = t.id), 0))), 2) AS s
       FROM transactions t
       WHERE t.user_id = ? AND t.direction = 'debit' AND t.category NOT IN ('TRANSFERS','INVESTMENTS') AND t.txn_date BETWEEN ? AND ?
       GROUP BY t.category HAVING s > 0 ORDER BY s DESC, c`,
    )
    .all(userId, from, to) as { c: string; s: number }[];
}

function ask(userId: string, message: string, today = TODAY): Answer {
  const merchants = [...new Set(loadAllTxns(userId).map((t) => t.merchant))];
  const parsed = parseQuestion(message, { today, monthStartDay: getSettings(userId).monthStartDay, merchants });
  return answerQuery(userId, parsed, today);
}

beforeAll(async () => {
  demo = (await createUser({ email: "demo-intel@example.com", name: "Demo", password: "demo intelligence pw 1" })).id;
  real = (await createUser({ email: "real-intel@example.com", name: "Real", password: "real intelligence pw 2" })).id;
  stranger = (await createUser({ email: "stranger-intel@example.com", name: "Stranger", password: "stranger intelligence pw 3" })).id;
  await loadDemoData(demo, TODAY);
  const { rows, official } = buildRealStatement();
  const staged = await stageStatement(real, { name: "aug.pdf", data: await generateRealHdfcPdf({ rows, official }) }, undefined);
  confirmImport(real, staged.statementId);
}, 120_000);

describe("migration 3 (additive settings only)", () => {
  it("applies once, keeps earlier tables and stores no derived data", () => {
    const ids = (db().prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([1, 2, 3, 4]);
    const cols = (db().prepare("PRAGMA table_info(user_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["safety_buffer", "change_min_pct", "change_min_amount", "change_min_txns", "anomaly_min_amount", "include_detected_recurring", "reserve_budgets"]));
    const tables = (db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["transactions", "financial_insights", "recurring_expenses", "budgets"]));
    // anomalies / insights / projections are recomputed from the ledger, never stored (they cannot go stale)
    expect(tables).not.toEqual(expect.arrayContaining(["anomalies"]));
  });
  it("new settings have safe defaults and round-trip", async () => {
    const fresh = (await createUser({ email: "defaults@example.com", name: "D", password: "defaults intelligence pw" })).id;
    expect(getSettings(fresh)).toMatchObject({ safetyBuffer: null, changeMinPct: 25, changeMinAmount: 500, changeMinTxns: 3, anomalyMinAmount: 1000, includeDetectedRecurring: true, reserveBudgets: true });
    updateSettings(fresh, { safetyBuffer: 2500, changeMinPct: 40, includeDetectedRecurring: false, reserveBudgets: false });
    expect(getSettings(fresh)).toMatchObject({ safetyBuffer: 2500, changeMinPct: 40, includeDetectedRecurring: false, reserveBudgets: false, monthStartDay: 1 });
    updateSettings(fresh, { safetyBuffer: null });
    expect(getSettings(fresh).safetyBuffer).toBeNull();
  });
});

describe("assistant numerical answers match independent SQL", () => {
  it("How much did I spend this month?", () => {
    const a = ask(demo, "How much did I spend this month?");
    expect(a.intent).toBe("spend_total");
    const expected = netSpendSql(demo, "2026-09-01", "2026-09-30");
    expect(a.facts.spending).toBe(expected);
    expect(a.text).toContain(fmt(expected));
    expect(a.calculation?.join(" ")).toMatch(/excluding transfers/);
  });

  it("Where did most of my money go?", () => {
    const a = ask(demo, "Where did most of my money go?");
    expect(a.intent).toBe("top_categories");
    const sql = categoriesSql(demo, "2026-06-24", TODAY); // default window: last 90 days
    const cats = a.facts.categories as { category: string; amount: number }[];
    expect(cats[0]).toMatchObject({ category: sql[0].c, amount: sql[0].s });
    expect(cats.map((c) => c.category)).toEqual(sql.slice(0, cats.length).map((r) => r.c));
  });

  it("food, merchant and subscription questions", () => {
    const food = ask(demo, "How much did I spend on food last month?");
    expect(food.intent).toBe("spend_category");
    expect(food.facts.total).toBe(netSpendSql(demo, "2026-08-01", "2026-08-31", "AND t.category = 'FOOD'"));
    const sw = ask(demo, "How much did I spend on Swiggy this year?");
    expect(sw.intent).toBe("spend_merchant");
    expect(sw.facts.total).toBe(netSpendSql(demo, "2026-01-01", TODAY, "AND t.merchant = 'Swiggy'"));
    const subs = ask(demo, "What are my subscriptions?");
    expect(subs.intent).toBe("recurring_list");
    expect(subs.text).toMatch(/per month/);
    expect(subs.text).toMatch(/estimate/i);
    expect(JSON.stringify(subs.table)).toMatch(/Netflix/);
    expect((subs.facts.items as { type?: string }[]).some((i) => ["FIXED", "VARIABLE", "AUTOPAY"].includes(i.type ?? ""))).toBe(true);
  });

  it("Blinkit: a debit and its refund are netted, not double counted", () => {
    const a = ask(real, "How much did I spend on Blinkit this month?", AUG_END);
    expect(a.intent).toBe("spend_merchant");
    expect(a.facts.total).toBe(netSpendSql(real, "2026-08-01", AUG_END, "AND t.merchant = 'Blinkit'"));
    const gross = (db().prepare("SELECT ROUND(SUM(debit),2) s FROM transactions WHERE user_id = ? AND merchant = 'Blinkit' AND direction='debit'").get(real) as { s: number }).s;
    expect(gross).toBeGreaterThan(a.facts.total as number); // the ₹266 refund was subtracted
  });

  it("largest transaction (one canonical event, any direction) and biggest expense (spending only)", () => {
    const a = ask(demo, "What was my largest transaction this month?");
    expect(a.intent).toBe("largest_transaction");
    const top = db().prepare("SELECT MAX(amount) m FROM transactions WHERE user_id = ? AND is_primary = 1 AND txn_date BETWEEN '2026-09-01' AND '2026-09-30'").get(demo) as { m: number };
    expect((a.facts.transactions as { amount: number }[])[0].amount).toBe(top.m);
    const e = ask(demo, "What was my biggest expense this month?");
    expect(e.intent).toBe("biggest_expense");
    const spend = db().prepare("SELECT debit FROM transactions WHERE user_id = ? AND direction='debit' AND category NOT IN ('TRANSFERS','INVESTMENTS') AND txn_date BETWEEN '2026-09-01' AND '2026-09-30' ORDER BY debit DESC LIMIT 1").get(demo) as { debit: number };
    expect((e.facts.top as { amount: number }[])[0].amount).toBe(spend.debit);
  });

  it("compare this month with last month (like-for-like)", () => {
    const a = ask(demo, "Compare this month with last month");
    expect(a.intent).toBe("compare_periods");
    const cur = a.facts.current as { spending: number };
    const prev = a.facts.previous as { spending: number };
    expect(cur.spending).toBe(netSpendSql(demo, "2026-09-01", TODAY));
    expect(prev.spending).toBe(netSpendSql(demo, "2026-08-01", "2026-08-21"));
    expect(a.facts.difference).toBe(Math.round((cur.spending - prev.spending) * 100) / 100);
  });

  it("Why did my spending increase this month?", () => {
    const a = ask(demo, "Why did my spending increase this month?");
    expect(a.intent).toBe("why_spending_changed");
    const cur = netSpendSql(demo, "2026-09-01", TODAY);
    const prev = netSpendSql(demo, "2026-08-01", "2026-08-21");
    const f = a.facts as { current: { spending: number }; previous: { spending: number }; difference: number; direction: string; categoryDrivers: { category: string; change: number }[] };
    expect(f.current.spending).toBe(cur);
    expect(f.previous.spending).toBe(prev);
    expect(f.difference).toBe(Math.round((cur - prev) * 100) / 100);
    expect(f.direction).toBe(cur > prev ? "up" : cur < prev ? "down" : "flat");
    const now = new Map(categoriesSql(demo, "2026-09-01", TODAY).map((r) => [r.c, r.s]));
    const before = new Map(categoriesSql(demo, "2026-08-01", "2026-08-21").map((r) => [r.c, r.s]));
    for (const d of f.categoryDrivers) expect(d.change).toBeCloseTo((now.get(d.category) ?? 0) - (before.get(d.category) ?? 0), 2);
    expect(a.calculation?.length).toBeGreaterThan(1);
    if (f.direction === "down") expect(a.text).toMatch(/actually went down/); // a false premise is corrected, not played along with
  });

  it("does not explain a change it cannot see (no previous period in the data)", () => {
    const a = ask(real, "Why did my spending increase this month?", AUG_END);
    expect(a.intent).toBe("why_spending_changed");
    expect(JSON.stringify(a.facts)).not.toMatch(/categoryDrivers/);
    expect(a.text).toMatch(/no transactions|can't|cannot|history starts/i);
  });

  it("Which categories increased the most?", () => {
    const a = ask(demo, "Which categories increased the most this month?");
    expect(a.intent).toBe("categories_changed");
    const now = new Map(categoriesSql(demo, "2026-09-01", TODAY).map((r) => [r.c, r.s]));
    const before = new Map(categoriesSql(demo, "2026-08-01", "2026-08-21").map((r) => [r.c, r.s]));
    const rows = (a.facts.categories as { category: string; change: number }[]) ?? [];
    for (const r of rows) expect(r.change).toBeCloseTo((now.get(r.category) ?? 0) - (before.get(r.category) ?? 0), 2);
    expect(rows.every((r, i) => i === 0 || rows[i - 1].change >= r.change)).toBe(true);
  });

  it("unusual spending recently: 'unusual activity', never fraud", () => {
    const a = ask(demo, "Show me unusual spending recently");
    expect(a.intent).toBe("anomalies");
    expect(a.text + JSON.stringify(a.facts)).not.toMatch(/fraud|scam|stolen/i);
    const items = (a.facts.items as { date: string }[]) ?? [];
    expect(items.every((i) => i.date >= "2026-08-23" && i.date <= TODAY)).toBe(true); // "recently" = last 30 days
    if (!items.length) expect(a.text).toMatch(/unusual activity/i);
  });

  it("safe to spend = balance - recurring - budgets - buffer, with the estimate disclaimer", () => {
    upsertBudget(demo, { category: "FOOD", amount: 20000 });
    const a = ask(demo, "How much can I safely spend this month?");
    expect(a.intent).toBe("safe_to_spend");
    const s = getSafeToSpend(demo, TODAY);
    const f = a.facts as { safeToSpend: number; currentBalance: number; upcomingRecurring: number; budgetCommitments: number; safetyBuffer: number };
    expect(f.safeToSpend).toBe(s.amount);
    expect(Math.max(0, Math.round((f.currentBalance - f.upcomingRecurring - f.budgetCommitments - f.safetyBuffer) * 100) / 100)).toBe(f.safeToSpend);
    expect(a.text).toContain("Safe to spend is an estimate, not a guarantee.");
    expect(f.budgetCommitments).toBeGreaterThan(0);
  });

  it("upcoming recurring payments come from the same source as the Recurring page", () => {
    const a = ask(demo, "What recurring payments are coming up in the next 30 days?");
    expect(a.intent).toBe("upcoming_payments");
    const up = getUpcoming(demo, 30, TODAY).items.filter((i) => i.kind === "expense");
    expect(a.facts.count).toBe(up.length);
    expect(a.facts.total).toBe(Math.round(up.reduce((s, i) => s + i.amount, 0) * 100) / 100);
  });

  it("chatTurn still persists the calculation with the answer", async () => {
    const r = await chatTurn(demo, { message: "Why did my spending increase this month?" }, TODAY);
    expect(r.intent).toBe("why_spending_changed");
    expect(r.message.calculation?.length).toBeGreaterThan(1);
  });
});

describe("natural-language dates resolve to explicit deterministic ranges", () => {
  const r = (t: string, msd = 1) => {
    const p = resolvePeriod(t, TODAY, msd);
    return p && { from: p.from, to: p.to };
  };
  it("today, yesterday, weeks, months, quarters, years, month names and rolling windows", () => {
    expect(r("what did I spend today")).toEqual({ from: TODAY, to: TODAY });
    expect(r("yesterday")).toEqual({ from: "2026-09-20", to: "2026-09-20" });
    expect(r("this week")).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(r("last week")).toEqual({ from: "2026-09-14", to: "2026-09-20" });
    expect(r("this month")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(r("last month")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(r("this quarter")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(r("last quarter")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(r("this year")).toEqual({ from: "2026-01-01", to: TODAY });
    expect(r("in August")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(r("August")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(r("spending in december")).toEqual({ from: "2025-12-01", to: "2025-12-31" }); // a month that has not come yet this year means last year
    expect(r("last 30 days")).toEqual({ from: "2026-08-23", to: TODAY });
    expect(r("recently")).toEqual({ from: "2026-08-23", to: TODAY });
  });
  it("respects a custom financial month", () => {
    expect(r("this month", 25)).toEqual({ from: "2026-08-25", to: "2026-09-24" });
    expect(r("last month", 25)).toEqual({ from: "2026-07-25", to: "2026-08-24" });
  });
  it("'may' the verb is not the month", () => {
    expect(resolvePeriod("how much may I spend", TODAY)).toBeNull();
    expect(r("what did I spend in May")).toEqual({ from: "2026-05-01", to: "2026-05-31" });
    expect(r("may 2025")).toEqual({ from: "2025-05-01", to: "2025-05-31" });
  });
  it("unknown text gives no period instead of guessing", () => {
    expect(resolvePeriod("what is the weather", TODAY)).toBeNull();
  });
});

describe("intelligence settings change the results", () => {
  it("alert thresholds: a very high threshold silences change alerts; defaults restore them", async () => {
    const u = (await createUser({ email: "thresholds@example.com", name: "T", password: "thresholds intelligence pw" })).id;
    await loadDemoData(u, TODAY);
    const base = getInsights(u, TODAY);
    updateSettings(u, { changeMinPct: 500, changeMinAmount: 10_000_000 });
    const quiet = getInsights(u, TODAY);
    expect(quiet.filter((i) => ["spending_up", "spending_down", "category_spike", "category_drop", "merchant_spike"].includes(i.kind))).toEqual([]);
    expect(getSpendingIntelligence(u, "month", TODAY).changes).toEqual({ categories: [], merchants: [] });
    updateSettings(u, { changeMinPct: 25, changeMinAmount: 500 });
    expect(getInsights(u, TODAY)).toEqual(base);
  });
  it("safe to spend follows the user's buffer, recurring and budget assumptions", async () => {
    const u = (await createUser({ email: "safe@example.com", name: "S", password: "safe intelligence pw x" })).id;
    await loadDemoData(u, TODAY);
    upsertBudget(u, { category: "FOOD", amount: 15000 });
    const auto = getSafeToSpend(u, TODAY);
    expect(auto.bufferSource).toBe("auto");
    updateSettings(u, { safetyBuffer: auto.safetyBuffer + 1000 });
    const user = getSafeToSpend(u, TODAY);
    expect(user.bufferSource).toBe("user");
    expect(user.safetyBuffer).toBe(auto.safetyBuffer + 1000);
    expect(auto.raw! - user.raw!).toBeCloseTo(1000, 2);
    updateSettings(u, { reserveBudgets: false });
    const noBudgets = getSafeToSpend(u, TODAY);
    expect(noBudgets.budgetCommitments).toBe(0);
    expect(noBudgets.raw! - user.raw!).toBeCloseTo(user.budgetCommitments, 2);
    updateSettings(u, { includeDetectedRecurring: false });
    expect(getSafeToSpend(u, TODAY).upcomingRecurring).toBeLessThanOrEqual(noBudgets.upcomingRecurring);
  });
});

describe("intelligence over real-format imports", () => {
  it("snapshot: numbers agree with SQL, refunds netted, transfers excluded, no score", () => {
    const snap = getSnapshot(real, "month", AUG_END);
    expect(snap.spending.value).toBe(netSpendSql(real, "2026-08-01", AUG_END));
    const income = (db().prepare("SELECT ROUND(SUM(credit),2) s FROM transactions WHERE user_id = ? AND category = 'SALARY/INCOME'").get(real) as { s: number | null }).s ?? 0;
    expect(snap.income.value).toBe(income);
    expect(snap.balance?.amount).toBe(22493.21); // closing balance printed on the statement
    expect(snap.spending.refunded).toBeGreaterThanOrEqual(266);
    expect(snap.discretionary.disclaimer).toBe("Safe to spend is an estimate, not a guarantee.");
    expect(JSON.stringify(snap)).not.toMatch(/score|grade|excellent|health/i);
  });
  it("transactions carry refund / recurring / unusual indicators for the explorer", () => {
    const rows = queryTransactions(real, { pageSize: 200 }).rows;
    expect(rows.some((r) => r.isRefund)).toBe(true);
    expect(rows.some((r) => r.isRecurringCandidate)).toBe(true);
    expect(rows.every((r) => r.unusual === null || typeof r.unusual?.reason === "string")).toBe(true);
    expect("unusual" in rows[0]).toBe(true);
  });
  it("overlapping statements: importing the same statement again adds nothing and creates no duplicate-looking activity", async () => {
    const before = loadAllTxns(real).length;
    const dupBefore = getAnomalies(real, AUG_END).filter((a) => a.type === "possible_duplicate").length;
    const { rows, official } = buildRealStatement();
    const again = await stageStatement(real, { name: "aug-again.pdf", data: await generateRealHdfcPdf({ rows, official }) }, undefined);
    expect(again.counts.duplicates).toBe(again.counts.total);
    confirmImport(real, again.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(real)).toHaveLength(before);
    expect(getAnomalies(real, AUG_END).filter((a) => a.type === "possible_duplicate")).toHaveLength(dupBefore);
  }, 60_000);
  it("projection labels estimates and separates them from the actual balance", () => {
    const p = getProjection(real, AUG_END);
    expect(p.balance).toBe(22493.21);
    expect(p.disclaimer).toMatch(/estimates/i);
    expect(p.horizons.map((h) => h.days)).toEqual([7, 14, 30]);
    expect(p.path.filter((x) => x.actual !== undefined).every((x) => x.date <= AUG_END)).toBe(true);
  });
});

describe("user isolation", () => {
  it("another user sees nothing of this user's intelligence", () => {
    expect(getAnomalies(stranger, TODAY)).toEqual([]);
    expect(getInsights(stranger, TODAY)).toEqual([]);
    expect(anomalyFlags(stranger, TODAY).size).toBe(0);
    const snap = getSnapshot(stranger, "month", TODAY);
    expect(snap).toMatchObject({ balance: null, income: { value: 0 }, spending: { value: 0 }, largestCategory: null, largestMerchant: null });
    expect(snap.unusual.total).toBe(0);
    expect(getSafeToSpend(stranger, TODAY).amount).toBeNull();
    expect(getSpendingIntelligence(stranger, "month", TODAY).categories).toEqual([]);
    expect(getProjection(stranger, TODAY).horizons.every((h) => h.expectedRecurring === 0)).toBe(true);
    expect(queryTransactions(stranger, {}).total).toBe(0);
  });
  it("chat answers are scoped to the asking user", () => {
    const a = ask(stranger, "How much did I spend this month?");
    expect(a.noData).toBe(true);
    expect(a.text).toMatch(/don't have any transactions/);
    expect(JSON.stringify(a)).not.toMatch(/Swiggy|Netflix/);
  });
  it("one user's settings never change another's results", () => {
    updateSettings(demo, { changeMinPct: 61, safetyBuffer: 4321 });
    expect(getSettings(stranger)).toMatchObject({ changeMinPct: 25, safetyBuffer: null });
    updateSettings(demo, { changeMinPct: 25, safetyBuffer: null });
  });
  it("every flagged transaction id belongs to the owner", () => {
    const own = new Set(loadAllTxns(demo).map((t) => t.id));
    for (const id of anomalyFlags(demo, TODAY).keys()) expect(own.has(id)).toBe(true);
    for (const a of getAnomalies(demo, TODAY, { lookbackDays: 3650 })) for (const id of a.txnIds) expect(own.has(id)).toBe(true);
    for (const i of getInsights(demo, TODAY)) for (const id of i.txnIds) expect(own.has(id)).toBe(true);
  });
});

describe("insights are deterministic and reproducible from the database", () => {
  it("same database, same insights; each carries its calculation and references", () => {
    const a = getInsights(demo, TODAY);
    expect(a.length).toBeGreaterThan(0);
    expect(getInsights(demo, TODAY)).toEqual(a);
    for (const i of a) {
      expect(i.calculation.length).toBeGreaterThan(5);
      expect(JSON.stringify(i)).not.toMatch(/fraud|health score|excellent|\/100/i);
    }
  });
});

describe("AI payload privacy", () => {
  const capture = () => {
    const seen: { system: string; user: string }[] = [];
    const provider: AiProvider = {
      name: "mock",
      complete: async (req) => {
        seen.push({ system: req.system, user: req.user });
        return "Person 1 was paid 500 across 3 payments. Safe to spend is an estimate, not a guarantee.";
      },
    };
    return { provider, seen };
  };

  it("drops identifier keys and masks identifier-looking values", () => {
    const clean = sanitizeFacts({
      total: 500,
      merchant: "Blinkit",
      txnIds: ["a1", "b2"],
      id: "abc",
      upiId: "blinkit.rzp@hdfcbank",
      upiReference: "622758185216",
      referenceNumber: "0000127425097485",
      accountNumber: "50100123456789",
      refundFor: "zzz",
      description: "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY",
      note: "paid to blinkit.rzp@hdfcbank ref 622758185216 from 50100123456789, mail me@example.com, IFSC HDFC0MERUPI",
      items: [{ id: "x", name: "Netflix", amount: 649 }],
      paid: 12,
    });
    expect(clean).toEqual({ total: 500, merchant: "Blinkit", note: "paid to [upi id] ref [number] from [number], mail [email], IFSC [bank code]", items: [{ name: "Netflix", amount: 649 }], paid: 12 });
  });

  it("the provider receives only sanitised facts: no ids, UPI ids, references, account numbers, PDF text or passwords", async () => {
    const { provider, seen } = capture();
    const answer: Answer = {
      intent: "spend_merchant",
      text: "You spent ₹500 on Blinkit across 3 payments (UPI ref 622758185216).",
      facts: { total: 500, count: 3, merchant: "Blinkit", txnIds: ["txn-1", "txn-2"], upiId: "blinkit.rzp@hdfcbank", upiReference: "622758185216", accountNumber: "50100123456789", pdf: "%PDF-1.4 secret", password: "hunter2hunter2" },
    };
    const out = await narrate("What did I pay 50100123456789 to blinkit.rzp@hdfcbank?", answer, true, { provider });
    expect(out.usedLlm).toBe(true);
    const sent = seen[0].user;
    for (const forbidden of ["txn-1", "txn-2", "blinkit.rzp", "@hdfcbank", "622758185216", "50100123456789", "%PDF", "hunter2", "HDFC0MERUPI"]) expect(sent, forbidden).not.toContain(forbidden);
    expect(sent).toContain("Blinkit");
    expect(sent).toContain("500");
  });

  it("names of people the user paid are replaced by placeholders and restored only in the final answer", async () => {
    const { provider, seen } = capture();
    const answer: Answer = { intent: "spend_merchant", text: "You spent ₹500 on Rahul Negi across 3 payments.", facts: { total: 500, count: 3, merchant: "Rahul Negi" } };
    const out = await narrate("How much did I send Rahul Negi?", answer, true, { provider, redactNames: ["Rahul Negi"] });
    expect(seen[0].user).not.toMatch(/Rahul|Negi/);
    expect(seen[0].user).toContain("Person 1");
    expect(out.text).toContain("Rahul Negi");
    expect(out.text).not.toContain("Person 1");
  });

  it("a reply that invents a number falls back to the deterministic answer (the model is never the source of truth)", async () => {
    const provider: AiProvider = { name: "liar", complete: async () => "You spent ₹99,999 on Blinkit." };
    const answer: Answer = { intent: "spend_merchant", text: "You spent ₹500 on Blinkit.", facts: { total: 500 } };
    expect(await narrate("Blinkit?", answer, true, { provider })).toEqual({ text: answer.text, usedLlm: false });
    expect(await narrate("Blinkit?", answer, false, { provider })).toEqual({ text: answer.text, usedLlm: false }); // AI narration switched off
  });

  it("real answers never leak any transaction id, UPI id, UPI reference or bank reference from the database", () => {
    const questions = [
      "How much did I spend this month?", "Where did most of my money go?", "What was my largest transaction this month?", "What are my subscriptions?",
      "Compare this month with last month", "Why did my spending increase this month?", "Which categories increased the most?", "Show me unusual spending recently",
      "How much can I safely spend?", "What recurring payments are coming up in the next 30 days?",
    ];
    for (const [uid, today] of [[demo, TODAY], [real, AUG_END]] as const) {
      const secrets = new Set<string>();
      for (const r of db().prepare("SELECT id, upi_id, upi_reference, reference_number FROM transactions WHERE user_id = ?").all(uid) as { id: string; upi_id: string | null; upi_reference: string | null; reference_number: string | null }[]) {
        for (const v of [r.id, r.upi_id, r.upi_reference, r.reference_number]) if (v && v.length >= 6) secrets.add(v);
      }
      expect(secrets.size).toBeGreaterThan(0);
      for (const q of questions) {
        const a = ask(uid, q, today);
        const payload = buildAiPayload(q, a.facts, a.text, new Redactor([]));
        const blob = `${payload.question}\n${payload.facts}\n${payload.draft}`;
        for (const s of secrets) expect(blob, `${q} leaked ${s.slice(0, 6)}…`).not.toContain(s);
        expect(blob).not.toMatch(/\d{9,}/);
        expect(blob).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z]{2,}/);
      }
    }
  });

  it("the question itself is masked before it leaves", () => {
    const p = buildAiPayload("send to rahul@okhdfcbank acct 50100123456789", { total: 1 }, "ok", new Redactor([]));
    expect(p.question).toBe("send to [upi id] acct [number]");
    expect(maskSensitiveText("PDF %PDF-1.7 header")).not.toContain("%PDF");
  });
});
