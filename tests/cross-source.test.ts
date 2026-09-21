/**
 * Cross-source behaviour: HDFC + Google Pay for the same period. Pure matching rules first, then the whole pipeline on
 * a real (in-memory) database: matching, duplicate prevention, canonical events, analytics, the assistant, deletion,
 * privacy and user isolation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db/client";
import { createUser } from "../src/lib/services/users";
import { confirmImport, stageParsed, stageStatement, deleteStatement, listStatements } from "../src/lib/pipeline/import";
import { parseStatementPdf } from "../src/lib/parsers";
import { parseGooglePayPages } from "../src/lib/parsers/googlepay/parser";
import { normalizeGooglePay } from "../src/lib/parsers/googlepay/normalizer";
import { normalizeTransactions } from "../src/lib/parsers/hdfc/normalizer";
import { classifyTransaction } from "../src/lib/classification/classifier";
import { refineWithAi } from "../src/lib/classification/ai-classifier";
import { idKeys, matchAcrossSources, type ExistingRow, type IncomingRow } from "../src/lib/matching/cross-source";
import { getProvenance, loadMatchCandidates, resolveMatch } from "../src/lib/services/events";
import { loadAllTxns } from "../src/lib/services/data";
import { queryTransactions } from "../src/lib/services/transactions";
import { spendTotals } from "../src/lib/analytics/compare";
import { answerQuery } from "../src/lib/chat/answer";
import { parseQuestion } from "../src/lib/chat/intent";
import { narrate } from "../src/lib/chat/llm";
import { personNames } from "../src/lib/chat/service";
import { buildAiPayload, Redactor } from "../src/lib/chat/privacy";
import { generateRealHdfcPdf } from "../scripts/real-pdf";
import { pagesFromLayout, type GPayPdfRow } from "../scripts/gpay-pdf";
import type { AiProvider } from "../src/lib/ai/provider";
import type { ParsedStatement, ParsedTransaction } from "../src/lib/domain/types";
import { buildRealStatement } from "./real-fixture";
import { GPAY_OFFICIAL, GPAY_ROWS, type GPayRow } from "./gpay-fixture";

const REAL_PDF = "C:/Users/ADMIN/Downloads/gpay_statement_20260801_20260831.pdf";
const db = () => getDb();
let seq = 0;
const newUser = async (name = "Test Owner") => (await createUser({ email: `xs${++seq}@example.com`, name, password: "cross source password 1" })).id;

/* ------------------------------ builders ------------------------------ */

type IdMode = "both" | "ref" | "narration" | "none";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "user";
const flip = (id: string) => "9" + id.slice(1); // a different, but valid-looking, 12-digit number

/** An HDFC statement whose rows are the bank-side view of the given payments. */
function hdfcParsed(rows: GPayRow[], mode: IdMode = "both", extra: ParsedTransaction[] = []): { statement: ParsedStatement; normalized: ReturnType<typeof normalizeTransactions> } {
  let balance = 100000;
  const txns: ParsedTransaction[] = rows.map((r, i) => {
    const narrId = mode === "both" || mode === "narration" ? r.id : mode === "ref" ? flip(r.id) : "";
    const ref = mode === "both" || mode === "ref" ? "0000" + r.id : "0000" + flip(flip(r.id));
    const name = r.counterparty.toUpperCase();
    const narration = narrId ? `UPI-${name}-${slug(r.counterparty)}@okhdfcbank-HDFC0000001-${narrId}-UPI` : `UPI-${name}-${slug(r.counterparty)}@okhdfcbank-HDFC0000001-UPI`;
    balance = Math.round((balance + (r.direction === "credit" ? r.amount : -r.amount)) * 100) / 100;
    return { date: r.date, rawDescription: narration, narrationLines: [narration], reference: mode === "none" ? undefined : ref, debit: r.direction === "debit" ? r.amount : 0, credit: r.direction === "credit" ? r.amount : 0, balance, rowIndex: i, warnings: [] };
  });
  const all = [...txns, ...extra.map((e, i) => ({ ...e, rowIndex: txns.length + i }))];
  const dates = all.map((t) => t.date).sort();
  const statement: ParsedStatement = { bank: "HDFC", parserVersion: "test", account: { mask: "9332" }, period: { start: dates[0], end: dates[dates.length - 1] }, transactions: all, warnings: [] };
  return { statement, normalized: normalizeTransactions(all) };
}

const hdfcRow = (date: string, desc: string, amount: number, over: Partial<ParsedTransaction> = {}): ParsedTransaction => ({ date, rawDescription: desc, debit: amount, credit: 0, balance: 50000, rowIndex: 0, warnings: [], ...over });

function gpayParsed(rows: GPayRow[] | GPayPdfRow[], official?: { sent: number; received: number }, period?: { start: string; end: string }) {
  const sent = official?.sent ?? rows.filter((r) => r.direction === "debit").reduce((a, r) => a + r.amount, 0);
  const received = official?.received ?? rows.filter((r) => r.direction === "credit").reduce((a, r) => a + r.amount, 0);
  const statement = parseGooglePayPages(pagesFromLayout({ rows, sent: Math.round(sent * 100) / 100, received: Math.round(received * 100) / 100, periodStart: period?.start, periodEnd: period?.end }));
  return { statement, normalized: normalizeGooglePay(statement) };
}

const file = (name: string) => ({ name, size: 1000, sha: crypto.createHash("sha256").update(name + Math.random()).digest("hex") });
async function importHdfc(u: string, parsed: ReturnType<typeof hdfcParsed>, name = "hdfc.pdf") {
  const p = await stageParsed(u, file(name), parsed);
  return { preview: p, result: confirmImport(u, p.statementId, { acknowledgeReconciliation: true }) };
}
async function stageGpay(u: string, parsed: ReturnType<typeof gpayParsed>, name = "gpay.pdf") {
  return stageParsed(u, file(name), parsed);
}
async function importGpay(u: string, parsed: ReturnType<typeof gpayParsed>, name = "gpay.pdf") {
  const preview = await stageGpay(u, parsed, name);
  return { preview, result: confirmImport(u, preview.statementId, { acknowledgeReconciliation: true }) };
}
const spending = (u: string) => spendTotals(loadAllTxns(u)).net;
const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const gp = (id: string, over: Partial<GPayRow> = {}): GPayRow => ({ date: "2026-08-10", time: "10:15", direction: "debit", counterparty: "Blinkit", id, amount: 266, bank: "HDFC Bank", mask: "9332", ...over });

/* --------------------------------- pure matching --------------------------------- */

describe("cross-source matching rules (pure)", () => {
  const inc = (over: Partial<IncomingRow> = {}): IncomingRow => ({ index: 0, source: "GOOGLE_PAY", direction: "debit", amount: 266, date: "2026-08-15", ids: ["622758185216"], merchantKey: "BLINKIT", ...over });
  const ex = (over: Partial<ExistingRow> = {}): ExistingRow => ({ id: "h1", eventId: "h1", source: "HDFC", isPrimary: true, direction: "debit", amount: 266, date: "2026-08-15", ids: ["622758185216"], merchantKey: "BLINKIT", eventSources: ["HDFC"], ...over });

  it("normalises the ids banks and apps print (leading zeros, narration digits)", () => {
    expect(idKeys("0000127425097485")).toEqual(["127425097485"]);
    expect(idKeys("UPI-BLINKIT-B@HDFC-HDFC0X-622758185216-UPI", "12345")).toEqual(["622758185216"]);
    expect(idKeys(undefined, "", "123")).toEqual([]);
  });
  it("1. same UPI transaction id + direction + amount = matched with high confidence", () => {
    const m = matchAcrossSources([inc()], [ex()]).get(0)!;
    expect(m).toMatchObject({ status: "matched", method: "upi_id", existingId: "h1" });
    expect(m.confidence).toBeGreaterThanOrEqual(0.95);
  });
  it("2. same amount/date but a DIFFERENT UPI id = different events, even with the same merchant", () => {
    expect(matchAcrossSources([inc({ ids: ["111111111111"] })], [ex()]).size).toBe(0);
  });
  it("3. same date, amount and merchant with no ids anywhere: at most a potential match, never merged", () => {
    const m = matchAcrossSources([inc({ ids: [] })], [ex({ ids: [] })]).get(0)!;
    expect(m).toMatchObject({ status: "potential", method: "heuristic" });
    expect(m.confidence).toBeLessThan(0.9);
  });
  it("4. different amounts never match (by heuristic); the same id with a different amount is flagged, not merged", () => {
    expect(matchAcrossSources([inc({ ids: [], amount: 267 })], [ex({ ids: [] })]).size).toBe(0);
    expect(matchAcrossSources([inc({ amount: 267 })], [ex()]).get(0)).toMatchObject({ status: "potential", method: "upi_id" });
    expect(matchAcrossSources([inc({ direction: "credit" })], [ex()]).get(0)?.status).toBe("potential");
  });
  it("5. legitimate duplicates: two identical purchases match one-to-one by their own ids", () => {
    const m = matchAcrossSources([inc({ index: 0, ids: ["1"].map(() => "111111111111") }), inc({ index: 1, ids: ["222222222222"] })], [ex({ id: "a", eventId: "a", ids: ["111111111111"] }), ex({ id: "b", eventId: "b", ids: ["222222222222"] })]);
    expect([...m.values()].map((x) => [x.status, x.existingId])).toEqual([["matched", "a"], ["matched", "b"]]);
  });
  it("6. ambiguity is not resolved by guessing", () => {
    // two identical id-less existing rows, one incoming: which one? unknown
    expect(matchAcrossSources([inc({ ids: [] })], [ex({ id: "a", ids: [] }), ex({ id: "b", ids: [] })]).size).toBe(0);
    // one existing row, two identical incoming: same problem from the other side
    expect(matchAcrossSources([inc({ index: 0, ids: [] }), inc({ index: 1, ids: [] })], [ex({ ids: [] })]).size).toBe(0);
  });
  it("7. an existing row is claimed at most once, dates may differ by a day or two only, and an event never gets two rows of one source", () => {
    const m = matchAcrossSources([inc({ index: 0 }), inc({ index: 1 })], [ex()]);
    expect(m.size).toBe(1);
    expect(matchAcrossSources([inc({ date: "2026-08-17" })], [ex()]).get(0)?.confidence).toBe(0.95);
    expect(matchAcrossSources([inc({ date: "2026-08-25" })], [ex()]).get(0)?.status).toBe("potential"); // same id, 10 days apart
    expect(matchAcrossSources([inc()], [ex({ eventSources: ["HDFC", "GOOGLE_PAY"] })]).size).toBe(0);
    expect(matchAcrossSources([inc()], [ex({ separated: true })]).size).toBe(0);
  });
});

/* ---------------------------- full pipeline, real DB ---------------------------- */

describe("HDFC + Google Pay for the same period", () => {
  it("HDFC first, then Google Pay: every payment is matched by its UPI id and nothing is counted twice", async () => {
    const u = await newUser();
    await importHdfc(u, hdfcParsed(GPAY_ROWS, "both"));
    const before = { events: loadAllTxns(u).length, spend: spending(u) };
    expect(before.events).toBe(83);
    const p = await stageGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL, { start: GPAY_OFFICIAL.periodStart, end: GPAY_OFFICIAL.periodEnd }));
    expect(p).toMatchObject({ source: "GOOGLE_PAY", sourceLabel: "Google Pay", bank: "GOOGLE_PAY", period: { start: "2026-08-01", end: "2026-08-31" } });
    expect(p.counts).toMatchObject({ total: 83, debits: 76, credits: 7, matched: 83, potential: 0, newEvents: 0, duplicates: 0 });
    expect(p.providerTotals).toMatchObject({ sent: 12379.76, received: 5602, sentCalculated: 12379.76, receivedCalculated: 5602 });
    expect(p.reconciliation.status).toBe("reconciled");
    expect(p.requiresAcknowledgement).toBe(false);
    expect(p.overlap.statements).toHaveLength(1);
    expect(p.overlap.statements[0]).toMatchObject({ source: "HDFC", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    expect(p.overlap.existingInPeriod).toBe(83);
    expect(p.warnings.join(" ")).toMatch(/overlaps with an existing statement \(HDFC, 2026-08-01 to 2026-08-31\)/);
    expect(p.totals).toMatchObject({ newEventDebits: 0, newEventCredits: 0 });
    expect(p.transactions.every((r) => r.match?.status === "matched" && r.source === "GOOGLE_PAY" && !!r.time)).toBe(true);

    const r = confirmImport(u, p.statementId);
    expect(r).toMatchObject({ imported: 83, mergedWithOtherSource: 83 });
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ?", u)).toBe(166); // nothing destroyed
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND is_primary = 1", u)).toBe(83);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND source = 'GOOGLE_PAY' AND is_primary = 0 AND match_status = 'matched'", u)).toBe(83);
    expect(count("SELECT COUNT(*) n FROM (SELECT event_id FROM transactions WHERE user_id = ? GROUP BY event_id HAVING COUNT(*) = 2)", u)).toBe(83);
    expect(loadAllTxns(u)).toHaveLength(83);
    expect(spending(u)).toBe(before.spend); // analytics unchanged
    // the wallet time enriches the bank row; the list shows one row per event with both sources
    const list = queryTransactions(u, { pageSize: 200 });
    expect(list.total).toBe(83);
    expect(list.rows.every((x) => x.eventSources.join("+") === "GOOGLE_PAY+HDFC" && x.txnSource === "HDFC" && x.time)).toBe(true);
    expect(queryTransactions(u, { source: "GOOGLE_PAY", pageSize: 200 }).total).toBe(83);
    expect(queryTransactions(u, { source: "HDFC", pageSize: 200 }).total).toBe(83);
  }, 60_000);

  it("Google Pay first, then HDFC: the bank row becomes the counted row and the totals do not change", async () => {
    const u = await newUser();
    await importGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL));
    const gpayOnly = { events: loadAllTxns(u).length, spend: spending(u) };
    expect(gpayOnly.events).toBe(83);
    const { preview, result } = await importHdfc(u, hdfcParsed(GPAY_ROWS, "both"));
    expect(preview.counts).toMatchObject({ matched: 83, newEvents: 0 });
    expect(result.mergedWithOtherSource).toBe(83);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND is_primary = 1 AND source = 'HDFC'", u)).toBe(83);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND is_primary = 1 AND source = 'GOOGLE_PAY'", u)).toBe(0);
    expect(loadAllTxns(u)).toHaveLength(83);
    expect(spending(u)).toBe(gpayOnly.spend);
  }, 60_000);

  it("the id can be in the narration, in the Chq./Ref.No. column, or both", async () => {
    for (const mode of ["narration", "ref", "both"] as const) {
      const u = await newUser();
      await importHdfc(u, hdfcParsed(GPAY_ROWS.slice(0, 10), mode));
      const p = await stageGpay(u, gpayParsed(GPAY_ROWS.slice(0, 10)));
      expect(p.counts, mode).toMatchObject({ matched: 10, newEvents: 0 });
    }
  }, 60_000);

  it("partial overlap: matched rows are merged, genuinely new Google Pay rows are imported, HDFC-only rows stay", async () => {
    const u = await newUser();
    const onlyBank = [hdfcRow("2026-08-06", "ATW-ATM CASH-HDFC BANK-MG ROAD", 2000), hdfcRow("2026-08-07", "NEFT DR-HDFC0000240-ACME TRAVEL-REF", 1500, { balance: 40000 })];
    await importHdfc(u, hdfcParsed(GPAY_ROWS.slice(0, 40), "both", onlyBank));
    expect(loadAllTxns(u)).toHaveLength(42);
    const p = await stageGpay(u, gpayParsed(GPAY_ROWS));
    expect(p.counts).toMatchObject({ total: 83, matched: 40, newEvents: 43, potential: 0 });
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(u)).toHaveLength(42 + 43);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ?", u)).toBe(42 + 83);
    const newDebits = GPAY_ROWS.slice(40).filter((r) => r.direction === "debit").reduce((a, r) => a + r.amount, 0);
    expect(p.totals.newEventDebits).toBeCloseTo(newDebits, 2);
  }, 60_000);

  it("same amount and date but a different UPI transaction stays two separate spending events (₹266 + ₹266)", async () => {
    const u = await newUser();
    const blinkit266 = gp("622758185216");
    await importHdfc(u, hdfcParsed([{ ...blinkit266, id: "700000000001" }], "both"));
    const p = await stageGpay(u, gpayParsed([blinkit266]));
    expect(p.counts).toMatchObject({ matched: 0, potential: 0, newEvents: 1 });
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(u)).toHaveLength(2);
    expect(spending(u)).toBe(532);
  });

  it("two legitimate identical purchases (same merchant, amount and day) are matched one-to-one and stay two events", async () => {
    const u = await newUser();
    const two = [gp("300000000001", { counterparty: "Zepto", amount: 175, time: "22:45" }), gp("300000000002", { counterparty: "Zepto", amount: 175, time: "22:45" })];
    await importHdfc(u, hdfcParsed(two, "both"));
    const p = await stageGpay(u, gpayParsed(two));
    expect(p.counts).toMatchObject({ matched: 2, newEvents: 0 });
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(u)).toHaveLength(2);
    expect(spending(u)).toBe(350);
    // a third identical purchase that only exists in the wallet is a third event
    const u2 = await newUser();
    await importHdfc(u2, hdfcParsed(two, "both"));
    const three = [...two, gp("300000000003", { counterparty: "Zepto", amount: 175, time: "22:46" })];
    const p2 = await stageGpay(u2, gpayParsed(three));
    expect(p2.counts).toMatchObject({ matched: 2, newEvents: 1 });
    confirmImport(u2, p2.statementId, { acknowledgeReconciliation: true });
    expect(spending(u2)).toBe(525);
  });

  it("same id but a different amount is flagged for review and BOTH are counted until a person decides", async () => {
    const u = await newUser();
    await importHdfc(u, hdfcParsed([gp("400000000001", { amount: 267 })], "both"));
    const p = await stageGpay(u, gpayParsed([gp("400000000001", { amount: 266 })]));
    expect(p.counts).toMatchObject({ matched: 0, potential: 1, newEvents: 1 });
    expect(p.transactions[0].match).toMatchObject({ status: "potential", method: "upi_id" });
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(u)).toHaveLength(2);
    expect(queryTransactions(u, { matchStatus: "potential" }).total).toBe(2);
  });

  it("no id on the bank side: a unique look-alike is a potential match; merge or keep separate is the user's decision", async () => {
    const mk = async () => {
      const u = await newUser();
      await importHdfc(u, hdfcParsed([], "both", [hdfcRow("2026-08-10", "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-UPI", 266)]));
      const p = await stageGpay(u, gpayParsed([gp("500000000001")]));
      expect(p.counts).toMatchObject({ matched: 0, potential: 1, newEvents: 1 });
      confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
      return u;
    };
    const merge = await mk();
    expect(spending(merge)).toBe(532); // not merged automatically
    const potentialRow = db().prepare("SELECT id FROM transactions WHERE user_id = ? AND source = 'GOOGLE_PAY'").get(merge) as { id: string };
    const prov = getProvenance(merge, potentialRow.id)!;
    expect(prov.potential).toMatchObject({ source: "HDFC", amount: 266 });
    resolveMatch(merge, potentialRow.id, "merge");
    expect(spending(merge)).toBe(266);
    expect(loadAllTxns(merge)).toHaveLength(1);
    const merged = getProvenance(merge, potentialRow.id)!;
    expect(merged.members.map((m) => [m.sourceLabel, m.isPrimary])).toEqual([["HDFC", true], ["Google Pay", false]]);
    expect(merged.sources).toEqual(["HDFC", "Google Pay"]);

    const keep = await mk();
    const g = db().prepare("SELECT id FROM transactions WHERE user_id = ? AND source = 'GOOGLE_PAY'").get(keep) as { id: string };
    resolveMatch(keep, g.id, "separate");
    expect(spending(keep)).toBe(532);
    expect(queryTransactions(keep, { matchStatus: "potential" }).total).toBe(0);
    // and a later Google Pay import never re-proposes the pair the user rejected
    const p2 = await stageGpay(keep, gpayParsed([gp("500000000002")]));
    expect(p2.counts.potential).toBe(0);
  });

  it("ambiguous look-alikes are left alone (nothing is guessed)", async () => {
    const u = await newUser();
    const twin = hdfcRow("2026-08-10", "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-UPI", 266);
    await importHdfc(u, hdfcParsed([], "both", [twin, { ...twin, rowIndex: 1 }]));
    const p = await stageGpay(u, gpayParsed([gp("500000000009")]));
    expect(p.counts).toMatchObject({ matched: 0, potential: 0, newEvents: 1 });
  });
});

describe("importing the same or overlapping Google Pay statements", () => {
  it("the same statement again adds nothing and is reported as already imported", async () => {
    const u = await newUser();
    const first = await importGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL), "same.pdf");
    expect(first.result.imported).toBe(83);
    const again = await stageGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL), "same-again.pdf");
    expect(again.counts).toMatchObject({ duplicates: 83, new: 0, matched: 0 });
    expect(again.overlap.statements).toHaveLength(1);
    const r = confirmImport(u, again.statementId);
    expect(r.imported).toBe(0);
    expect(loadAllTxns(u)).toHaveLength(83);
  });
  it("overlapping date ranges import only the rows that are new", async () => {
    const u = await newUser();
    const first = GPAY_ROWS.filter((r) => r.date <= "2026-08-20");
    const second = GPAY_ROWS.filter((r) => r.date >= "2026-08-15");
    await importGpay(u, gpayParsed(first));
    const p = await stageGpay(u, gpayParsed(second));
    const overlapCount = GPAY_ROWS.filter((r) => r.date >= "2026-08-15" && r.date <= "2026-08-20").length;
    expect(p.counts.duplicates).toBe(overlapCount);
    expect(p.counts.new).toBe(second.length - overlapCount);
    expect(p.warnings.join(" ")).toMatch(/overlaps/);
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(u)).toHaveLength(83);
  });
});

describe("refunds, people and self transfers", () => {
  it("a Google Pay refund is a refund (not income): linked to its purchase and netted", async () => {
    const u = await newUser();
    const rows = [gp("600000000001"), gp("600000000002", { direction: "credit", time: "10:40" })];
    await importGpay(u, gpayParsed(rows));
    const refund = db().prepare("SELECT * FROM transactions WHERE user_id = ? AND direction = 'credit'").get(u) as any;
    const purchase = db().prepare("SELECT * FROM transactions WHERE user_id = ? AND direction = 'debit'").get(u) as any;
    expect(refund).toMatchObject({ category: "REFUNDS", is_refund: 1, refund_reference: purchase.id });
    expect(refund.semantic_type).toBeNull();
    expect(spending(u)).toBe(0); // 266 - 266
    expect(spendTotals(loadAllTxns(u)).income).toBe(0);
  });
  it("a refund that cannot be tied to a purchase is flagged REFUND_REQUIRES_REVIEW, never guessed", async () => {
    const u = await newUser();
    await importGpay(u, gpayParsed([gp("600000000010", { direction: "credit", amount: 100 })]));
    const r = db().prepare("SELECT category, is_refund, refund_reference, semantic_type FROM transactions WHERE user_id = ?").get(u) as any;
    expect(r).toMatchObject({ category: "REFUNDS", is_refund: 1, refund_reference: null, semantic_type: "REFUND_REQUIRES_REVIEW" });
  });
  it("a refund that appears in both sources is one refund", async () => {
    const u = await newUser();
    const rows = [gp("600000000021"), gp("600000000022", { direction: "credit", time: "10:40" })];
    await importHdfc(u, hdfcParsed(rows, "both"));
    const p = await stageGpay(u, gpayParsed(rows));
    expect(p.counts.matched).toBe(2);
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(u).filter((t) => t.direction === "credit")).toHaveLength(1);
    expect(spending(u)).toBe(0);
  });
  it("person-to-person payments are neither spending nor income, and wait for the user's classification", async () => {
    const u = await newUser();
    const rows = [gp("610000000001", { counterparty: "Rahul Negi", amount: 625 }), gp("610000000002", { counterparty: "DivyeshDiptanshu", direction: "credit", amount: 1220 }), gp("610000000005", { counterparty: "Shivansh Bansal", direction: "credit", amount: 88 }), gp("610000000003", { counterparty: "Aditya", amount: 175 }), gp("610000000004", { counterparty: "Zepto", amount: 84 })];
    await importGpay(u, gpayParsed(rows));
    const q = (name: string) => queryTransactions(u, { q: name }).rows[0];
    expect(q("Rahul Negi")).toMatchObject({ category: "TRANSFERS", semanticType: "PERSON_TO_PERSON", needsReview: true });
    expect(q("Shivansh Bansal")).toMatchObject({ category: "TRANSFERS", semanticType: "PERSON_TO_PERSON", needsReview: true });
    // one run-together word: person or business? The app says it cannot tell, and does not call it income
    expect(q("DivyeshDiptanshu")).toMatchObject({ semanticType: "UNKNOWN_COUNTERPARTY", needsReview: true });
    expect(q("Aditya")).toMatchObject({ semanticType: "UNKNOWN_COUNTERPARTY", needsReview: true });
    expect(["FOOD", "SHOPPING", "GROCERIES"]).not.toContain(q("Aditya").category);
    expect(q("Zepto")).toMatchObject({ category: "GROCERIES", needsReview: false });
    const t = spendTotals(loadAllTxns(u));
    expect(t.income).toBe(0);
    expect(t.net).toBe(175 + 84); // the person-to-person rows are not spending; the unknown single-word payee is, pending review
    // the user can classify a person; that is remembered
    const rahul = q("Rahul Negi");
    expect(queryTransactions(u, { lowConfidence: true }).rows.map((x) => x.id)).toContain(rahul.id);
  });
  it("a self transfer (proved by the account holder's own name) is excluded from spending and income but stays visible", async () => {
    const u = await newUser("Shrey Kumar Jain");
    const rows = [gp("620000000001", { counterparty: "Shrey Kumar Jain", amount: 5000 }), gp("620000000002", { counterparty: "Zepto", amount: 84 })];
    const p = await stageGpay(u, gpayParsed(rows, { sent: 84, received: 0 })); // Google Pay leaves the self transfer out of Sent
    expect(p.reconciliation.status).toBe("reconciled");
    expect(p.reconciliation.providerTotals).toMatchObject({ sent: 84, sentCalculated: 84, excludedSelfTransfers: 5000 });
    confirmImport(u, p.statementId);
    const self = queryTransactions(u, { q: "Shrey" }).rows[0];
    expect(self).toMatchObject({ semanticType: "SELF_TRANSFER", category: "TRANSFERS", subcategory: "Self Transfer", needsReview: false });
    expect(spending(u)).toBe(84);
    expect(spendTotals(loadAllTxns(u)).income).toBe(0);
    expect(queryTransactions(u, {}).total).toBe(2); // still in the history
  });
  it("a possible (unproven) self transfer is never excluded automatically: the statement asks for review", async () => {
    const u = await newUser("Shrey Kumar Jain");
    const rows = [gp("620000000011", { counterparty: "Shrey Sharma", amount: 5000 }), gp("620000000012", { counterparty: "Zepto", amount: 84 })];
    const p = await stageGpay(u, gpayParsed(rows, { sent: 84, received: 0 }));
    expect(p.reconciliation.status).toBe("requires_review");
    expect(p.requiresAcknowledgement).toBe(true);
    expect(p.reconciliation.status).not.toBe("reconciled");
    expect(() => confirmImport(u, p.statementId)).toThrowError(/only reconciles if some transactions are transfers/);
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(queryTransactions(u, { q: "Shrey Sharma" }).rows[0]).toMatchObject({ semanticType: "POSSIBLE_SELF_TRANSFER", needsReview: true });
  });
  it("a Sent total that nothing explains is a plain mismatch and needs acknowledgement", async () => {
    const u = await newUser();
    const p = await stageGpay(u, gpayParsed([gp("620000000021", { counterparty: "Zepto", amount: 84 })], { sent: 99, received: 0 }));
    expect(p.reconciliation.status).toBe("mismatch");
    expect(p.requiresAcknowledgement).toBe(true);
    expect(() => confirmImport(u, p.statementId)).toThrowError(/does not reconcile/);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ?", u)).toBe(0); // nothing was imported
  });
});

describe("existing HDFC fixture + the real Google Pay rows", () => {
  it("matches only what is provably the same payment; nothing is double counted", async () => {
    const u = await newUser();
    const { rows, official } = buildRealStatement();
    const hp = await stageStatement(u, { name: "hdfc-aug.pdf", data: await generateRealHdfcPdf({ rows, official }) }, undefined);
    confirmImport(u, hp.statementId);
    const beforeEvents = loadAllTxns(u).length;
    const p = await stageGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL));
    // Rahul Negi ₹625 (id in the Chq./Ref.No. column, same day) is the same event; the fixture's ₹266 Blinkit has the same id but is dated
    // 12 days earlier than the wallet entry, so it is offered for review rather than merged. Everything else is unrelated.
    expect(p.counts.matched).toBe(1);
    expect(p.counts.potential).toBe(1);
    expect(p.counts.newEvents).toBe(82);
    const matched = p.transactions.find((r) => r.match?.status === "matched")!;
    expect(matched).toMatchObject({ debit: 625, date: "2026-08-01" });
    confirmImport(u, p.statementId, { acknowledgeReconciliation: true });
    expect(loadAllTxns(u)).toHaveLength(beforeEvents + 82);
    // the merged ₹625 is counted once
    expect(loadAllTxns(u).filter((t) => t.amount === 625 && t.direction === "debit" && t.date === "2026-08-01")).toHaveLength(1);
  }, 90_000);
});

describe("deleting a source", () => {
  it("deleting the HDFC statement promotes the Google Pay rows so no payment disappears; deleting Google Pay leaves HDFC intact", async () => {
    const u = await newUser();
    const h = await importHdfc(u, hdfcParsed(GPAY_ROWS, "both"), "bank.pdf");
    const g = await importGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL), "wallet.pdf");
    const spend = spending(u);
    expect(loadAllTxns(u)).toHaveLength(83);
    deleteStatement(u, h.result.statementId);
    expect(loadAllTxns(u)).toHaveLength(83);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND source = 'GOOGLE_PAY' AND is_primary = 1 AND match_status IS NULL", u)).toBe(83);
    expect(spending(u)).toBe(spend);
    // and back again
    const h2 = await importHdfc(u, hdfcParsed(GPAY_ROWS, "both"), "bank-again.pdf");
    expect(h2.preview.counts.matched).toBe(83);
    deleteStatement(u, g.result.statementId);
    expect(loadAllTxns(u)).toHaveLength(83);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND source = 'HDFC' AND is_primary = 1", u)).toBe(83);
    expect(spending(u)).toBe(spend);
    expect(listStatements(u).map((s) => s.source)).toEqual(["HDFC"]);
  }, 90_000);
});

describe("analytics and the assistant see each real event once", () => {
  it("Blinkit questions are answered from the canonical events (no doubled counts)", async () => {
    const u = await newUser();
    await importHdfc(u, hdfcParsed(GPAY_ROWS, "both"));
    await importGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL));
    const blinkit = GPAY_ROWS.filter((r) => /blinkit/i.test(r.counterparty) && r.direction === "debit");
    const expected = blinkit.reduce((a, r) => a + r.amount, 0);
    expect(blinkit).toHaveLength(5);
    const merchants = [...new Set(loadAllTxns(u).map((t) => t.merchant))];
    const a = answerQuery(u, parseQuestion("How much did I spend on Blinkit in August?", { today: "2026-09-21", monthStartDay: 1, merchants }), "2026-09-21");
    expect(a.intent).toBe("spend_merchant");
    expect(a.facts).toMatchObject({ merchant: "Blinkit", total: expected, count: 5 });
    const total = answerQuery(u, parseQuestion("How much did I spend in August?", { today: "2026-09-21", monthStartDay: 1, merchants }), "2026-09-21");
    // person-to-person rows are transfers, not spending; the rest is what both statements agree on
    const hdfcOnly = await newUser();
    await importHdfc(hdfcOnly, hdfcParsed(GPAY_ROWS, "both"));
    expect(total.facts.spending).toBe(spending(hdfcOnly));
    // category view is not doubled either
    const sums = db().prepare("SELECT ROUND(SUM(debit),2) s FROM transactions WHERE user_id = ? AND is_primary = 1 AND direction = 'debit' AND category NOT IN ('TRANSFERS','INVESTMENTS')").get(u) as { s: number };
    expect(sums.s).toBe(total.facts.grossSpending);
  }, 90_000);
});

describe("privacy", () => {
  const capture = () => {
    const seen: string[] = [];
    const provider: AiProvider = { name: "mock", complete: async (req) => (seen.push(req.system + "\n" + req.user), "[]") };
    return { provider, seen };
  };

  it("the AI classifier never sees ids, banks, amounts, dates or anyone who may be a person", async () => {
    const n = normalizeGooglePay(parseGooglePayPages(pagesFromLayout({ rows: GPAY_ROWS, sent: GPAY_OFFICIAL.sent, received: GPAY_OFFICIAL.received }))).transactions;
    const rows = n.map((t) => ({ ...t, ...classifyTransaction(t) }));
    const { provider, seen } = capture();
    await refineWithAi(rows, provider);
    const sent = seen.join("\n");
    for (const forbidden of [...GPAY_ROWS.map((r) => r.id), "9332", "HDFC Bank", "2026-08", "Note:", "Google Account", "Rahul", "Negi", "ADITYA", "Aditya", "DEVANSH", "Kiddo", "JABIR", "statement.owner"]) expect(sent, forbidden).not.toContain(forbidden);
    expect(sent).not.toMatch(/\d{6,}/);
  });

  it("assistant payloads carry no UPI ids, funding accounts or personal names from either source", async () => {
    const u = await newUser();
    await importHdfc(u, hdfcParsed(GPAY_ROWS, "both"));
    await importGpay(u, gpayParsed(GPAY_ROWS, GPAY_OFFICIAL));
    const names = personNames(u);
    expect(names).toEqual(expect.arrayContaining(["Rahul Negi", "Aditya"]));
    const { provider, seen } = capture();
    const merchants = [...new Set(loadAllTxns(u).map((t) => t.merchant))];
    for (const q of ["How much did I spend in August?", "What was my largest transaction in August?", "Where did most of my money go in August?", "Show me unusual spending in August"]) {
      const a = answerQuery(u, parseQuestion(q, { today: "2026-09-21", monthStartDay: 1, merchants }), "2026-09-21");
      const payload = buildAiPayload(q, a.facts, a.text, new Redactor(names));
      const blob = `${payload.question}\n${payload.facts}\n${payload.draft}`;
      for (const forbidden of [...GPAY_ROWS.map((r) => r.id), "9332", "Rahul Negi", "NEKKALAPU"]) expect(blob, `${q}: ${forbidden}`).not.toContain(forbidden);
      await narrate(q, a, true, { provider, redactNames: names });
    }
    const sent = seen.join("\n");
    for (const forbidden of [...GPAY_ROWS.map((r) => r.id), "9332", "Rahul", "Negi"]) expect(sent).not.toContain(forbidden);
  }, 90_000);
});

describe("isolation, safety and HDFC compatibility", () => {
  it("another user's rows are never match candidates and their events are invisible", async () => {
    const a = await newUser();
    const b = await newUser();
    await importHdfc(a, hdfcParsed(GPAY_ROWS.slice(0, 5), "both"));
    const p = await stageGpay(b, gpayParsed(GPAY_ROWS.slice(0, 5)));
    expect(p.counts).toMatchObject({ matched: 0, newEvents: 5 });
    expect(loadMatchCandidates(b, "GOOGLE_PAY", "2026-08-01", "2026-08-31")).toEqual([]);
    expect(p.overlap.statements).toEqual([]);
    const someone = db().prepare("SELECT id FROM transactions WHERE user_id = ? LIMIT 1").get(a) as { id: string };
    expect(getProvenance(b, someone.id)).toBeNull();
    expect(resolveMatch(b, someone.id, "merge")).toEqual({ ok: true, action: "nothing-to-resolve" });
  });

  it("existing HDFC data is untouched: source HDFC, its own event, counted", async () => {
    const u = await newUser();
    const { rows, official } = buildRealStatement();
    const p = await stageStatement(u, { name: "h.pdf", data: await generateRealHdfcPdf({ rows, official }) }, undefined);
    expect(p).toMatchObject({ source: "HDFC", sourceLabel: "HDFC" });
    expect(p.counts).toMatchObject({ total: 84, debits: 76, credits: 8, matched: 0, potential: 0 });
    expect(p.reconciliation.status).toBe("reconciled");
    confirmImport(u, p.statementId);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ? AND source = 'HDFC' AND is_primary = 1 AND event_id = id AND match_status IS NULL", u)).toBe(84);
  }, 60_000);

  it("unsupported, corrupt or wrong-password uploads fail cleanly and write nothing", async () => {
    const u = await newUser();
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
    doc.text("Not a bank statement").end();
    const before = count("SELECT COUNT(*) n FROM statements WHERE user_id = ?", u);
    await expect(stageStatement(u, { name: "x.pdf", data: new Uint8Array(await done) }, undefined)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await expect(stageStatement(u, { name: "x.pdf", data: new Uint8Array(Buffer.from("%PDF-1.4 truncated garbage")) }, undefined)).rejects.toBeTruthy();
    await expect(stageStatement(u, { name: "x.txt", data: new Uint8Array(Buffer.from("hello")) }, undefined)).rejects.toMatchObject({ code: "INVALID_PDF" });
    expect(count("SELECT COUNT(*) n FROM statements WHERE user_id = ?", u)).toBe(before);
    expect(count("SELECT COUNT(*) n FROM transactions WHERE user_id = ?", u)).toBe(0);
  });
});

describe.skipIf(!fs.existsSync(REAL_PDF))("the real Google Pay PDF through the real upload path", () => {
  it("stages, matches against a bank statement built from the same ids, and imports without double counting", async () => {
    const u = await newUser();
    await importHdfc(u, hdfcParsed(GPAY_ROWS, "both"));
    const before = spending(u);
    const p = await stageStatement(u, { name: "gpay_statement_20260801_20260831.pdf", data: new Uint8Array(fs.readFileSync(REAL_PDF)) }, undefined);
    expect(p).toMatchObject({ source: "GOOGLE_PAY", period: { start: "2026-08-01", end: "2026-08-31" } });
    expect(p.counts).toMatchObject({ total: 83, matched: 83, newEvents: 0 });
    expect(p.providerTotals).toMatchObject({ sent: 12379.76, received: 5602, sentCalculated: 12379.76, receivedCalculated: 5602 });
    expect(p.reconciliation.status).toBe("reconciled");
    confirmImport(u, p.statementId);
    expect(spending(u)).toBe(before);
    expect(loadAllTxns(u)).toHaveLength(83);
    const parsed = await parseStatementPdf(new Uint8Array(fs.readFileSync(REAL_PDF)));
    expect(parsed.parserId).toBe("googlepay");
  }, 90_000);
});
