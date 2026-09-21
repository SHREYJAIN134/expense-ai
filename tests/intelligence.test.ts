/**
 * V2 financial intelligence - pure analytics: comparable periods, refund-netted spending, category / merchant /
 * payment analysis, change detection, unusual-activity detection, recurring types, cash-flow projection,
 * safe-to-spend, snapshot and insights. Every expectation below is hand-checkable from the fixtures.
 */
import { describe, expect, it } from "vitest";
import type { TxnLite } from "../src/lib/domain/types";
import { addDays, addMonths } from "../src/lib/util/dates";
import {
  analyzeRanges,
  analyzeSpending,
  categoryStats,
  comparablePeriods,
  compareGroups,
  merchantStats,
  paymentMethodStats,
  periodsFromRange,
  spendTotals,
  spendingSeries,
  DEFAULT_THRESHOLDS,
  type GroupStat,
} from "../src/lib/analytics/compare";
import { detectUnusualActivity, robustZ } from "../src/lib/analytics/anomalies";
import { detectRecurringExpenses } from "../src/lib/analytics/recurring";
import { calculateBudgetVariance, type ManualObligation } from "../src/lib/analytics/planning";
import { computeSafeToSpend, projectCashFlow, SAFE_TO_SPEND_DISCLAIMER } from "../src/lib/analytics/projection";
import { buildSnapshot, generateIntelInsights } from "../src/lib/analytics/intelligence";
import { tx } from "./fixtures";

const TODAY = "2026-09-21"; // a Monday

type Over = Partial<TxnLite>;
const D = (date: string, amount: number, category: string, merchant: string, over: Over = {}): TxnLite => ({ ...tx(date, amount, "debit", category, merchant), ...over });
const C = (date: string, amount: number, category: string, merchant: string, over: Over = {}): TxnLite => ({ ...tx(date, amount, "credit", category, merchant), ...over });

/** One food order a day for `days` days before `asOf`, amounts 250..430 (median ~340), alternating merchants. */
function foodHistory(asOf: string, days: number): TxnLite[] {
  return Array.from({ length: days }, (_, i) => D(addDays(asOf, -(i + 1)), 250 + ((i * 53) % 7) * 30, "FOOD", i % 2 ? "Swiggy" : "Zomato"));
}

describe("comparable periods", () => {
  it("month to date is compared with the same number of days last month (like-for-like)", () => {
    const p = comparablePeriods(TODAY, "month");
    expect(p.current).toMatchObject({ from: "2026-09-01", to: "2026-09-21", label: "This month" });
    expect(p.previous).toMatchObject({ from: "2026-08-01", to: "2026-08-21", label: "Last month" });
    expect(p).toMatchObject({ partial: true, elapsedDays: 21, totalDays: 30 });
  });
  it("a finished month compares the full previous month", () => {
    const p = comparablePeriods("2026-09-30", "month");
    expect(p.partial).toBe(false);
    expect(p.previous).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
  });
  it("day, week, quarter and year", () => {
    expect(comparablePeriods(TODAY, "day")).toMatchObject({ current: { from: TODAY, to: TODAY }, previous: { from: "2026-09-20", to: "2026-09-20" } });
    const w = comparablePeriods("2026-09-23", "week"); // Wednesday
    expect(w.current).toMatchObject({ from: "2026-09-21", to: "2026-09-23" });
    expect(w.previous).toMatchObject({ from: "2026-09-14", to: "2026-09-16" });
    const q = comparablePeriods(TODAY, "quarter");
    expect(q.current).toMatchObject({ from: "2026-07-01", to: TODAY });
    expect(q.previous).toMatchObject({ from: "2026-04-01", to: "2026-06-22" }); // 83 elapsed days
    const y = comparablePeriods(TODAY, "year");
    expect(y.current).toMatchObject({ from: "2026-01-01", to: TODAY });
    expect(y.previous).toMatchObject({ from: "2025-01-01", to: "2025-09-21" });
  });
  it("honours a custom financial-month start day", () => {
    const p = comparablePeriods(TODAY, "month", 25);
    expect(p.current).toMatchObject({ from: "2026-08-25", to: TODAY });
    expect(p.previous.from).toBe("2026-07-25");
  });
  it("turns natural-language ranges into comparable periods", () => {
    const lastMonth = periodsFromRange({ from: "2026-08-01", to: "2026-08-31", label: "last month" }, TODAY);
    expect(lastMonth).toMatchObject({ unit: "month", partial: false, previous: { from: "2026-07-01", to: "2026-07-31" } });
    expect(lastMonth.current.label).toBe("last month");
    const custom = periodsFromRange({ from: "2026-08-23", to: TODAY, label: "in the last 30 days" }, TODAY);
    expect(custom.previous).toMatchObject({ from: "2026-07-24", to: "2026-08-22" }); // the 30 days before
    const future = periodsFromRange({ from: "2026-09-01", to: "2026-09-30", label: "this month" }, TODAY);
    expect(future.current.to).toBe(TODAY); // never includes days that have not happened
    expect(future.partial).toBe(true);
  });
});

describe("spending totals: refunds, credits and transfers", () => {
  const blinkit = D("2026-09-05", 266, "GROCERIES", "Blinkit");
  const refund = C("2026-09-06", 266, "REFUNDS", "Blinkit", { refundFor: blinkit.id, isRefund: true });
  const rows = [
    D("2026-09-02", 1000, "FOOD", "Zomato"),
    blinkit,
    refund,
    D("2026-09-03", 10000, "TRANSFERS", "Rahul Negi"),
    D("2026-09-04", 5000, "INVESTMENTS", "Groww"),
    C("2026-09-01", 50000, "SALARY/INCOME", "Acme"),
    C("2026-09-07", 700, "TRANSFERS", "Friend"),
  ];

  it("a purchase and its refund net to zero and drop out of category and merchant figures", () => {
    const t = spendTotals(rows);
    expect(t).toMatchObject({ gross: 1266, refunded: 266, net: 1000 });
    expect(categoryStats(rows).map((c) => c.key)).toEqual(["FOOD"]); // GROCERIES fully refunded
    expect(merchantStats(rows).map((m) => m.key)).toEqual(["Zomato"]);
  });
  it("credits are never spending; transfers and investments are not consumption", () => {
    const t = spendTotals(rows);
    expect(t.income).toBe(50000);
    expect(t.credits).toBe(50000 + 266 + 700);
    expect(t.net).toBe(1000); // salary, refund and transfer-in did not reduce or add to spending
    expect(t.transfersOut).toBe(10000);
    expect(t.investmentsOut).toBe(5000);
    expect(t.netCashFlow).toBe(50966 - 16266);
    expect(categoryStats(rows).some((c) => c.key === "TRANSFERS" || c.key === "INVESTMENTS")).toBe(false);
  });
  it("a partial refund reduces spending by the refunded part only", () => {
    const p = D("2026-09-05", 1000, "SHOPPING", "Amazon");
    const r = C("2026-09-09", 400, "REFUNDS", "Amazon", { refundFor: p.id });
    expect(spendTotals([p, r]).net).toBe(600);
    expect(categoryStats([p, r])[0]).toMatchObject({ key: "SHOPPING", amount: 600, count: 1 });
  });
  it("a refund that arrives in a later period is netted against the purchase's period", () => {
    const p = D("2026-08-30", 1000, "SHOPPING", "Amazon");
    const r = C("2026-09-02", 1000, "REFUNDS", "Amazon", { refundFor: p.id });
    const all = [p, r];
    expect(spendTotals([p], all).net).toBe(0); // August: fully refunded
    expect(spendTotals([r], all).net).toBe(0); // September: the refund is not subtracted a second time
  });
  it("a refund with no linked purchase is subtracted in the period it arrived", () => {
    const orphan = C("2026-09-09", 300, "REFUNDS", "Cashback");
    const t = spendTotals([D("2026-09-02", 2000, "FOOD", "Zomato"), orphan]);
    expect(t).toMatchObject({ gross: 2000, unlinkedRefunds: 300, net: 1700 });
  });
});

describe("category, merchant and payment analysis", () => {
  const rows = [
    D("2026-09-02", 400, "FOOD", "Swiggy", { paymentMethod: "UPI" }),
    D("2026-09-05", 600, "FOOD", "Swiggy", { paymentMethod: "UPI" }),
    D("2026-09-09", 1000, "FOOD", "Zomato", { paymentMethod: "Debit Card" }),
    D("2026-09-10", 3000, "SHOPPING", "Amazon", { paymentMethod: "UPI" }),
    D("2026-09-12", 649, "SUBSCRIPTIONS", "Netflix", { paymentMethod: "AUTOPAY" }),
  ];
  it("category: total, share, count, average, largest transaction", () => {
    const cats = categoryStats(rows);
    expect(cats[0]).toMatchObject({ key: "SHOPPING", amount: 3000, count: 1, average: 3000 });
    const food = cats.find((c) => c.key === "FOOD")!;
    expect(food).toMatchObject({ amount: 2000, count: 3, average: 666.67 });
    expect(food.largest).toMatchObject({ amount: 1000, merchant: "Zomato", date: "2026-09-09" });
    const a = analyzeRanges(rows, comparablePeriods("2026-09-30", "month"));
    expect(a.categories.map((c) => c.pctOfSpending)).toEqual([53.1, 35.4, 11.5]); // 3000, 2000, 649 of 5649
  });
  it("merchant: total, count, average, first and last transaction", () => {
    const sw = merchantStats(rows).find((m) => m.key === "Swiggy")!;
    expect(sw).toMatchObject({ amount: 1000, count: 2, average: 500, first: "2026-09-02", last: "2026-09-05", category: "FOOD" });
  });
  it("payment behaviour: UPI, AUTOPAY and other methods", () => {
    const pm = paymentMethodStats(rows);
    expect(pm.map((p) => [p.method, p.amount, p.count])).toEqual([["UPI", 4000, 3], ["Debit Card", 1000, 1], ["AUTOPAY", 649, 1]]);
    expect(pm.reduce((a, p) => a + p.share, 0)).toBeGreaterThan(99.5);
  });
  it("merchant history over the last months is exposed (change over time)", () => {
    const hist = [D("2026-07-10", 500, "FOOD", "Swiggy"), D("2026-08-10", 700, "FOOD", "Swiggy"), D("2026-09-10", 900, "FOOD", "Swiggy")];
    const sw = analyzeSpending(hist, { asOf: TODAY, unit: "month" }).merchants[0];
    expect(sw.monthly.map((m) => m.amount)).toEqual([500, 700, 900]);
  });
  it("series are refund-netted per bucket and agree with the category totals", () => {
    const p = D("2026-09-05", 500, "FOOD", "Zomato");
    const r = C("2026-09-06", 500, "REFUNDS", "Zomato", { refundFor: p.id });
    const s = spendingSeries([p, r, D("2026-08-01", 800, "FOOD", "Swiggy")], "monthly");
    expect(s.map((x) => [x.key, x.spending])).toEqual([["2026-08", 800], ["2026-09", 0]]);
  });
});

describe("period comparison and percentage change", () => {
  const rows = [
    // August up to the 21st: 10,000
    D("2026-08-03", 6000, "FOOD", "Zomato"),
    D("2026-08-10", 4000, "SHOPPING", "Amazon"),
    D("2026-08-28", 9999, "FOOD", "Zomato"), // after the 21st: must not be compared with the partial September
    // September up to the 21st: 12,500
    D("2026-09-03", 8000, "FOOD", "Zomato"),
    D("2026-09-10", 4500, "SHOPPING", "Amazon"),
  ];
  it("percentage change uses the previous equivalent period, like-for-like", () => {
    const a = analyzeSpending(rows, { asOf: TODAY, unit: "month" });
    expect(a.totals.current.net).toBe(12500);
    expect(a.totals.previous.net).toBe(10000);
    expect(a.totals.change).toEqual({ amount: 2500, pct: 25 });
    expect(a.caveats.join(" ")).toMatch(/still in progress/);
  });
  it("no previous data means no percentage (not a fake 100% or infinity)", () => {
    const a = analyzeSpending([D("2026-09-03", 800, "FOOD", "Zomato")], { asOf: TODAY, unit: "month" });
    expect(a.totals.change.pct).toBeNull();
    expect(a.caveats.join(" ")).toMatch(/previous period/);
  });
  it("category rows carry the previous amount and change", () => {
    const food = analyzeSpending(rows, { asOf: TODAY, unit: "month" }).categories.find((c) => c.key === "FOOD")!;
    expect(food).toMatchObject({ amount: 8000, previousAmount: 6000, previousCount: 1 });
    expect(food.change).toMatchObject({ delta: 2000, pctChange: 33.3 });
  });
});

describe("change detection with thresholds", () => {
  const g = (key: string, amount: number, count: number): GroupStat => ({ key, category: "FOOD", amount, count, average: amount / Math.max(count, 1), largest: null, first: "2026-09-01", last: "2026-09-20" });
  const find = (list: ReturnType<typeof compareGroups>, key: string) => list.find((c) => c.key === key)!;

  it("ignores tiny changes: a large percentage of a small amount, or a large amount that is a small percentage", () => {
    const out = compareGroups([g("tiny", 300, 5), g("big", 10400, 8)], [g("tiny", 100, 5), g("big", 10000, 8)]);
    expect(find(out, "tiny")).toMatchObject({ pctChange: 200, significant: false }); // +200% but only ₹200
    expect(find(out, "big")).toMatchObject({ pctChange: 4, significant: false }); // ₹400 and 4%
  });
  it("flags a change that clears percentage, rupee and sample-size thresholds", () => {
    const c = find(compareGroups([g("food", 6000, 6)], [g("food", 4000, 5)]), "food");
    expect(c).toMatchObject({ kind: "increase", delta: 2000, pctChange: 50, significant: true, lowSample: false });
  });
  it("does not draw conclusions from a handful of transactions", () => {
    const c = find(compareGroups([g("travel", 20000, 1)], [g("travel", 2000, 1)]), "travel");
    expect(c).toMatchObject({ pctChange: 900, lowSample: true, significant: false });
  });
  it("detects new and stopped groups", () => {
    const out = compareGroups([g("newco", 3000, 4)], [g("oldco", 2500, 3)]);
    expect(find(out, "newco")).toMatchObject({ kind: "new", pctChange: null, significant: true });
    expect(find(out, "oldco")).toMatchObject({ kind: "stopped", delta: -2500, significant: true });
  });
  it("thresholds are configurable", () => {
    const cur = [g("food", 6000, 6)];
    const prev = [g("food", 4000, 5)];
    expect(compareGroups(cur, prev, { minPct: 60, minAmount: 500, minTxns: 3 })[0].significant).toBe(false);
    expect(compareGroups(cur, prev, { minPct: 10, minAmount: 5000, minTxns: 3 })[0].significant).toBe(false);
    expect(compareGroups(cur, prev, { minPct: 10, minAmount: 500, minTxns: 9 })[0].significant).toBe(false);
    expect(compareGroups(cur, prev, DEFAULT_THRESHOLDS)[0].significant).toBe(true);
  });
});

describe("unusual activity detection", () => {
  const asOf = TODAY;
  const base = () => foodHistory(asOf, 120);

  it("flags an unusually large transaction with type, severity, reference, observed value, baseline, reason, confidence and timestamp", () => {
    const big = D("2026-09-20", 4500, "FOOD", "Zomato");
    const found = detectUnusualActivity([...base(), big], { asOf });
    const a = found.find((x) => x.type === "large_transaction")!;
    expect(a).toBeDefined();
    expect(a).toMatchObject({ txnId: big.id, merchant: "Zomato", category: "FOOD", observed: 4500, date: "2026-09-20", detectedAt: asOf, unit: "amount" });
    expect(["low", "medium", "high"]).toContain(a.severity);
    expect(a.severity).toBe("high");
    expect(a.baseline).toBeGreaterThan(250);
    expect(a.baseline).toBeLessThan(450);
    expect(a.ratio).toBeGreaterThan(10);
    expect(a.reason).toMatch(/4,500.*Zomato/);
    expect(a.baselineLabel).toMatch(/typical/);
    expect(a.confidence).toBeGreaterThan(0.5);
    expect(a.confidence).toBeLessThan(1);
    expect(a.sampleSize).toBeGreaterThanOrEqual(100);
    expect(found.filter((x) => x.txnId !== big.id && x.type === "large_transaction")).toEqual([]); // ordinary orders are not flagged
  });

  it("never flags very small transactions, however unusual relative to a tiny history", () => {
    const tiny = Array.from({ length: 40 }, (_, i) => D(addDays(asOf, -(i + 2)), 5 + (i % 3), "FOOD", "Tea Stall"));
    expect(detectUnusualActivity([...tiny, D("2026-09-20", 60, "FOOD", "Tea Stall")], { asOf })).toEqual([]);
  });

  it("stays silent with missing history (first days of data)", () => {
    expect(detectUnusualActivity([], { asOf })).toEqual([]);
    expect(detectUnusualActivity([D("2026-09-20", 9000, "FOOD", "Zomato"), D("2026-09-19", 200, "FOOD", "Swiggy")], { asOf })).toEqual([]);
    // 12 orders is not enough to call a 3,000 order "unusual": no per-category baseline, thin global baseline
    const few = Array.from({ length: 9 }, (_, i) => D(addDays(asOf, -(i + 1)), 300 + i, "FOOD", "Swiggy"));
    expect(detectUnusualActivity([...few, D("2026-09-20", 3000, "SHOPPING", "Amazon")], { asOf }).filter((a) => a.type === "large_transaction")).toEqual([]);
  });

  it("expected large payments (rent, recurring bills) are not unusual", () => {
    const rent = Array.from({ length: 6 }, (_, i) => D(addMonths("2026-09-01", -i), 25000, "RENT", "Landlord", { isRecurring: true }));
    const found = detectUnusualActivity([...base(), ...rent], { asOf });
    expect(found.filter((a) => a.merchant === "Landlord" || a.category === "RENT")).toEqual([]);
    expect(found.filter((a) => a.type === "unusual_day" && a.date === "2026-09-01")).toEqual([]);
  });

  it("measures refunded purchases net of the refund", () => {
    const p = D("2026-09-20", 4500, "FOOD", "Zomato");
    const r = C("2026-09-20", 4500, "REFUNDS", "Zomato", { refundFor: p.id });
    expect(detectUnusualActivity([...base(), p, r], { asOf }).filter((a) => a.txnId === p.id)).toEqual([]);
  });

  it("flags duplicate-looking payments (same merchant, amount and day) but not different amounts", () => {
    const dup = [D("2026-09-18", 1500, "SHOPPING", "Amazon"), D("2026-09-18", 1500, "SHOPPING", "Amazon")];
    const found = detectUnusualActivity([...base(), ...dup, D("2026-09-19", 1500, "SHOPPING", "Amazon"), D("2026-09-19", 1499, "SHOPPING", "Amazon")], { asOf });
    const d = found.filter((a) => a.type === "possible_duplicate");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ merchant: "Amazon", date: "2026-09-18", observed: 2, unit: "count" });
    expect(d[0].txnIds).toEqual(dup.map((t) => t.id));
    expect(d[0].reason).toMatch(/may be separate purchases/);
  });

  it("flags unusually frequent payments to one merchant", () => {
    const weekly = Array.from({ length: 10 }, (_, i) => D(addDays(asOf, -(70 - i * 7)), 80, "FOOD", "Chai Point"));
    const burst = Array.from({ length: 6 }, (_, i) => D(addDays(asOf, -i), 80, "FOOD", "Chai Point"));
    const f = detectUnusualActivity([...base(), ...weekly, ...burst], { asOf }).find((a) => a.type === "frequent_transactions")!;
    expect(f).toMatchObject({ merchant: "Chai Point", unit: "count", observed: 6 });
    expect(f.baseline).toBeLessThan(2);
    expect(f.reason).toMatch(/6 payments/);
  });

  it("flags a category / merchant spending far above its own 30-day history, but only with enough history", () => {
    const monthlyEnt = (k: number) => [D(addDays(asOf, -(30 * k + 5)), 1000, "ENTERTAINMENT", "BookMyShow"), D(addDays(asOf, -(30 * k + 20)), 1000, "ENTERTAINMENT", "BookMyShow")];
    const hist = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(monthlyEnt);
    const spike = [...hist, D(addDays(asOf, -8), 3000, "ENTERTAINMENT", "BookMyShow")];
    const found = detectUnusualActivity([...base(), ...spike], { asOf });
    const cat = found.find((a) => a.type === "category_spike" && a.category === "ENTERTAINMENT")!;
    expect(cat).toMatchObject({ observed: 5000, baseline: 2000, ratio: 2.5, unit: "amount", date: asOf });
    expect(found.some((a) => a.type === "merchant_spike" && a.merchant === "BookMyShow")).toBe(true);
    // the same spike with only two earlier 30-day windows of data is NOT reported
    const short = [0, 1, 2].flatMap(monthlyEnt).concat(D(addDays(asOf, -8), 3000, "ENTERTAINMENT", "BookMyShow"));
    expect(detectUnusualActivity([...foodHistory(asOf, 80), ...short.filter((t) => t.date >= addDays(asOf, -80))], { asOf }).filter((a) => a.type === "category_spike")).toEqual([]);
  });

  it("flags an unusual spending day made of several ordinary-looking purchases", () => {
    const day = "2026-09-15";
    const cluster = [D(day, 1500, "SHOPPING", "Amazon"), D(day, 1500, "ENTERTAINMENT", "BookMyShow"), D(day, 1500, "TRAVEL", "Uber"), D(day, 1500, "PERSONAL", "Nykaa")];
    const f = detectUnusualActivity([...base(), ...cluster], { asOf }).find((a) => a.type === "unusual_day")!;
    expect(f).toMatchObject({ date: day, unit: "amount" });
    expect(f.observed).toBeGreaterThanOrEqual(6000);
    expect(f.txnIds.length).toBeGreaterThanOrEqual(4);
  });

  it("robust z-score is not fooled by the outlier itself and tolerates a perfectly regular history", () => {
    expect(robustZ(300, [290, 300, 310, 300, 295, 305]).z).toBeLessThan(1);
    expect(robustZ(9000, [290, 300, 310, 300, 295, 305]).z).toBeGreaterThan(50);
    expect(robustZ(1000, [1000, 1000, 1000, 1000]).z).toBe(0);
    expect(robustZ(1100, [1000, 1000, 1000, 1000]).z).toBeLessThan(3.5); // +10% of a constant is not an outlier
  });

  it("is deterministic and independent of input order", () => {
    const rows = [...base(), D("2026-09-20", 4500, "FOOD", "Zomato"), D("2026-09-18", 1500, "SHOPPING", "Amazon"), D("2026-09-18", 1500, "SHOPPING", "Amazon")];
    const a = detectUnusualActivity(rows, { asOf });
    const b = detectUnusualActivity([...rows].reverse(), { asOf });
    expect(a.length).toBeGreaterThan(1);
    expect(b).toEqual(a);
    expect(detectUnusualActivity(rows, { asOf })).toEqual(a);
  });

  it("never uses the word fraud; findings are worded as unusual activity", () => {
    const rows = [...base(), D("2026-09-20", 4500, "FOOD", "Zomato"), D("2026-09-18", 1500, "SHOPPING", "Amazon"), D("2026-09-18", 1500, "SHOPPING", "Amazon")];
    for (const a of detectUnusualActivity(rows, { asOf })) expect(JSON.stringify(a)).not.toMatch(/fraud|scam|stolen|hack/i);
  });

  it("respects the lookback window and the configurable minimum amount", () => {
    const old = D("2026-05-01", 4500, "FOOD", "Zomato");
    const rows = [...foodHistory(asOf, 200), old];
    expect(detectUnusualActivity(rows, { asOf, lookbackDays: 30 }).filter((a) => a.txnId === old.id)).toEqual([]);
    expect(detectUnusualActivity(rows, { asOf, lookbackDays: 200 }).some((a) => a.txnId === old.id)).toBe(true);
    const mid = D("2026-09-20", 1500, "FOOD", "Zomato");
    expect(detectUnusualActivity([...base(), mid], { asOf, minAmount: 1000 }).some((a) => a.txnId === mid.id)).toBe(true);
    expect(detectUnusualActivity([...base(), mid], { asOf, minAmount: 5000 }).some((a) => a.txnId === mid.id)).toBe(false);
  });
});

describe("recurring payment types", () => {
  const monthly = (last: string, n: number, amount: (i: number) => number, cat: string, merchant: string, over: Over = {}): TxnLite[] =>
    Array.from({ length: n }, (_, i) => D(addMonths(last, -(n - 1 - i)), amount(i), cat, merchant, over));
  const asOf = TODAY;

  it("AUTOPAY is taken from the bank narration (payment method), not guessed from the amount", () => {
    const [s] = detectRecurringExpenses(monthly("2026-09-07", 6, () => 649, "SUBSCRIPTIONS", "Netflix", { paymentMethod: "AUTOPAY" }), { asOf });
    expect(s).toMatchObject({ merchant: "Netflix", type: "AUTOPAY", amountPattern: "fixed", frequency: "monthly", expectedAmount: 649, lastDate: "2026-09-07", nextExpected: "2026-10-07", occurrences: 6 });
  });
  it("identical amounts without an AutoPay mandate are FIXED", () => {
    const [s] = detectRecurringExpenses(monthly("2026-09-05", 5, () => 1500, "PERSONAL", "Cult Gym", { paymentMethod: "UPI" }), { asOf });
    expect(s).toMatchObject({ type: "FIXED", amountVariability: 0, expectedAmount: 1500 });
  });
  it("changing amounts are VARIABLE with a measurable variability", () => {
    const [s] = detectRecurringExpenses(monthly("2026-09-10", 6, (i) => 1800 + i * 240, "UTILITIES", "BESCOM"), { asOf });
    expect(s.type).toBe("VARIABLE");
    expect(s.amountVariability).toBeGreaterThan(0.05);
    expect(s.expectedAmount).toBe(s.averageAmount); // average of the history
    expect(s.confidence).toBeGreaterThan(0.5);
  });
  it("a single transaction is never recurring, even an AutoPay one", () => {
    expect(detectRecurringExpenses([D("2026-09-07", 649, "SUBSCRIPTIONS", "Netflix", { paymentMethod: "AUTOPAY" })], { asOf })).toEqual([]);
    expect(detectRecurringExpenses([D("2026-08-07", 649, "SUBSCRIPTIONS", "Netflix"), D("2026-09-19", 800, "SUBSCRIPTIONS", "Netflix")], { asOf })).toEqual([]);
  });
  it("a price change: a settled new price becomes the expected amount; a fresh change is reported", () => {
    const settled = [...monthly("2026-07-07", 4, () => 199, "SUBSCRIPTIONS", "Spotify"), ...monthly("2026-09-07", 2, () => 249, "SUBSCRIPTIONS", "Spotify")];
    expect(detectRecurringExpenses(settled, { asOf })[0].expectedAmount).toBe(249);
    const fresh = [...monthly("2026-08-07", 5, () => 199, "SUBSCRIPTIONS", "Spotify"), D("2026-09-07", 249, "SUBSCRIPTIONS", "Spotify")];
    const s = detectRecurringExpenses(fresh, { asOf })[0];
    expect(s.amountChangedFrom).toBe(199);
  });
  it("habitual variable spending (daily food orders) is not recurring", () => {
    expect(detectRecurringExpenses(foodHistory(asOf, 60), { asOf }).map((s) => s.merchant)).toEqual([]);
  });
});

describe("cash-flow projection", () => {
  const rent = Array.from({ length: 6 }, (_, i) => D(addMonths("2026-09-01", -i), 25000, "RENT", "Landlord"));
  const netflix = Array.from({ length: 6 }, (_, i) => D(addMonths("2026-09-07", -i), 649, "SUBSCRIPTIONS", "Netflix", { paymentMethod: "AUTOPAY" }));
  const salary = Array.from({ length: 6 }, (_, i) => C(addMonths("2026-09-01", -i), 95000, "SALARY/INCOME", "Acme"));
  const history = [...rent, ...netflix, ...salary];
  const series = detectRecurringExpenses(history, { asOf: TODAY, includeIncome: true });
  const withBalance = (bal: number, on: string): TxnLite[] => [...history, { ...C(on, 0, "OTHER", "x"), credit: 0, amount: 0, balanceAfter: bal }];
  const insurance: ManualObligation = { id: "m1", name: "Insurance", amount: 3000, frequency: "monthly", dueDay: 25, startDate: null, category: "BILLS", kind: "expense", merchantKey: null };
  const input = { txns: history, today: TODAY, balance: 100000 as number | null, balanceAsOf: TODAY as string | null, series, manual: [insurance] };

  it("projected balance = balance + expected credits - expected recurring, per horizon", () => {
    const p = projectCashFlow(input);
    const h = Object.fromEntries(p.horizons.map((x) => [x.days, x]));
    expect(h[7]).toMatchObject({ expectedCredits: 0, expectedRecurring: 3000, knownObligations: 3000, detectedRecurring: 0, committedBalance: 97000 }); // only the 25th falls in 22..28 Sep
    expect(h[14]).toMatchObject({ expectedCredits: 95000, expectedRecurring: 28000, committedBalance: 167000 }); // + 1 Oct salary and rent
    expect(h[30].expectedRecurring).toBe(3000 + 25000 + 649); // Netflix on 7 Oct joins by the 30-day window
    expect(h[30].expectedCredits).toBe(95000);
    expect(h[30].committedBalance).toBe(100000 + 95000 - 28649);
  });
  it("labels projected values and keeps them separate from the actual balance", () => {
    const p = projectCashFlow({ ...input, txns: withBalance(100000, TODAY) });
    expect(p.disclaimer).toMatch(/estimates/i);
    expect(p.disclaimer).toMatch(/not guaranteed/i);
    const actualDays = p.path.filter((x) => x.actual !== undefined);
    expect(actualDays.every((x) => x.date <= TODAY)).toBe(true);
    const future = p.path.filter((x) => x.date > TODAY);
    expect(future.length).toBeGreaterThan(20);
    expect(future.every((x) => x.actual === undefined && x.committed !== undefined && x.likely !== undefined)).toBe(true);
    expect(p.balance).toBe(100000);
  });
  it("without a balance no projected balance is invented", () => {
    const p = projectCashFlow({ ...input, balance: null, balanceAsOf: null });
    expect(p.horizons.every((h) => h.committedBalance === null && h.likelyBalance === null)).toBe(true);
    expect(p.path.filter((x) => x.committed !== undefined)).toEqual([]);
    expect(p.assumptions.join(" ")).toMatch(/balance is unknown/i);
  });
  it("a stale balance starts the window the day after the statement, so payments in the gap are counted", () => {
    const gap: ManualObligation = { ...insurance, id: "m2", name: "Gap bill", amount: 2000, dueDay: 15 };
    const p = projectCashFlow({ ...input, balanceAsOf: "2026-09-10", manual: [gap] });
    expect(p.staleDays).toBe(11);
    expect(p.horizons[0].expectedRecurring).toBe(2000); // due 15 Sep: before today, after the statement
    expect(p.assumptions[0]).toMatch(/11 days ago/);
  });
  it("everyday spending is shown apart, with a range", () => {
    const everyday = foodHistory(TODAY, 60);
    const p = projectCashFlow({ ...input, txns: [...history, ...everyday], series: detectRecurringExpenses([...history, ...everyday], { asOf: TODAY, includeIncome: true }) });
    const h30 = p.horizons[2];
    expect(h30.everydaySpending.expected).toBeGreaterThan(5000);
    expect(h30.everydaySpending.low).toBeLessThanOrEqual(h30.everydaySpending.expected);
    expect(h30.everydaySpending.high).toBeGreaterThanOrEqual(h30.everydaySpending.expected);
    expect(h30.likelyBalance!).toBeLessThan(h30.committedBalance!);
    expect(h30.likelyLow!).toBeLessThanOrEqual(h30.likelyBalance!);
  });
});

describe("safe to spend", () => {
  const asOf = TODAY;
  const manual: ManualObligation = { id: "m1", name: "Insurance", amount: 8000, frequency: "monthly", dueDay: 25, startDate: null, category: "BILLS", kind: "expense", merchantKey: null };
  const spendThisMonth = [D("2026-09-05", 2000, "FOOD", "Zomato")];
  const budgets = calculateBudgetVariance([{ id: "b1", category: "FOOD", amount: 6000, alertThreshold: 0.8 }], spendThisMonth, asOf);
  const base = { txns: spendThisMonth, today: asOf, balance: 50000 as number | null, balanceAsOf: asOf as string | null, series: [], manual: [manual], budgets, safetyBuffer: 3000 };

  it("balance - upcoming recurring - budget commitments - safety buffer, every component visible", () => {
    const s = computeSafeToSpend(base);
    expect(s.upcomingRecurring).toBe(8000);
    expect(s.budgetCommitments).toBe(4000); // 6,000 budget - 2,000 spent
    expect(s.safetyBuffer).toBe(3000);
    expect(s.raw).toBe(50000 - 8000 - 4000 - 3000);
    expect(s.amount).toBe(35000);
    expect(s.components.map((c) => [c.key, c.amount, c.sign])).toEqual([["balance", 50000, 1], ["recurring", 8000, -1], ["budgets", 4000, -1], ["buffer", 3000, -1]]);
    expect(s.components.every((c) => c.note.length > 0)).toBe(true);
    expect(s.disclaimer).toBe("Safe to spend is an estimate, not a guarantee.");
    expect(SAFE_TO_SPEND_DISCLAIMER).toBe(s.disclaimer);
  });
  it("the safety buffer, recurring assumption and budget assumption are user-configurable", () => {
    expect(computeSafeToSpend({ ...base, safetyBuffer: 10000 }).amount).toBe(28000);
    expect(computeSafeToSpend({ ...base, reserveBudgets: false }).amount).toBe(39000);
    expect(computeSafeToSpend({ ...base, reserveBudgets: false }).budgetLines).toEqual([]);
    const detected = detectRecurringExpenses(Array.from({ length: 6 }, (_, i) => D(addMonths("2026-08-27", -i), 500, "SUBSCRIPTIONS", "Netflix")), { asOf: "2026-09-21" });
    expect(detected.length).toBe(1);
    const withDetected = computeSafeToSpend({ ...base, series: detected, reserveBudgets: false });
    const without = computeSafeToSpend({ ...base, series: detected, reserveBudgets: false, includeDetectedRecurring: false });
    expect(withDetected.upcomingRecurring).toBe(8000 + 500);
    expect(without.upcomingRecurring).toBe(8000); // only what the user entered
  });
  it("bills already listed are not reserved twice through the budget", () => {
    const billBudget = calculateBudgetVariance([{ id: "b2", category: "BILLS", amount: 10000, alertThreshold: 0.8 }], [], asOf);
    const s = computeSafeToSpend({ ...base, budgets: billBudget });
    expect(s.budgetLines[0]).toMatchObject({ remaining: 10000, alreadyCounted: 8000, reserved: 2000 });
    expect(s.budgetCommitments).toBe(2000);
  });
  it("floors at zero and reports the shortfall instead of a negative 'safe' amount", () => {
    const s = computeSafeToSpend({ ...base, balance: 5000 });
    expect(s.raw).toBe(5000 - 8000 - 4000 - 3000);
    expect(s.amount).toBe(0);
    expect(s.shortfall).toBe(10000);
  });
  it("uses an automatic buffer (10% of typical monthly spending) when the user sets none, and says so", () => {
    const hist = foodHistory(asOf, 90);
    const s = computeSafeToSpend({ ...base, txns: hist, safetyBuffer: null, budgets: [] });
    expect(s.bufferSource).toBe("auto");
    expect(s.safetyBuffer).toBeGreaterThan(500);
    expect(s.components.find((c) => c.key === "buffer")!.note).toMatch(/10%/);
    expect(computeSafeToSpend({ ...base, safetyBuffer: 0 }).bufferSource).toBe("user");
  });
  it("without a balance there is no number (and no invented one)", () => {
    const s = computeSafeToSpend({ ...base, balance: null, balanceAsOf: null });
    expect(s.amount).toBeNull();
    expect(s.raw).toBeNull();
    expect(s.components.some((c) => c.key === "balance")).toBe(false);
  });
  it("income that has not arrived yet is shown but never counted", () => {
    const salary = Array.from({ length: 4 }, (_, i) => C(addMonths("2026-08-28", -i), 95000, "SALARY/INCOME", "Acme"));
    const series = detectRecurringExpenses(salary, { asOf, includeIncome: true });
    const s = computeSafeToSpend({ ...base, txns: [...salary, ...spendThisMonth], series });
    expect(s.expectedIncomeNotCounted).toBe(95000);
    expect(s.amount).toBe(35000);
  });
});

describe("snapshot and insights", () => {
  const asOf = TODAY;
  const aug = [
    D("2026-08-03", 3000, "FOOD", "Zomato"), D("2026-08-05", 2500, "FOOD", "Swiggy"), D("2026-08-09", 2000, "FOOD", "Zomato"),
    D("2026-08-11", 1200, "SHOPPING", "Amazon"), D("2026-08-14", 800, "TRANSPORTATION", "Uber"), D("2026-08-16", 900, "TRANSPORTATION", "Uber"),
    C("2026-08-01", 90000, "SALARY/INCOME", "Acme"),
  ];
  const sep = [
    D("2026-09-03", 5000, "FOOD", "Zomato"), D("2026-09-05", 4500, "FOOD", "Zomato"), D("2026-09-09", 4000, "FOOD", "Swiggy"),
    D("2026-09-11", 1300, "SHOPPING", "Amazon"), D("2026-09-14", 850, "TRANSPORTATION", "Uber"), D("2026-09-16", 880, "TRANSPORTATION", "Uber"),
    C("2026-09-01", 90000, "SALARY/INCOME", "Acme"),
  ];
  const july = [D("2026-07-04", 7000, "FOOD", "Zomato"), D("2026-07-06", 600, "SHOPPING", "Amazon"), D("2026-07-09", 500, "TRANSPORTATION", "Uber"), D("2026-07-11", 500, "TRANSPORTATION", "Uber"), C("2026-07-01", 90000, "SALARY/INCOME", "Acme")];
  const txns = [...july, ...aug, ...sep].map((t) => ({ ...t, balanceAfter: undefined }));
  const sp = analyzeSpending(txns, { asOf, unit: "month" });
  const safe = computeSafeToSpend({ txns, today: asOf, balance: 60000, balanceAsOf: asOf, series: [], manual: [], budgets: [], safetyBuffer: 2000 });
  const gen = () => generateIntelInsights({ txns, asOf, monthStartDay: 1, spending: sp, anomalies: [], series: [], upcoming: [], safe, budgets: [] });

  it("explains a spending increase with the categories behind it, refund-netted and thresholded", () => {
    const list = gen();
    const up = list.find((i) => i.kind === "spending_up")!;
    expect(up).toBeDefined();
    expect(up.severity).toBe("watch");
    expect(up.explanation).toContain("16,530"); // Sept to date: 5000+4500+4000+1300+850+880
    expect(up.explanation).toContain("10,400"); // Aug up to the 21st: 3000+2500+2000+1200+800+900
    expect(up.metric).toMatchObject({ value: 16530, previous: 10400, unit: "inr" });
    const spike = list.find((i) => i.kind === "category_spike" && i.categories[0] === "FOOD")!;
    expect(spike.title).toMatch(/Food/);
    expect(spike.txnIds).toHaveLength(1);
    expect(spike.categories).toEqual(["FOOD"]);
    // Zomato is +90% but only 2 payments in each period: too small a sample to call a merchant spike
    expect(list.some((i) => i.kind === "merchant_spike")).toBe(false);
    // shopping moved +100 and transport +30: below every threshold, so no alert for them
    expect(list.some((i) => i.categories.includes("SHOPPING") && i.kind === "category_spike")).toBe(false);
    expect(list.some((i) => i.categories.includes("TRANSPORTATION") && i.kind === "category_spike")).toBe(false);
  });
  it("every insight has a title, explanation, metric, references and the calculation behind it", () => {
    for (const i of gen()) {
      expect(i.id).toBeTruthy();
      expect(i.title.length).toBeGreaterThan(5);
      expect(i.explanation.length).toBeGreaterThan(20);
      expect(i.calculation.length).toBeGreaterThan(10);
      expect(["info", "positive", "watch", "attention"]).toContain(i.severity);
      expect(typeof i.metric.value).toBe("number");
      expect(Array.isArray(i.txnIds) && Array.isArray(i.categories)).toBe(true);
    }
  });
  it("is reproducible: identical inputs give identical insights, ordered newest first", () => {
    expect(gen()).toEqual(gen());
    const dates = gen().map((i) => i.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
  it("reports a spending decrease as positive", () => {
    const lower = analyzeSpending([...july, ...aug, D("2026-09-03", 3000, "FOOD", "Zomato")], { asOf, unit: "month" });
    const list = generateIntelInsights({ txns: [...july, ...aug], asOf, monthStartDay: 1, spending: lower, anomalies: [], series: [], upcoming: [], safe, budgets: [] });
    expect(list.find((i) => i.kind === "spending_down")?.severity).toBe("positive");
  });
  it("is quiet when nothing meaningful changed, and never claims a trend from a missing previous period", () => {
    const flat = [D("2026-08-03", 1000, "FOOD", "Zomato"), D("2026-08-06", 1000, "FOOD", "Zomato"), D("2026-08-09", 1000, "FOOD", "Zomato"), D("2026-09-03", 1050, "FOOD", "Zomato"), D("2026-09-06", 1000, "FOOD", "Zomato"), D("2026-09-09", 1000, "FOOD", "Zomato")];
    const l = generateIntelInsights({ txns: flat, asOf, monthStartDay: 1, spending: analyzeSpending(flat, { asOf, unit: "month" }), anomalies: [], series: [], upcoming: [], safe, budgets: [] });
    expect(l.filter((i) => ["spending_up", "spending_down", "category_spike", "category_drop", "merchant_spike"].includes(i.kind))).toEqual([]);
    const first = [D("2026-09-03", 9000, "FOOD", "Zomato"), D("2026-09-06", 9000, "FOOD", "Zomato"), D("2026-09-09", 9000, "FOOD", "Zomato")];
    const l2 = generateIntelInsights({ txns: first, asOf, monthStartDay: 1, spending: analyzeSpending(first, { asOf, unit: "month" }), anomalies: [], series: [], upcoming: [], safe, budgets: [] });
    expect(l2.some((i) => i.kind === "spending_up")).toBe(false); // first month of history: no "up X%" claim
  });
  it("positive cash-flow trend across complete months", () => {
    const l = gen();
    const p = l.find((i) => i.kind === "positive_cashflow");
    expect(p?.severity).toBe("positive");
    expect(p?.title).toMatch(/last 2 months/);
  });
  it("flags stale data", () => {
    const l = generateIntelInsights({ txns, asOf: "2026-11-15", monthStartDay: 1, spending: analyzeSpending(txns, { asOf: "2026-11-15", unit: "month" }), anomalies: [], series: [], upcoming: [], safe, budgets: [] });
    expect(l.find((i) => i.kind === "stale_data")?.severity).toBe("attention");
  });
  it("insights for recurring detected and upcoming recurring are derived from the series", () => {
    const nf = Array.from({ length: 5 }, (_, i) => D(addMonths("2026-09-24", -i), 649, "SUBSCRIPTIONS", "Netflix", { paymentMethod: "AUTOPAY" }));
    const series = detectRecurringExpenses(nf, { asOf, includeIncome: true });
    const upcoming = [{ id: "u", name: "Netflix", amount: 649, date: "2026-09-24", kind: "expense" as const, source: "detected" as const, category: "SUBSCRIPTIONS", frequency: "monthly" as const, confidence: "High" as const, basis: "" }];
    const l = generateIntelInsights({ txns: nf, asOf, monthStartDay: 1, spending: analyzeSpending(nf, { asOf, unit: "month" }), anomalies: [], series, upcoming, safe, budgets: [] });
    expect(l.find((i) => i.kind === "recurring_detected")?.merchants).toEqual(["Netflix"]);
    expect(l.find((i) => i.kind === "upcoming_recurring")?.metric.value).toBe(649);
  });
  it("comfortable room after commitments is reported with the estimate disclaimer; a shortfall is flagged", () => {
    const comfy = generateIntelInsights({ txns, asOf, monthStartDay: 1, spending: sp, anomalies: [], series: [], upcoming: [], safe, budgets: [] }).find((i) => i.kind === "high_discretionary")!;
    expect(comfy.explanation).toContain("estimate, not a guarantee");
    const poor = computeSafeToSpend({ txns, today: asOf, balance: 1000, balanceAsOf: asOf, series: [], manual: [{ id: "m", name: "Rent", amount: 9000, frequency: "monthly", dueDay: 25, startDate: null, category: "RENT", kind: "expense", merchantKey: null }], budgets: [], safetyBuffer: 0 });
    const l = generateIntelInsights({ txns, asOf, monthStartDay: 1, spending: sp, anomalies: [], series: [], upcoming: [], safe: poor, budgets: [] });
    expect(l.find((i) => i.kind === "high_discretionary")?.severity).toBe("attention");
  });
  it("the snapshot has the required fields and NO health score or grade", () => {
    const snap = buildSnapshot({ spending: sp, balance: { balance: 60000, asOf }, today: asOf, recurringMonthlyTotal: 8000, recurringCount: 2, expectedNext30Days: 8649, safe, anomalies: [] });
    expect(snap).toMatchObject({ periodLabel: "This month", partial: true, balance: { amount: 60000, staleDays: 0 } });
    expect(snap.income).toMatchObject({ value: 90000, previous: 90000, changePct: 0 });
    expect(snap.spending).toMatchObject({ value: 16530, previous: 10400, gross: 16530, refunded: 0 });
    expect(snap.netCashFlow.value).toBe(90000 - 16530);
    expect(snap.largestCategory).toMatchObject({ category: "FOOD", amount: 13500 });
    expect(snap.largestMerchant).toMatchObject({ merchant: "Zomato", amount: 9500, count: 2 });
    expect(snap.recurring).toEqual({ monthlyTotal: 8000, expectedNext30Days: 8649, count: 2 });
    expect(snap.discretionary.disclaimer).toBe("Safe to spend is an estimate, not a guarantee.");
    expect(JSON.stringify(snap)).not.toMatch(/score|grade|excellent|health|\/100/i);
    for (const i of gen()) expect(JSON.stringify(i)).not.toMatch(/health score|excellent|\/100/i);
  });
});

describe("edge cases", () => {
  it("zero transactions", () => {
    const a = analyzeSpending([], { asOf: TODAY, unit: "month" });
    expect(a.totals.current).toMatchObject({ net: 0, income: 0, transactionCount: 0 });
    expect(a.categories).toEqual([]);
    expect(a.merchants).toEqual([]);
    expect(a.changes).toEqual({ categories: [], merchants: [] });
    expect(a.caveats.join(" ")).toMatch(/No transactions/);
    expect(detectUnusualActivity([], { asOf: TODAY })).toEqual([]);
    expect(detectRecurringExpenses([], { asOf: TODAY })).toEqual([]);
    expect(spendingSeries([], "monthly")).toEqual([]);
    const p = projectCashFlow({ txns: [], today: TODAY, balance: null, balanceAsOf: null, series: [], manual: [] });
    expect(p.horizons.map((h) => h.expectedRecurring)).toEqual([0, 0, 0]);
    expect(computeSafeToSpend({ txns: [], today: TODAY, balance: null, balanceAsOf: null, series: [], manual: [] }).amount).toBeNull();
    expect(generateIntelInsights({ txns: [], asOf: TODAY, monthStartDay: 1, spending: a, anomalies: [], series: [], upcoming: [], safe: computeSafeToSpend({ txns: [], today: TODAY, balance: null, balanceAsOf: null, series: [], manual: [] }) })).toEqual([]);
  });
  it("only credits: nothing is spending", () => {
    const rows = [C("2026-09-01", 90000, "SALARY/INCOME", "Acme"), C("2026-09-05", 2000, "TRANSFERS", "Friend"), C("2026-09-07", 300, "REFUNDS", "Cashback")];
    const t = spendTotals(rows);
    expect(t).toMatchObject({ gross: 0, net: 0, income: 90000, credits: 92300, debits: 0, netCashFlow: 92300 });
    expect(analyzeSpending(rows, { asOf: TODAY, unit: "month" }).categories).toEqual([]);
    expect(detectUnusualActivity(rows, { asOf: TODAY })).toEqual([]);
  });
  it("only debits: no income, cash flow negative", () => {
    const rows = [D("2026-09-01", 900, "FOOD", "Zomato"), D("2026-09-02", 100, "FOOD", "Zomato")];
    expect(spendTotals(rows)).toMatchObject({ net: 1000, income: 0, credits: 0, netCashFlow: -1000 });
  });
  it("first month of history: the previous period is reported as incomplete, not compared as if it were", () => {
    const a = analyzeSpending([D("2026-09-03", 800, "FOOD", "Zomato"), D("2026-09-08", 900, "FOOD", "Zomato"), D("2026-08-25", 500, "FOOD", "Zomato")], { asOf: TODAY, unit: "month" });
    expect(a.caveats.join(" ")).toMatch(/history starts on 25 Aug 2026/);
  });
  it("overlapping duplicates that were already imported once do not double-count spending", () => {
    // the importer de-duplicates by bank reference; here two DIFFERENT rows with identical details remain and are only reported
    const rows = [D("2026-09-18", 1500, "SHOPPING", "Amazon"), D("2026-09-18", 1500, "SHOPPING", "Amazon"), ...foodHistory(TODAY, 40)];
    expect(spendTotals(rows.slice(0, 2)).net).toBe(3000);
    expect(detectUnusualActivity(rows, { asOf: TODAY }).filter((a) => a.type === "possible_duplicate")).toHaveLength(1);
  });
});
