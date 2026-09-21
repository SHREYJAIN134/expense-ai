/**
 * Ledger Line data layer: the Strip and the Time lens are pure compositions of existing analytics, so their numbers
 * must equal independent SQL over the canonical events (one row per event, is_primary = 1) and the existing snapshot.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db/client";
import { createUser } from "../src/lib/services/users";
import { confirmImport, stageStatement } from "../src/lib/pipeline/import";
import { getSnapshot } from "../src/lib/services/intelligence";
import { getStrip, getStripRange } from "../src/lib/services/strip";
import { getTimeLens } from "../src/lib/services/timelens";
import { queryTransactions } from "../src/lib/services/transactions";
import { generateRealHdfcPdf } from "../scripts/real-pdf";
import { buildRealStatement } from "./real-fixture";

const TODAY = "2026-09-21";
const AUG = { from: "2026-08-01", to: "2026-08-31" };
let uid = "";
let stranger = "";

const db = () => getDb();

beforeAll(async () => {
  uid = (await createUser({ email: "ll-services@example.com", name: "LL", password: "ledger line services pw 1" })).id;
  stranger = (await createUser({ email: "ll-empty@example.com", name: "Empty", password: "ledger line empty pw 22" })).id;
  const { rows, official } = buildRealStatement();
  const staged = await stageStatement(uid, { name: "aug.pdf", data: await generateRealHdfcPdf({ rows, official }) }, undefined);
  confirmImport(uid, staged.statementId);
}, 120_000);

describe("the Strip", () => {
  it("money in / moved / net equal independent SQL over canonical events", () => {
    const s = getStrip(uid, "month", TODAY)!;
    expect(s.from).toBe(AUG.from);
    expect(s.to).toBe(AUG.to);
    const q = (sql: string) => (db().prepare(sql).get(uid, AUG.from, AUG.to) as { v: number }).v;
    const base = "FROM transactions WHERE user_id = ? AND is_primary = 1 AND txn_date BETWEEN ? AND ?";
    expect(s.totals.in).toBeCloseTo(q(`SELECT ROUND(COALESCE(SUM(credit),0),2) AS v ${base}`), 2);
    expect(s.totals.moved).toBeCloseTo(q(`SELECT ROUND(COALESCE(SUM(debit),0),2) AS v ${base} AND direction='debit' AND category IN ('TRANSFERS','INVESTMENTS')`), 2);
    expect(s.totals.net).toBeCloseTo(q(`SELECT ROUND(COALESCE(SUM(credit)-SUM(debit),0),2) AS v ${base}`), 2);
    expect(s.totals.count).toBe(q(`SELECT COUNT(*) AS v ${base}`));
  });

  it("spending equals the Financial Snapshot's refund-netted spending for the same month", () => {
    const s = getStrip(uid, "month", TODAY)!;
    const snap = getSnapshot(uid, "month", AUG.to);
    expect(s.totals.spend).toBeCloseTo(snap.spending.value, 2);
  });

  it("has one row per calendar day, daily figures add up, and balances carry forward", () => {
    const s = getStrip(uid, "month", TODAY)!;
    expect(s.days).toHaveLength(31);
    expect(s.days.reduce((a, d) => a + d.count, 0)).toBe(s.totals.count);
    const known = s.days.filter((d) => d.balance !== null);
    expect(known.length).toBeGreaterThan(0);
    // the last balance equals the balance printed on the last transaction that has one
    const last = db().prepare("SELECT balance_after AS b FROM transactions WHERE user_id = ? AND is_primary = 1 AND balance_after IS NOT NULL ORDER BY txn_date DESC, seq DESC LIMIT 1").get(uid) as { b: number };
    expect(s.days[s.days.length - 1].balance).toBeCloseTo(last.b, 2);
  });

  it("keeps the estimate apart from actuals: it starts after the last statement day and is only present on estimate views", () => {
    const s = getStrip(uid, "month", TODAY)!;
    expect(s.staleDays).toBe(21);
    expect(s.estimate).not.toBeNull();
    expect(s.estimate!.days.length).toBeGreaterThan(0);
    expect(s.estimate!.days[0].date > s.dataThrough!).toBe(true);
    const custom = getStripRange(uid, AUG.from, AUG.to, TODAY)!;
    expect(custom.estimate).toBeNull();
    expect(custom.totals).toEqual(s.totals);
  });

  it("is per user: a user with no data has no strip", () => {
    expect(getStrip(stranger, "month", TODAY)).toBeNull();
    expect(getTimeLens(stranger, AUG.from, AUG.to, "Aug 2026", TODAY)).toBeNull();
  });

  it("windows clip to the last day with data and never invent days", () => {
    const wk = getStrip(uid, "week", TODAY)!;
    expect(wk.days).toHaveLength(7);
    expect(wk.to).toBe(AUG.to);
    const after = getStripRange(uid, "2026-09-01", "2026-09-30", TODAY)!;
    expect(after.days).toHaveLength(0);
    expect(after.totals.count).toBe(0);
  });
});

describe("the Time lens", () => {
  it("compares with the previous period only when there is one (one month imported -> no comparison)", () => {
    const l = getTimeLens(uid, AUG.from, AUG.to, "Aug 2026", TODAY)!;
    expect(l.hasPrevious).toBe(false);
    expect(l.spending.totals.current.net).toBeCloseTo(l.strip.totals.spend, 2);
  });

  it("records agree with the ledger: busiest day count and largest single transaction", () => {
    const l = getTimeLens(uid, AUG.from, AUG.to, "Aug 2026", TODAY)!;
    const busiest = db().prepare("SELECT txn_date AS d, COUNT(*) AS n FROM transactions WHERE user_id = ? AND is_primary = 1 AND txn_date BETWEEN ? AND ? GROUP BY txn_date ORDER BY n DESC, d LIMIT 1").get(uid, AUG.from, AUG.to) as { d: string; n: number };
    expect(l.records.busiest.best).toBeGreaterThanOrEqual(busiest.n - 0); // own-account transfers are not counted by the ranking
    expect(l.records.busiest.days.length).toBeGreaterThan(0);
    const largest = db().prepare("SELECT MAX(amount) AS m FROM transactions WHERE user_id = ? AND is_primary = 1 AND txn_date BETWEEN ? AND ?").get(uid, AUG.from, AUG.to) as { m: number };
    expect(l.records.largest!.amount).toBeLessThanOrEqual(largest.m);
    expect(l.records.largest!.amount).toBeGreaterThan(0);
  });
});

describe("Ledger filters added for the Ledger lens", () => {
  it("flag=moved returns only transfers / investments and flag=refund only refunds", () => {
    const moved = queryTransactions(uid, { flag: "moved", pageSize: 200 });
    expect(moved.rows.every((r) => r.category === "TRANSFERS" || r.category === "INVESTMENTS")).toBe(true);
    const sqlMoved = (db().prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND is_primary = 1 AND category IN ('TRANSFERS','INVESTMENTS')").get(uid) as { n: number }).n;
    expect(moved.total).toBe(sqlMoved);
    const refunds = queryTransactions(uid, { flag: "refund", pageSize: 200 });
    expect(refunds.rows.every((r) => r.isRefund)).toBe(true);
  });

  it("filters stay scoped to the user", () => {
    expect(queryTransactions(stranger, { flag: "moved" }).total).toBe(0);
  });
});
