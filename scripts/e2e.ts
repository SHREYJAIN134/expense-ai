/**
 * End-to-end smoke test against a RUNNING server (dev or `next start`).
 *   BASE_URL=http://localhost:3111 npx tsx scripts/e2e.ts
 * Uses a scratch account and synthetic PDFs only. Run it against a throwaway
 * DATABASE_URL (it registers the first user), never against your real data.
 */
import { generateSyntheticTransactions } from "../src/lib/demo/synthetic";
import { generateSamplePdf } from "./sample-pdf";
import { generateRealHdfcPdf } from "./real-pdf";
import { buildRealStatement } from "../tests/real-fixture";
import { findRupeeFont, generateGooglePayPdf } from "./gpay-pdf";
import { GPAY_OFFICIAL, GPAY_ROWS } from "../tests/gpay-fixture";

const BASE = process.env.BASE_URL ?? "http://localhost:3111";
let cookie = "";
let failures = 0;

function ok(cond: unknown, label: string, extra?: unknown) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✘ ${label}`, extra ?? "");
  }
}

async function call(path: string, init: RequestInit & { json?: unknown; raw?: boolean; noCookie?: boolean } = {}) {
  const headers: Record<string, string> = { origin: BASE, ...(init.headers as Record<string, string> | undefined) };
  if (cookie && !init.noCookie) headers.cookie = cookie;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set && /eai_session=/.test(set)) cookie = set.split(";")[0];
  return res;
}
const json = async (path: string, init: Parameters<typeof call>[1] = {}) => {
  const res = await call(path, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, res };
};

async function upload(pdf: Buffer, name: string, password?: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(pdf)], name, { type: "application/pdf" }));
  if (password) form.append("password", password);
  const res = await call("/api/statements/upload", { method: "POST", body: form });
  const text = await res.text();
  const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, events, contentType: res.headers.get("content-type") };
}

async function main() {
  console.log(`E2E against ${BASE}`);

  console.log("\n[auth & protection]");
  let r = await call("/now", { noCookie: true });
  ok(r.status === 307 || r.status === 308 || r.status === 302, "unauthenticated page request redirects", r.status);
  ok((r.headers.get("location") ?? "").includes("/login"), "…to /login");
  r = await call("/api/transactions", { noCookie: true });
  ok(r.status === 401, "API rejects unauthenticated requests", r.status);
  r = await call("/api/auth/status", { noCookie: true });
  ok((await r.json()).hasUsers === false, "fresh database has no users (first-run setup)");
  r = await call("/api/auth/register", { method: "POST", json: { name: "E2E", email: "e2e@example.com", password: "short" } });
  ok(r.status === 400, "weak password rejected");
  r = await call("/api/auth/register", { method: "POST", headers: { origin: "http://evil.example" }, json: { name: "E2E", email: "e2e@example.com", password: "a-good-password-1" } });
  ok(r.status === 403, "cross-origin POST blocked (CSRF)", r.status);
  let j = await json("/api/auth/register", { method: "POST", json: { name: "E2E User", email: "e2e@example.com", password: "a-good-password-1" } });
  ok(j.status === 200 && cookie.startsWith("eai_session="), "registers first user and sets session cookie");
  ok(/HttpOnly/i.test(j.res.headers.get("set-cookie") ?? "") && /SameSite=lax/i.test(j.res.headers.get("set-cookie") ?? ""), "cookie is HttpOnly + SameSite=Lax");
  j = await json("/api/auth/register", { method: "POST", json: { name: "Second", email: "two@example.com", password: "a-good-password-1" } });
  ok(j.status === 403, "second sign-up is closed (single-user app)");
  const goodCookie = cookie;
  await call("/api/auth/logout", { method: "POST" });
  r = await call("/api/auth/me");
  ok(r.status === 401, "logout invalidates the session server-side");
  cookie = goodCookie;
  r = await call("/api/auth/me");
  ok(r.status === 401, "the old cookie no longer works after logout");
  j = await json("/api/auth/login", { method: "POST", json: { email: "e2e@example.com", password: "wrong-password-x" } });
  ok(j.status === 401 && j.body.error.code === "INVALID_CREDENTIALS", "wrong password rejected");
  j = await json("/api/auth/login", { method: "POST", json: { email: "e2e@example.com", password: "a-good-password-1" } });
  ok(j.status === 200, "login works");
  r = await call("/api/auth/me");
  ok(r.status === 200, "session valid after login");
  r = await call("/login");
  ok(r.status === 307 || r.status === 200, "login page reachable");
  const sec = (await call("/login")).headers;
  ok(!!sec.get("content-security-policy") && sec.get("x-frame-options") === "DENY" && sec.get("x-content-type-options") === "nosniff", "security headers present (CSP, X-Frame-Options, nosniff)");
  ok((await call("/api/statements")).headers.get("cache-control")?.includes("no-store") === true, "API responses are no-store");

  console.log("\n[statement upload: validation & errors]");
  let u = await upload(Buffer.from("not a pdf at all"), "fake.pdf");
  ok(u.events.at(-1)?.type === "error" && u.events.at(-1)?.error.code === "INVALID_PDF", "non-PDF content rejected", u.events);
  const form = new FormData();
  form.append("file", new File([new Uint8Array(Buffer.from("x"))], "notes.txt", { type: "text/plain" }));
  r = await call("/api/statements/upload", { method: "POST", body: form });
  ok(r.status === 415, "wrong file type rejected (415)", r.status);
  r = await call("/api/statements/upload", { method: "POST", json: {} });
  ok(r.status === 400, "non-multipart request rejected");

  console.log("\n[statement upload: protected PDF → preview → import]");
  const opening = 60000;
  const may = generateSyntheticTransactions({ start: "2026-05-01", end: "2026-05-31", seed: 5, openingBalance: opening });
  const pw = "e2e-pdf-pass!";
  const pdf = await generateSamplePdf({ transactions: may, openingBalance: opening, periodStart: "2026-05-01", periodEnd: "2026-05-31", password: pw });
  u = await upload(pdf, "may.pdf");
  ok(u.events.at(-1)?.error?.code === "PASSWORD_REQUIRED", "reports password required");
  u = await upload(pdf, "may.pdf", "totally-wrong");
  ok(u.events.at(-1)?.error?.code === "INCORRECT_PASSWORD", "reports incorrect password");
  ok(!JSON.stringify(u.events).includes("totally-wrong"), "password is never echoed back");
  u = await upload(pdf, "may.pdf", pw);
  ok(/ndjson/.test(u.contentType ?? ""), "progress is streamed as NDJSON");
  const stages = u.events.filter((e) => e.type === "progress").map((e) => e.stage);
  ok(["decrypt", "parse", "validate", "duplicates", "classify", "preview"].every((s) => stages.includes(s)), "reports every processing stage", stages);
  const preview = u.events.find((e) => e.type === "preview")?.preview;
  ok(preview?.counts.total === may.length && preview.counts.new === may.length, `previews all ${may.length} transactions as new`, preview?.counts);
  ok(JSON.stringify(u.events).indexOf(pw) === -1, "password not present in any response");
  ok(preview.warnings.length === 0, "totals reconcile with the statement summary", preview.warnings);
  j = await json("/api/transactions");
  ok(j.body.total === 0, "nothing is stored before confirmation");
  j = await json("/api/statements/process", { method: "POST", json: { statementId: preview.statementId } });
  ok(j.status === 200 && j.body.imported === may.length, "confirm imports all transactions", j.body);

  console.log("\n[duplicates & retention]");
  u = await upload(pdf, "may-again.pdf", pw);
  const p2 = u.events.find((e) => e.type === "preview")?.preview;
  ok(p2.counts.duplicates === may.length && p2.counts.new === 0 && p2.duplicateStatement, "re-upload is detected as a duplicate statement");
  const june = generateSyntheticTransactions({ start: "2026-06-01", end: "2026-06-30", seed: 6, openingBalance: may.at(-1)!.balance });
  const pdf2 = await generateSamplePdf({ transactions: june, openingBalance: may.at(-1)!.balance, periodStart: "2026-06-01", periodEnd: "2026-06-30" });
  u = await upload(pdf2, "june.pdf");
  const p3 = u.events.find((e) => e.type === "preview")?.preview;
  j = await json("/api/statements/process", { method: "POST", json: { statementId: p3.statementId } });
  ok(j.body.imported === june.length, "second month imported");
  j = await json("/api/statements");
  ok(j.body.statements.filter((s: any) => s.status === "imported").length === 2, "both statements remain in history");
  j = await json("/api/analytics/monthly");
  ok(j.body.points.length === 2, "analytics cover both months", j.body.points.map((p: any) => p.key));

  console.log("\n[analytics APIs]");
  for (const p of ["overview", "daily", "weekly", "monthly", "quarterly", "yearly", "categories", "merchants", "patterns", "cashflow"]) {
    const res = await json(`/api/analytics/${p}`);
    ok(res.status === 200, `GET /api/analytics/${p}`, res.status);
  }
  j = await json("/api/analytics/overview");
  const ov = j.body;
  ok(ov.summary.transactionCount === may.length + june.length, "overview counts every transaction");
  ok(ov.balance?.balance === june.at(-1)!.balance, "current balance equals the latest statement balance");
  ok(ov.categories.length > 3 && ov.merchants.length > 3, "categories and merchants populated");
  ok(Math.abs(ov.summary.totalDebits - [...may, ...june].reduce((a, t) => a + t.debit, 0)) < 0.01, "total debits match the source data");
  j = await json("/api/analytics/overview?category=FOOD");
  ok(j.body.summary.transactionCount < ov.summary.transactionCount && j.body.summary.transactionCount > 0, "category filter narrows results");

  console.log("\n[transactions explorer]");
  j = await json("/api/transactions?pageSize=10&sort=amount&dir=desc");
  ok(j.body.rows.length === 10 && j.body.rows[0].amount >= j.body.rows[9].amount, "sort + paginate");
  j = await json("/api/transactions?q=swiggy&direction=debit");
  ok(j.body.total > 0 && j.body.rows.every((x: any) => /swiggy/i.test(x.description + x.merchant)), "search + debit filter");
  const swiggy = j.body.rows[0];
  j = await json(`/api/transactions/${swiggy.id}`, { method: "PATCH", json: { category: "GROCERIES", subcategory: "Online Grocery", notes: "e2e note" } });
  ok(j.status === 200 && j.body.updated > 1, "PATCH re-categorises and applies to the merchant", j.body.updated);
  j = await json(`/api/transactions/${swiggy.id}`);
  ok(j.body.transaction.category === "GROCERIES" && j.body.transaction.notes === "e2e note" && j.body.transaction.source === "user", "correction persisted with user provenance");
  j = await json(`/api/transactions/${swiggy.id}`, { method: "PATCH", json: { category: "NOPE" } });
  ok(j.status === 400, "invalid category rejected");
  j = await json("/api/transactions?q=%27%3B%20DROP%20TABLE%20transactions%3B--");
  ok(j.status === 200 && j.body.total === 0, "SQL injection attempt is inert");
  r = await call("/api/export/transactions?category=GROCERIES");
  const csv = await r.text();
  ok(r.status === 200 && csv.includes("Date,Value Date") && csv.split("\r\n").length > 3, "CSV export honours filters");

  console.log("\n[planning: recurring, budgets, forecast, insights]");
  j = await json("/api/recurring");
  ok(Array.isArray(j.body.detected) && Array.isArray(j.body.manual), "recurring endpoint returns detected + manual lists", j.body.detected.length);
  j = await json("/api/recurring", { method: "POST", json: { name: "Rent", amount: 25000, frequency: "monthly", dueDay: 1, category: "RENT" } });
  ok(j.status === 200 && j.body.id, "manual recurring obligation added");
  j = await json("/api/upcoming?days=45");
  ok(j.status === 200 && j.body.items.some((i: any) => i.name === "Rent"), "upcoming payments include the manual obligation");
  j = await json("/api/budgets", { method: "POST", json: { category: "FOOD", amount: 5000 } });
  ok(j.status === 200, "budget created");
  j = await json("/api/budgets");
  ok(j.body.status[0]?.category === "FOOD" && typeof j.body.status[0].projected === "number", "budget variance computed");
  j = await json("/api/forecast?days=30&planned=10000");
  ok(j.status === 200 && j.body.assumptions.length >= 3 && j.body.expectedRemaining !== null, "forecast returns estimate with assumptions");
  j = await json("/api/insights");
  ok(Array.isArray(j.body.insights) && j.body.insights.length > 0, "insights generated");

  console.log("\n[assistant]");
  j = await json("/api/chat", { method: "POST", json: { message: "How much did I spend on food in June?" } });
  ok(j.status === 200 && j.body.message.content.includes("₹"), "answers a spending question with real numbers", j.body?.message?.content?.slice(0, 80));
  const sid = j.body.sessionId;
  j = await json("/api/chat", { method: "POST", json: { message: "What are my recurring expenses?", sessionId: sid } });
  ok(j.body.intent === "recurring_list", "understands recurring-expense question");
  j = await json("/api/chat", { method: "POST", json: { message: "What is the meaning of life?", sessionId: sid } });
  ok(j.body.intent === "unknown" && /can answer questions/i.test(j.body.message.content), "declines gracefully instead of inventing an answer");
  j = await json(`/api/chat/sessions/${sid}`);
  ok(j.body.messages.length === 6, "chat history persisted", j.body.messages?.length);

  console.log("\n[settings & data lifecycle]");
  j = await json("/api/settings");
  ok(j.body.settings.currency === "INR" && j.body.ai && !JSON.stringify(j.body).includes("AI_API_KEY"), "settings readable; no secrets exposed");
  j = await json("/api/settings/delete-data", { method: "POST", json: { password: "a-good-password-1", confirm: "delete my data" } });
  ok(j.status === 400, "destructive action needs the exact confirmation phrase");
  j = await json("/api/settings/delete-data", { method: "POST", json: { password: "wrong-password", confirm: "DELETE MY DATA" } });
  ok(j.status === 403, "destructive action needs the correct password");
  r = await call("/api/export/all");
  const all = await r.json();
  ok(all.transactions.length >= may.length + june.length && !JSON.stringify(all).includes("password_hash"), "full export contains data but no password hash");
  console.log("\n[real HDFC structure: reconciliation, refunds, gating]");
  const real = buildRealStatement();
  const realPdf = await generateRealHdfcPdf({ ...real, password: pw });
  u = await upload(realPdf, "aug-real-structure.pdf", pw);
  const rp = u.events.find((e) => e.type === "preview")?.preview;
  ok(rp?.counts.total === 84 && rp.counts.debits === 76 && rp.counts.credits === 8, "reconstructs 84 transactions (76 debits / 8 credits) from a multi-page PDF", rp?.counts);
  ok(rp?.reconciliation.status === "reconciled" && rp.requiresAcknowledgement === false, "reconciles with the official STATEMENT SUMMARY", rp?.reconciliation?.issues);
  ok(rp?.openingBalance === 29004.97 && rp?.closingBalance === 22493.21 && rp?.calculatedClosingBalance === 22493.21, "opening 29,004.97 / closing 22,493.21 / calculated closing match");
  ok(rp?.counts.refunds === 1 && rp?.counts.autopay === 2, "flags 1 refund and 2 AUTOPAY rows");
  ok(stages.length > 0 && u.events.some((e) => e.type === "progress" && e.stage === "reconcile"), "streams a reconcile stage");
  j = await json("/api/statements/process", { method: "POST", json: { statementId: rp.statementId } });
  ok(j.status === 200 && j.body.imported === 84 && j.body.refundsLinked === 1, "imports the statement and links the refund", j.body);
  j = await json("/api/transactions?q=BLINKIT.RZP&pageSize=50");
  const refundRow = j.body.rows.find((x: any) => x.isRefund);
  ok(refundRow && refundRow.refundReference && j.body.rows.some((x: any) => x.id === refundRow.refundReference), "refund credit is linked to the original Blinkit debit");
  ok(j.body.rows.every((x: any) => x.paymentProvider === "Razorpay" && x.merchant === "Blinkit"), "provider (Razorpay) kept separate from merchant (Blinkit)");
  const tampered = real.rows.map((r, i) => ({ ...r, reference: "0000" + String(710000000000 + i) }));
  u = await upload(await generateRealHdfcPdf({ rows: tampered, official: { ...real.official, totalDebits: real.official.totalDebits + 1 } }), "aug-tampered.pdf");
  const tp = u.events.find((e) => e.type === "preview")?.preview;
  ok(tp?.reconciliation.status === "mismatch" && tp.requiresAcknowledgement === true, "a statement that does not reconcile requires acknowledgement");
  j = await json("/api/statements/process", { method: "POST", json: { statementId: tp.statementId } });
  ok(j.status === 409 && j.body.error.code === "RECONCILIATION_FAILED", "import is blocked without acknowledgement", j.status);
  j = await json("/api/statements/process", { method: "POST", json: { statementId: tp.statementId, acknowledgeReconciliation: true } });
  ok(j.status === 200 && j.body.imported === 84, "import proceeds after explicit acknowledgement");
  j = await json("/api/analytics/overview?basis=value");
  ok(j.status === 200 && j.body.summary.transactionCount > 84, "value-date basis is accepted by the analytics API");
  j = await json("/api/transactions?lowConfidence=1&pageSize=5");
  ok(j.status === 200 && j.body.total > 0, "needs-review filter returns flagged transactions");

  console.log("\n[financial intelligence]");
  const intelUrls = ["/api/intelligence/snapshot", "/api/intelligence/insights", "/api/intelligence/anomalies", "/api/intelligence/spending", "/api/intelligence/projection", "/api/intelligence/safe-to-spend"];
  for (const url of intelUrls) {
    const r = await call(url, { noCookie: true });
    ok(r.status === 401, `${url} requires a session`, r.status);
  }
  j = await json("/api/intelligence/snapshot?period=month");
  ok(j.status === 200 && j.body.snapshot && "spending" in j.body.snapshot && "discretionary" in j.body.snapshot, "snapshot returns the required sections", j.status);
  ok(!/score|grade|excellent/i.test(JSON.stringify(j.body)), "snapshot has no health score or grade");
  ok(j.body.snapshot.balance?.amount === 22493.21, "snapshot balance is the statement's closing balance", j.body.snapshot.balance);
  j = await json("/api/intelligence/safe-to-spend");
  ok(j.status === 200 && j.body.disclaimer === "Safe to spend is an estimate, not a guarantee." && Array.isArray(j.body.components), "safe-to-spend exposes every component and the disclaimer", j.status);
  j = await json("/api/intelligence/projection");
  ok(j.status === 200 && j.body.horizons.length === 3 && /estimates/i.test(j.body.disclaimer), "projection covers 7/14/30 days and is labelled as an estimate");
  j = await json("/api/intelligence/insights");
  ok(j.status === 200 && Array.isArray(j.body.insights) && j.body.insights.every((i: any) => i.calculation && i.title), "insights carry titles and the calculation behind them");
  j = await json("/api/intelligence/anomalies?days=90");
  ok(j.status === 200 && Array.isArray(j.body.anomalies) && !/fraud/i.test(JSON.stringify(j.body)), "anomalies use unusual-activity wording");
  j = await json("/api/intelligence/spending?period=quarter");
  ok(j.status === 200 && j.body.periods.unit === "quarter" && j.body.categories.length > 0, "spending intelligence supports quarterly comparison");
  j = await json("/api/settings", { method: "PATCH", json: { safetyBuffer: 1500, changeMinPct: 30 } });
  ok(j.status === 200 && j.body.settings.safetyBuffer === 1500 && j.body.settings.changeMinPct === 30, "intelligence settings can be changed");
  j = await json("/api/settings", { method: "PATCH", json: { changeMinPct: 0 } });
  ok(j.status === 400, "invalid intelligence settings are rejected", j.status);
  j = await json("/api/intelligence/safe-to-spend");
  ok(j.body.bufferSource === "user" && j.body.safetyBuffer === 1500, "safe-to-spend uses the buffer the user set");
  j = await json("/api/settings", { method: "PATCH", json: { safetyBuffer: null, changeMinPct: 25 } });
  ok(j.status === 200 && j.body.settings.safetyBuffer === null, "buffer can be reset to automatic");
  j = await json("/api/chat", { method: "POST", json: { message: "Why did my spending increase this month?" } });
  ok(j.status === 200 && j.body.intent === "why_spending_changed" && j.body.message.calculation?.length > 0, "assistant answers 'why did my spending change' with its calculation", j.body?.intent);

  console.log("\n[Google Pay: second source, cross-source matching]");
  if (!findRupeeFont()) {
    console.log("  (skipped: no system font with the rupee sign to render the synthetic Google Pay PDF)");
  } else {
    const gpayPdf = await generateGooglePayPdf({ rows: GPAY_ROWS, sent: GPAY_OFFICIAL.sent, received: GPAY_OFFICIAL.received });
    const before = (await json("/api/transactions?pageSize=1")).body.total as number;
    const eventsBefore = (await json("/api/analytics/overview")).body.summary.transactionCount as number;
    u = await upload(gpayPdf, "gpay_statement_20260801_20260831.pdf");
    const gp = u.events.find((e: any) => e.type === "preview")?.preview;
    ok(u.status === 200 && gp?.source === "GOOGLE_PAY" && gp.sourceLabel === "Google Pay", "a Google Pay PDF is detected automatically (no format choice)", gp?.source);
    ok(gp?.counts.total === 83 && gp.counts.debits === 76 && gp.counts.credits === 7, "reads 83 transactions (76 paid, 7 received)", gp?.counts);
    ok(gp?.providerTotals?.sent === 12379.76 && gp.providerTotals.received === 5602 && gp.providerTotals.sentCalculated === 12379.76 && gp.providerTotals.receivedCalculated === 5602, "Sent and Received are reconciled from the statement", gp?.providerTotals);
    ok(gp?.reconciliation.status === "reconciled" && gp.requiresAcknowledgement === false, "reconciliation is reported as reconciled");
    ok(gp?.period?.start === "2026-08-01" && gp.period.end === "2026-08-31", "statement period is extracted");
    ok(gp?.overlap.statements.length >= 1 && gp.warnings.some((w: string) => /overlaps/i.test(w)), "overlap with the existing HDFC statement is reported", gp?.overlap);
    ok(gp?.counts.matched === 1 && gp.counts.potential === 1 && gp.counts.newEvents === 82, "only provably identical payments match (1 by UPI id, 1 left for review)", gp?.counts);
    j = await json("/api/statements/process", { method: "POST", json: { statementId: gp.statementId } });
    ok(j.status === 200 && j.body.imported === 83 && j.body.mergedWithOtherSource === 1, "imports; the matched payment is stored once as a corroborating copy", j.body);
    j = await json("/api/transactions?pageSize=1");
    ok(j.body.total === before + 82, "the transaction list grows by the 82 new events only (no double counting)", [before, j.body.total]);
    j = await json("/api/transactions?source=GOOGLE_PAY&pageSize=200");
    ok(j.body.total === 83 - 0 && j.body.rows.every((x: any) => x.eventSources.includes("GOOGLE_PAY")), "source filter returns every event that appears in Google Pay", j.body.total);
    const both = j.body.rows.find((x: any) => x.eventSources.length === 2);
    ok(both && both.txnSource === "HDFC", "a payment in both sources is listed once, as an HDFC + Google Pay event");
    j = await json(`/api/transactions/${both.id}/provenance`);
    ok(j.status === 200 && j.body.members.length === 2 && j.body.members.filter((m: any) => m.isPrimary).length === 1, "provenance shows both statement rows, one counted");
    j = await json("/api/transactions?matchStatus=potential&pageSize=10");
    ok(j.body.total === 2, "the possible duplicate is listed for a decision", j.body.total);
    j = await json(`/api/transactions/${j.body.rows[0].id}/match`, { method: "POST", json: { action: "separate" } });
    ok(j.status === 200, "a possible duplicate can be resolved");
    j = await json("/api/transactions?matchStatus=potential&pageSize=10");
    ok(j.body.total === 0, "resolved matches disappear from the review list");
    j = await json("/api/analytics/overview");
    ok(j.body.summary.transactionCount === eventsBefore + 82, "analytics count 82 new events, not 83", [eventsBefore, j.body.summary.transactionCount]);
    j = await json("/api/statements");
    ok(j.body.statements.some((x: any) => x.source === "GOOGLE_PAY"), "the statement history lists the Google Pay source");
    u = await upload(gpayPdf, "gpay-again.pdf");
    const again = u.events.find((e: any) => e.type === "preview")?.preview;
    ok(again?.counts.duplicates === 83 && again.counts.new === 0, "uploading the same Google Pay statement again adds nothing", again?.counts);
    j = await json("/api/statements/process", { method: "POST", json: { statementId: again.statementId } });
    ok(j.status === 200 && j.body.imported === 0, "…and importing it is a no-op");
    const junk = await upload(Buffer.from("%PDF-1.4\n%garbage"), "junk.pdf");
    ok(junk.events.some((e: any) => e.type === "error"), "a corrupt PDF is rejected with an error, nothing imported");
  }

  console.log("\n[assistant: transaction lists vs balance vs spending]");
  {
    const ask = async (message: string, sessionId?: string) => (await json("/api/chat", { method: "POST", json: { message, sessionId } })).body;
    const bal = await ask("what is my balance?");
    ok(bal.intent === "balance" && /latest known balance/.test(bal.message.content), "'what is my balance?' still answers with the balance", bal.intent);
    const list = await ask("list all the transaction on 24th of august", bal.sessionId);
    ok(list.intent === "transaction_list", "the reported bug: it is a transaction list, even right after a balance question", list.intent);
    ok(/Found \*\*\d+ transactions?\*\* on 24 Aug 2026\./.test(list.message.content) && !/latest known balance/.test(list.message.content), "it lists 24 Aug 2026 and does not answer with the balance", list.message.content.slice(0, 120));
    ok(/Zepto — ₹325 — Debit — Groceries/.test(list.message.content), "it contains the real transactions from the database (Zepto ₹325, Debit, Groceries)");
    const spend = await ask("how much did I spend on 24 August 2026?");
    ok(spend.intent === "spend_total" && /On 24 Aug 2026 you spent/.test(spend.message.content), "'how much did I spend on 24 August 2026?' is a spending summary for that day", spend.intent);
    const hist = await ask("what was my balance on August 24?");
    ok(hist.intent === "historical_balance", "'what was my balance on August 24?' is a historical balance", hist.intent);
    const none = await ask("show all transactions on 3 March 2026");
    ok(/No transactions were found for 3 Mar 2026\./.test(none.message.content), "an empty day says so instead of answering with the balance");
    const bad = await ask("show transactions on August 35");
    ok(/couldn't read that date/.test(bad.message.content), "an impossible date is reported, not reinterpreted");
  }

  j = await json("/api/settings/delete-data", { method: "POST", json: { password: "a-good-password-1", confirm: "DELETE MY DATA" } });
  ok(j.status === 200, "delete-all-data succeeds");
  j = await json("/api/transactions");
  ok(j.body.total === 0, "all financial data removed");
  j = await json("/api/auth/me");
  ok(j.status === 200, "login survives data deletion");

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll end-to-end checks passed ✔");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(2);
});
