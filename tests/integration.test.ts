/**
 * Integration tests against a real (in-memory) SQLite database: import pipeline,
 * duplicate handling, retention, learning, demo data, chat retrieval, auth primitives.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db/client";
import { createUser, getSettings, updateSettings } from "../src/lib/services/users";
import { confirmImport, deleteStatement, discardStatement, listStatements, stageStatement } from "../src/lib/pipeline/import";
import { generateSyntheticTransactions } from "../src/lib/demo/synthetic";
import { generateSamplePdf } from "../scripts/sample-pdf";
import { queryTransactions, updateTransaction, exportTransactions } from "../src/lib/services/transactions";
import { loadAllTxns, currentBalance, dataRange } from "../src/lib/services/data";
import { hasDemoData, loadDemoData, removeDemoData } from "../src/lib/services/demo";
import { calculateMonthlySpend, calculateSummary } from "../src/lib/analytics/engine";
import { chatTurn, getSession, listSessions } from "../src/lib/chat/service";
import { numbersAreGrounded } from "../src/lib/chat/llm";
import { parseQuestion } from "../src/lib/chat/intent";
import { resolvePeriod } from "../src/lib/chat/period";
import { createSession, destroySession, hashToken, validateSessionToken } from "../src/lib/auth/session";
import { checkPasswordStrength, verifyPassword } from "../src/lib/auth/password";
import { rateLimit } from "../src/lib/auth/ratelimit";
import { ApiError, assertSameOrigin } from "../src/lib/auth/guard";
import { createRecurring, getBudgetStatus, getForecast, getUpcoming, upsertBudget, listBudgets, computeInsights } from "../src/lib/services/planning";
import { buildClassifierContext } from "../src/lib/pipeline/import";
import { classifyTransaction } from "../src/lib/classification/classifier";
import { normalizeTransactions } from "../src/lib/parsers/hdfc/normalizer";

const TODAY = "2026-09-21";
const PASSWORD = "Sup3r-secret-PDF-pw";
let userId = "";
let otherUserId = "";

const OPENING = 60000;
const full = generateSyntheticTransactions({ start: "2026-05-01", end: "2026-06-30", seed: 11, openingBalance: OPENING });
const may = full.filter((t) => t.date <= "2026-05-31");
const june = full.filter((t) => t.date >= "2026-06-01");
const overlap = full.filter((t) => t.date >= "2026-05-20" && t.date <= "2026-06-15");
const balBefore = (d: string) => full.filter((t) => t.date < d).at(-1)?.balance ?? OPENING;

async function pdf(rows: typeof full, start: string, end: string, password?: string) {
  return generateSamplePdf({ transactions: rows, openingBalance: balBefore(rows[0].date), periodStart: start, periodEnd: end, password });
}
const count = (sql: string, ...args: unknown[]) => (getDb().prepare(sql).get(...args) as { n: number }).n;

beforeAll(async () => {
  userId = (await createUser({ email: "me@example.com", name: "Test Owner", password: "correct horse battery" })).id;
  otherUserId = (await createUser({ email: "other@example.com", name: "Someone Else", password: "another long password" })).id;
});

describe("authentication primitives", () => {
  it("hashes passwords with bcrypt and verifies them", async () => {
    const row = getDb().prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.password_hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", row.password_hash)).toBe(true);
    expect(await verifyPassword("wrong", row.password_hash)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false); // unknown user path
  });
  it("enforces a password policy", () => {
    expect(checkPasswordStrength("short").ok).toBe(false);
    expect(checkPasswordStrength("aaaaaaaaaaaa").ok).toBe(false);
    expect(checkPasswordStrength("password123456").ok).toBe(false);
    expect(checkPasswordStrength("correct horse battery").ok).toBe(true);
  });
  it("stores only a keyed hash of the session token; expired/forged tokens are rejected", () => {
    const { token } = createSession(userId, "vitest");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(token)).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(hashToken(token))).toEqual({ n: 1 });
    expect(validateSessionToken(token)?.id).toBe(userId);
    expect(validateSessionToken(token + "x")).toBeNull();
    expect(validateSessionToken(undefined)).toBeNull();
    getDb().prepare("UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(hashToken(token));
    expect(validateSessionToken(token)).toBeNull();
    const t2 = createSession(userId).token;
    destroySession(t2);
    expect(validateSessionToken(t2)).toBeNull();
  });
  it("rate limits repeated attempts", () => {
    const key = "login:test-" + Math.random();
    for (let i = 0; i < 5; i++) expect(rateLimit(key, 5, 60_000).allowed).toBe(true);
    const blocked = rateLimit(key, 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(rateLimit(key, 5, 60_000, Date.now() + 61_000).allowed).toBe(true);
  });
  it("blocks cross-origin mutating requests (CSRF) but allows same-origin and safe methods", () => {
    const mk = (method: string, headers: Record<string, string>) => new NextRequest("http://localhost:3000/api/x", { method, headers: { host: "localhost:3000", ...headers } });
    expect(() => assertSameOrigin(mk("POST", { origin: "http://localhost:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(mk("GET", { origin: "http://evil.example" }))).not.toThrow();
    expect(() => assertSameOrigin(mk("POST", { origin: "http://evil.example" }))).toThrow(ApiError);
    expect(() => assertSameOrigin(mk("POST", { "sec-fetch-site": "cross-site" }))).toThrow(ApiError);
    expect(() => assertSameOrigin(mk("DELETE", { origin: "https://evil.example" }))).toThrow(ApiError);
  });
});

describe("statement import pipeline", () => {
  let previewId = "";

  it("stages a password-protected statement, then imports it atomically", async () => {
    const file = await pdf(may, "2026-05-01", "2026-05-31", PASSWORD);
    const stages: string[] = [];
    const preview = await stageStatement(userId, { name: "may.pdf", data: file }, PASSWORD, (s) => stages.push(s));
    previewId = preview.statementId;
    expect(stages).toEqual(expect.arrayContaining(["decrypt", "parse", "validate", "duplicates", "classify", "preview"]));
    expect(preview.counts).toMatchObject({ total: may.length, new: may.length, duplicates: 0 });
    expect(preview.warnings).toEqual([]);
    expect(preview.account.mask).toBe("6789");
    // nothing is in the transactions table until the user confirms
    expect(count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?", userId)).toBe(0);

    const res = confirmImport(userId, previewId);
    expect(res.imported).toBe(may.length);
    expect(count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?", userId)).toBe(may.length);
    expect(count("SELECT COUNT(*) AS n FROM transaction_classifications WHERE user_id = ?", userId)).toBe(may.length);
    expect(getDb().prepare("SELECT staged_json FROM statements WHERE id = ?").get(previewId)).toEqual({ staged_json: null });
    expect(() => confirmImport(userId, previewId)).toThrow(/already imported/i);
  });

  it("never persists the PDF password or the PDF bytes anywhere in the database", () => {
    const db = getDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
      expect(dump, `table ${t}`).not.toContain(PASSWORD);
      expect(dump, `table ${t}`).not.toContain("%PDF");
    }
  });

  it("keeps the raw narration and classifies with confidence + audit trail", () => {
    const row = getDb().prepare("SELECT * FROM transactions WHERE user_id = ? AND raw_description LIKE 'UPI-SWIGGY%' LIMIT 1").get(userId) as any;
    expect(row.raw_description.startsWith("UPI-SWIGGY-")).toBe(true);
    expect(row).toMatchObject({ merchant: "Swiggy", category: "FOOD", subcategory: "Food Delivery", payment_method: "UPI", transaction_type: "UPI" });
    expect(row.classification_confidence).toBeGreaterThanOrEqual(0.9);
    const hist = getDb().prepare("SELECT * FROM transaction_classifications WHERE transaction_id = ?").all(row.id) as any[];
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ method: "merchant", is_current: 1 });
  });

  it("detects duplicates on re-upload of the same statement and adds nothing", async () => {
    const file = await pdf(may, "2026-05-01", "2026-05-31");
    const preview = await stageStatement(userId, { name: "may-again.pdf", data: file }, undefined);
    expect(preview.counts).toMatchObject({ total: may.length, new: 0, duplicates: may.length });
    const res = confirmImport(userId, preview.statementId);
    expect(res).toMatchObject({ imported: 0, duplicatesSkipped: may.length });
    expect(count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?", userId)).toBe(may.length);
    expect(listStatements(userId).filter((s) => s.status === "imported")).toHaveLength(1); // empty re-upload is not kept
  });

  it("imports only the new rows of an overlapping statement", async () => {
    const preview = await stageStatement(userId, { name: "overlap.pdf", data: await pdf(overlap, "2026-05-20", "2026-06-15") }, undefined);
    const dupes = overlap.filter((t) => t.date <= "2026-05-31").length;
    expect(preview.counts.duplicates).toBe(dupes);
    expect(preview.counts.new).toBe(overlap.length - dupes);
    confirmImport(userId, preview.statementId);
    expect(count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?", userId)).toBe(may.length + (overlap.length - dupes));
  });

  it("retains earlier months when later statements are added (no overwriting)", async () => {
    const preview = await stageStatement(userId, { name: "june.pdf", data: await pdf(june, "2026-06-01", "2026-06-30") }, undefined);
    confirmImport(userId, preview.statementId);
    expect(count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?", userId)).toBe(full.length);
    const months = calculateMonthlySpend(loadAllTxns(userId)).map((m) => m.key);
    expect(months).toEqual(["2026-05", "2026-06"]);
    expect(dataRange(userId)).toMatchObject({ from: "2026-05-01", count: full.length });
    // balance tracks the most recent transaction
    expect(currentBalance(userId)?.balance).toBe(full.at(-1)!.balance);
    // and the imported set matches the source exactly
    const s = calculateSummary(loadAllTxns(userId));
    expect(s.totalDebits).toBeCloseTo(full.reduce((a, t) => a + t.debit, 0), 2);
    expect(s.totalCredits).toBeCloseTo(full.reduce((a, t) => a + t.credit, 0), 2);
  });

  it("isolates data between users", () => {
    expect(loadAllTxns(otherUserId)).toHaveLength(0);
    expect(queryTransactions(otherUserId, {}).total).toBe(0);
    const someId = loadAllTxns(userId)[0].id;
    expect(() => updateTransaction(otherUserId, someId, { notes: "hax" })).toThrow(ApiError);
    expect(exportTransactions(otherUserId, {})).toHaveLength(0);
  });

  it("rolls back the whole import if anything fails (no partial data)", async () => {
    const extra = generateSyntheticTransactions({ start: "2026-07-01", end: "2026-07-10", seed: 99, openingBalance: full.at(-1)!.balance });
    const preview = await stageStatement(userId, { name: "july.pdf", data: await generateSamplePdf({ transactions: extra, openingBalance: full.at(-1)!.balance, periodStart: "2026-07-01", periodEnd: "2026-07-10" }) }, undefined);
    const before = count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?", userId);
    const row = getDb().prepare("SELECT staged_json FROM statements WHERE id = ?").get(preview.statementId) as { staged_json: string };
    const staged = JSON.parse(row.staged_json);
    staged.transactions[extra.length - 1].direction = "sideways"; // violates CHECK constraint on the LAST row
    getDb().prepare("UPDATE statements SET staged_json = ? WHERE id = ?").run(JSON.stringify(staged), preview.statementId);
    expect(() => confirmImport(userId, preview.statementId)).toThrow(/rolled back/i);
    expect(count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?", userId)).toBe(before);
    expect(getDb().prepare("SELECT status FROM statements WHERE id = ?").get(preview.statementId)).toEqual({ status: "failed" });
  });

  it("supports discarding a preview and deleting an imported statement", async () => {
    const p = await stageStatement(userId, { name: "x.pdf", data: await pdf(june.slice(0, 5), "2026-06-01", "2026-06-05") }, undefined);
    discardStatement(userId, p.statementId);
    expect(() => discardStatement(userId, p.statementId)).toThrow(ApiError);
    const stmt = listStatements(userId).find((s) => s.filename === "june.pdf")!;
    deleteStatement(userId, stmt.id);
    expect(loadAllTxns(userId).some((t) => t.date >= "2026-06-16")).toBe(false);
    expect(loadAllTxns(userId).length).toBeGreaterThan(0);
  });

  it("returns typed errors for wrong / missing passwords without leaking them", async () => {
    const file = await pdf(may.slice(0, 3), "2026-05-01", "2026-05-03", PASSWORD);
    await expect(stageStatement(userId, { name: "p.pdf", data: file }, undefined)).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    const err = await stageStatement(userId, { name: "p.pdf", data: file }, "nope-nope").catch((e) => e);
    expect(err.code).toBe("INCORRECT_PASSWORD");
    expect(String(err.message)).not.toContain("nope-nope");
  });
});

describe("transaction editing and learning", () => {
  it("lets the user correct category/merchant/notes and learns the correction", async () => {
    const row = getDb().prepare("SELECT id, merchant FROM transactions WHERE user_id = ? AND merchant = 'Swiggy' LIMIT 1").get(userId) as { id: string; merchant: string };
    const swiggyCount = count("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND merchant = 'Swiggy'", userId);
    expect(swiggyCount).toBeGreaterThan(2);
    const res = updateTransaction(userId, row.id, { category: "GROCERIES", subcategory: "Online Grocery", notes: "Actually groceries" });
    expect(res.updated).toBe(swiggyCount); // applied to all of this merchant's transactions
    const t = res.transaction!;
    expect(t).toMatchObject({ category: "GROCERIES", notes: "Actually groceries", source: "user", userEdited: true });
    expect(t.confidence).toBeGreaterThanOrEqual(0.99);
    expect(t.classificationHistory.length).toBeGreaterThanOrEqual(2);
    // The lesson is applied to future imports
    const ctx = buildClassifierContext(userId);
    const n = normalizeTransactions([{ date: "2026-08-01", rawDescription: "UPI-SWIGGY-SWIGGY@YBL-YESB0YBLUPI-499999999999-ORDER", debit: 100, credit: 0, rowIndex: 0, warnings: [] }]).transactions[0];
    expect(classifyTransaction(n, ctx)).toMatchObject({ category: "GROCERIES", method: "user" });
  });
  it("rejects invalid categories", () => {
    const id = loadAllTxns(userId)[0].id;
    expect(() => updateTransaction(userId, id, { category: "NOPE" })).toThrow(/Unknown category/);
    expect(() => updateTransaction(userId, id, { category: "FOOD", subcategory: "Nope" })).toThrow(/subcategory/);
  });
  it("searches, filters, sorts and paginates safely (SQL-injection-proof)", () => {
    const all = queryTransactions(userId, { pageSize: 10 });
    expect(all.rows).toHaveLength(10);
    expect(all.pages).toBeGreaterThan(1);
    expect(queryTransactions(userId, { q: "zomato", direction: "debit" }).rows.every((r) => /zomato/i.test(r.description + r.merchant))).toBe(true);
    const big = queryTransactions(userId, { minAmount: 10000, sort: "amount", dir: "desc" });
    expect(big.rows[0].amount).toBeGreaterThanOrEqual(big.rows.at(-1)!.amount);
    const evil = queryTransactions(userId, { q: "'; DROP TABLE transactions; --" });
    expect(evil.total).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM transactions")).toBeGreaterThan(0);
    expect(queryTransactions(userId, { q: "%" }).total).toBe(0); // LIKE wildcards are escaped
  });
});

describe("demo data + planning services + assistant", () => {
  let demoUser = "";
  beforeAll(async () => {
    demoUser = (await createUser({ email: "demo@example.com", name: "Demo Owner", password: "demo owner password" })).id;
    const res = await loadDemoData(demoUser, TODAY);
    expect(res.statements).toBeGreaterThanOrEqual(8);
    expect(res.transactions).toBeGreaterThan(300);
  }, 60_000);

  const sql = (q: string, ...a: unknown[]) => getDb().prepare(q).get(...a) as any;
  const ask = (msg: string, sessionId?: string) => chatTurn(demoUser, { message: msg, sessionId }, TODAY);

  it("flags demo data as demo and can remove it without touching real data", async () => {
    expect(hasDemoData(demoUser)).toBe(true);
    expect(sql("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND is_demo = 0", demoUser).n).toBe(0);
    expect(listStatements(demoUser).every((s) => s.isDemo && /^DEMO-/.test(s.filename))).toBe(true);
    const tmp = (await createUser({ email: "tmp@example.com", name: "Tmp", password: "temporary password 1" })).id;
    await loadDemoData(tmp, TODAY);
    removeDemoData(tmp);
    expect(loadAllTxns(tmp)).toHaveLength(0);
    expect(hasDemoData(tmp)).toBe(false);
  });

  it("spans several months and calculates analytics dynamically from the DB", () => {
    const months = calculateMonthlySpend(loadAllTxns(demoUser));
    expect(months.length).toBeGreaterThanOrEqual(8);
    expect(months[1].income).toBe(95000);
    expect(months.every((m) => m.spending > 0)).toBe(true);
  });

  it("detects the demo user's recurring payments and computes upcoming bills", () => {
    const up = getUpcoming(demoUser, 45, TODAY);
    const names = up.items.map((i) => i.name);
    expect(names.join(",")).toMatch(/Rajesh Sharma/);
    expect(names).toEqual(expect.arrayContaining(["Netflix"]));
    expect(up.items.every((i) => i.date >= TODAY)).toBe(true);
  });

  it("manual recurring obligations feed the forecast; forecasts are labelled estimates", () => {
    const before = getForecast(demoUser, { days: 30, asOf: TODAY });
    createRecurring(demoUser, { name: "Insurance premium", amount: 7000, frequency: "monthly", dueDay: 25, category: "BILLS" });
    const after = getForecast(demoUser, { days: 30, asOf: TODAY });
    expect(after.expectedRecurring).toBeCloseTo(before.expectedRecurring + 7000, 1);
    expect(after.assumptions.join(" ")).toMatch(/estimate/i);
    expect(after.currentBalance).toBe(currentBalance(demoUser)!.balance);
  });

  it("budgets: actual vs limit with warnings", () => {
    upsertBudget(demoUser, { category: "FOOD", amount: 1000 });
    upsertBudget(demoUser, { category: "SHOPPING", amount: 500000 });
    expect(listBudgets(demoUser)).toHaveLength(2);
    const st = getBudgetStatus(demoUser, TODAY);
    const food = st.find((s) => s.category === "FOOD")!;
    expect(food.actual).toBeCloseTo(sql("SELECT SUM(debit) s FROM transactions WHERE user_id = ? AND category='FOOD' AND txn_date BETWEEN '2026-09-01' AND '2026-09-30'", demoUser).s ?? 0, 2);
    expect(["over", "projected_over"]).toContain(food.status);
    expect(st.find((s) => s.category === "SHOPPING")!.status).toBe("ok");
    expect(computeInsights(demoUser, TODAY).some((i) => i.kind === "budget")).toBe(true);
  });

  describe("assistant answers come from the database", () => {
    it("food spending last month equals the SQL total", async () => {
      const r = await ask("How much did I spend on food last month?");
      const expected = sql("SELECT ROUND(SUM(debit),2) s FROM transactions WHERE user_id = ? AND category='FOOD' AND txn_date BETWEEN '2026-08-01' AND '2026-08-31'", demoUser).s;
      expect(r.intent).toBe("spend_category");
      expect(r.message.content).toContain(expected.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
    });
    it("Swiggy this year equals the SQL total", async () => {
      const r = await ask("How much did I spend on Swiggy this year?");
      const expected = sql("SELECT ROUND(SUM(debit),2) s FROM transactions WHERE user_id = ? AND merchant='Swiggy' AND txn_date >= '2026-01-01'", demoUser).s;
      expect(r.intent).toBe("spend_merchant");
      expect(r.message.content).toContain(expected.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
    });
    it("money that came in last month", async () => {
      const r = await ask("How much money came into my account last month?");
      const expected = sql("SELECT ROUND(SUM(credit),2) s FROM transactions WHERE user_id = ? AND txn_date BETWEEN '2026-08-01' AND '2026-08-31'", demoUser).s;
      expect(r.intent).toBe("income_total");
      expect(r.message.content).toContain(expected.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
    });
    it("biggest expense this month (with the real merchant)", async () => {
      const r = await ask("What was my biggest expense this month?");
      const top = sql("SELECT merchant, debit FROM transactions WHERE user_id = ? AND direction='debit' AND category NOT IN ('TRANSFERS','INVESTMENTS') AND txn_date BETWEEN '2026-09-01' AND '2026-09-30' ORDER BY debit DESC LIMIT 1", demoUser);
      expect(r.message.content).toContain(top.merchant);
      expect(r.message.table?.rows[0][1]).toBe(top.merchant);
    });
    it("recurring expenses, upcoming payments and monthly average", async () => {
      const rec = await ask("What are my recurring expenses?");
      expect(rec.intent).toBe("recurring_list");
      expect(JSON.stringify(rec.message.table)).toMatch(/Netflix/);
      const up = await ask("What payments are coming up in the next 30 days?");
      expect(up.intent).toBe("upcoming_payments");
      expect(up.message.content).toMatch(/estimate/i);
      const avg = await ask("How much do I normally spend every month?");
      expect(avg.intent).toBe("monthly_average");
      expect(avg.message.content).toMatch(/₹/);
    });
    it("compares periods and reports where the money goes", async () => {
      const cmp = await ask("Compare my spending this month with last month");
      expect(cmp.intent).toBe("compare_periods");
      expect(cmp.message.content).toMatch(/versus/);
      expect((await ask("Where is most of my money going?")).intent).toBe("top_categories");
      expect((await ask("Did my spending increase this month?")).intent).toBe("spending_trend");
      expect((await ask("What are unusual transactions?")).intent).toBe("anomalies");
    });
    it("distinguishes balance / income / recurring / discretionary / remaining in forecasts", async () => {
      const safe = await ask("How much can I safely spend this month based on my historical cash flow?");
      expect(safe.intent).toBe("safe_to_spend");
      for (const label of ["Current balance", "Expected income", "Expected recurring expenses", "Estimated everyday spending", "Estimated remaining cash"]) {
        expect(safe.message.content).toContain(label);
      }
      expect(safe.message.content).toMatch(/estimates?, not guarantees/i);
      const afford = await ask("Can I afford ₹10,000 of discretionary spending based on my historical cash flow?");
      expect(afford.intent).toBe("afford");
      expect(afford.message.content).toMatch(/estimate/i);
      const remain = await ask("If I pay my rent and electricity bill, how much money will remain?");
      expect(remain.intent).toBe("remaining_after_bills");
      expect(remain.message.content).toContain("Current balance");
      expect(remain.message.content).toContain("Remaining after those bills");
      const cash = await ask("What is my estimated cash requirement for next month?");
      expect(cash.intent).toBe("cash_requirement");
      expect(cash.message.content).toMatch(/estimate/i);
    });
    it("says so when data is unavailable instead of inventing numbers", async () => {
      const r = await ask("How much did I spend on food in 2019?");
      expect(r.message.content).toMatch(/no|doesn't include/i);
      expect(r.message.content).toMatch(/covers/);
      const emptyUser = (await createUser({ email: "empty@example.com", name: "Empty", password: "an empty account pw" })).id;
      const e = await chatTurn(emptyUser, { message: "How much did I spend on food last month?" }, TODAY);
      expect(e.message.content).toMatch(/don't have any transactions/);
    });
    it("remembers conversation context for follow-ups but re-reads the database", async () => {
      const first = await ask("How much did I spend on food this month?");
      const follow = await ask("What about last month?", first.sessionId);
      expect(follow.understood).toMatchObject({ intent: "spend_category", category: "FOOD", followUp: true, period: "last month" });
      const session = getSession(demoUser, first.sessionId);
      expect(session.messages).toHaveLength(4);
      expect(listSessions(demoUser).some((s) => s.id === first.sessionId)).toBe(true);
      expect(() => getSession(otherUserId, first.sessionId)).toThrow(ApiError); // other users cannot read it
    });
  });
});

describe("assistant language handling", () => {
  it("resolves natural periods", () => {
    expect(resolvePeriod("last month", TODAY)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(resolvePeriod("this month", TODAY)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolvePeriod("in 2025", TODAY)).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
    expect(resolvePeriod("this year", TODAY)).toMatchObject({ from: "2026-01-01", to: TODAY });
    expect(resolvePeriod("in march", TODAY)).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(resolvePeriod("in november", TODAY)).toMatchObject({ from: "2025-11-01", to: "2025-11-30" });
    expect(resolvePeriod("last 30 days", TODAY)).toMatchObject({ from: "2026-08-23", to: TODAY });
    expect(resolvePeriod("next month", TODAY)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolvePeriod("hello", TODAY)).toBeNull();
  });
  it("classifies the questions from the spec", () => {
    const ctx = { today: TODAY, monthStartDay: 1, merchants: ["Swiggy", "Zomato"] };
    const intent = (q: string) => parseQuestion(q, ctx).intent;
    expect(intent("How much did I spend on entertainment in 2025?")).toBe("spend_category");
    expect(intent("What was my biggest expense this month?")).toBe("biggest_expense");
    expect(intent("What bills are expected in the next 30 days?")).toBe("upcoming_payments");
    expect(intent("what is the weather")).toBe("unknown");
    expect(parseQuestion("Can I afford ₹10,000 of discretionary spending", ctx).amount).toBe(10000);
    expect(parseQuestion("can I afford 25k", ctx).amount).toBe(25000);
    expect(parseQuestion("Swiggy spending in 2025", ctx)).toMatchObject({ merchant: "Swiggy", period: { from: "2025-01-01" } });
  });
  it("rejects LLM output containing numbers that are not in the facts", () => {
    const facts = { total: 12345.5, count: 7 };
    expect(numbersAreGrounded("You spent ₹12,345.50 across 7 payments.", facts, "")).toBe(true);
    expect(numbersAreGrounded("You spent ₹12,346 in total.", facts, "")).toBe(true); // rounding tolerance
    expect(numbersAreGrounded("You spent ₹99,999 in total.", facts, "")).toBe(false);
    expect(numbersAreGrounded("That is 42% of your income.", facts, "")).toBe(false);
  });
  it("respects user settings", () => {
    expect(getSettings(userId)).toMatchObject({ currency: "INR", monthStartDay: 1, aiClassification: true });
    expect(updateSettings(userId, { monthStartDay: 25 }).monthStartDay).toBe(25);
    updateSettings(userId, { monthStartDay: 1 });
  });
});
