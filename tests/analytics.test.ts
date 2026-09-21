import { describe, expect, it } from "vitest";
import {
  calculateCashFlow,
  calculateCategorySpend,
  calculateCategoryTrend,
  calculateDailySpend,
  calculateExpenses,
  calculateIncome,
  calculateIncomeSources,
  calculateMerchantSpend,
  calculateMonthlySpend,
  calculateNetCashFlow,
  calculatePatterns,
  calculateQuarterlySpend,
  calculateSavingsRate,
  calculateSummary,
  calculateWeeklySpend,
  calculateYearlySpend,
  detectAnomalies,
} from "../src/lib/analytics/engine";
import { debit, credit, ledger } from "./fixtures";
import { isoWeek, monthKey, quarterKey, financialMonthRange } from "../src/lib/util/dates";

const L = ledger();
const by = <T extends { key: string }>(rows: T[], key: string) => rows.find((r) => r.key === key)!;

describe("summary (income vs spending vs money movement)", () => {
  const s = calculateSummary(L);
  it("separates income, spending, refunds, transfers and investments", () => {
    expect(calculateIncome(L)).toBe(390000);
    expect(s.income).toBe(390000);
    expect(s.refunds).toBe(400);
    expect(s.transfersIn).toBe(3000);
    expect(s.transfersOut).toBe(5000);
    expect(s.investmentsOut).toBe(10000);
    // spending excludes transfers + investments
    expect(calculateExpenses(L)).toBe(750 + 27000 + 25000 + 999999.5);
  });
  it("computes credits/debits, net cash flow and counts", () => {
    expect(s.totalCredits).toBe(90000 + 100000 * 3 + 400 + 3000);
    expect(s.creditCount).toBe(6);
    expect(s.debitCount).toBe(L.length - 6 - 0);
    expect(calculateNetCashFlow(L)).toBe(s.totalCredits - s.totalDebits);
    expect(s.largestDebit?.amount).toBe(999999.5);
    expect(s.largestCredit?.amount).toBe(100000);
    expect(s.avgCredit).toBe(Math.round((s.totalCredits / 6) * 100) / 100);
    expect(s.topCategory?.category).toBe("SHOPPING");
  });
  it("does not treat every credit as income", () => {
    expect(s.totalCredits).toBeGreaterThan(s.income);
    expect(s.otherCredits).toBe(0);
  });
  it("savings rate is null without income and correct with it", () => {
    expect(calculateSavingsRate(0, 100)).toBeNull();
    expect(calculateSavingsRate(1000, 250)).toBe(75);
    expect(calculateSavingsRate(1000, 1500)).toBe(-50);
  });
  it("handles an empty ledger", () => {
    const e = calculateSummary([]);
    expect(e.transactionCount).toBe(0);
    expect(e.savingsRate).toBeNull();
    expect(e.largestDebit).toBeNull();
    expect(e.from).toBeNull();
  });
});

describe("daily aggregation", () => {
  const d = calculateDailySpend(L);
  it("sums multiple transactions on the same day", () => {
    const day = by(d, "2025-12-31");
    expect(day.spending).toBe(750);
    expect(day.income).toBe(90000);
    expect(day.count).toBe(3);
    expect(day.netCashFlow).toBe(89250);
  });
  it("is sorted chronologically and labelled", () => {
    expect(d.map((x) => x.key)).toEqual([...d.map((x) => x.key)].sort());
    expect(by(d, "2026-01-05").label).toBe("5 Jan");
  });
});

describe("weekly aggregation (ISO weeks)", () => {
  const w = calculateWeeklySpend(L);
  it("groups the year-end boundary into ISO week 2026-W01", () => {
    expect(isoWeek("2025-12-31")).toEqual({ year: 2026, week: 1 });
    expect(isoWeek("2026-01-04")).toEqual({ year: 2026, week: 1 });
    expect(isoWeek("2026-01-05")).toEqual({ year: 2026, week: 2 });
    const w1 = by(w, "2026-W01");
    expect(w1.income).toBe(190000);
    expect(w1.spending).toBe(750 + 25000);
  });
  it("labels weeks", () => {
    expect(by(w, "2026-W01").label).toBe("Week 1 · 2026");
  });
});

describe("monthly aggregation", () => {
  const m = calculateMonthlySpend(L);
  it("computes income / spending / net per month", () => {
    const jan = by(m, "2026-01");
    expect(jan).toMatchObject({ income: 100000, spending: 27000, credits: 100000, debits: 27000, netCashFlow: 73000 });
    const feb = by(m, "2026-02");
    expect(feb.spending).toBe(25000); // investment excluded
    expect(feb.refunds).toBe(400);
    expect(feb.savings).toBe(100000 - (25000 - 400));
    expect(feb.netCashFlow).toBe(100400 - 35000);
    const mar = by(m, "2026-03");
    expect(mar.spending).toBe(0);
    expect(mar.transfersOut).toBe(5000);
    expect(by(m, "2026-04").savingsRate).toBeNull();
  });
  it("supports a financial month that starts mid-month", () => {
    expect(monthKey("2026-03-27", 25)).toBe("2026-03");
    expect(monthKey("2026-03-10", 25)).toBe("2026-02");
    expect(monthKey("2026-01-10", 25)).toBe("2025-12");
    const custom = calculateMonthlySpend(L, 25);
    expect(custom.length).toBeGreaterThan(0);
    expect(financialMonthRange("2026-03-27", 25)).toEqual({ from: "2026-03-25", to: "2026-04-24" });
  });
});

describe("quarterly & yearly aggregation", () => {
  it("groups quarters", () => {
    const q = calculateQuarterlySpend(L);
    expect(quarterKey("2026-03-31")).toBe("2026-Q1");
    expect(quarterKey("2026-04-01")).toBe("2026-Q2");
    expect(by(q, "2025-Q4")).toMatchObject({ income: 90000, spending: 750 });
    expect(by(q, "2026-Q1")).toMatchObject({ income: 300000, spending: 52000, refunds: 400 });
    expect(by(q, "2026-Q2").spending).toBe(999999.5);
    expect(by(q, "2026-Q1").label).toBe("Q1 2026");
  });
  it("groups years dynamically from the data (no hard-coded year)", () => {
    const y = calculateYearlySpend(L);
    expect(y.map((r) => r.key)).toEqual(["2025", "2026"]);
    expect(by(y, "2025").income).toBe(90000);
    expect(by(y, "2026").income).toBe(300000);
    expect(by(y, "2026").spending).toBe(52000 + 999999.5);
    expect(calculateYearlySpend([debit("2031-06-01", 10)]).map((r) => r.key)).toEqual(["2031"]);
  });
});

describe("category / merchant / income-source aggregation", () => {
  it("ranks categories, excludes transfers & investments, sums subcategories", () => {
    const c = calculateCategorySpend(L);
    expect(c[0].category).toBe("SHOPPING");
    expect(c.find((x) => x.category === "TRANSFERS")).toBeUndefined();
    expect(c.find((x) => x.category === "INVESTMENTS")).toBeUndefined();
    const food = c.find((x) => x.category === "FOOD")!;
    expect(food.amount).toBe(1550);
    expect(food.count).toBe(3);
    expect(Math.round(c.reduce((a, x) => a + x.pct, 0))).toBeGreaterThanOrEqual(99);
    expect(calculateCategorySpend(L, { includeNonSpending: true }).some((x) => x.category === "INVESTMENTS")).toBe(true);
  });
  it("aggregates merchants", () => {
    const m = calculateMerchantSpend(L);
    expect(m.find((x) => x.merchant === "Zomato")).toMatchObject({ amount: 750, count: 2, average: 375 });
    expect(m.find((x) => x.merchant === "Landlord")?.amount).toBe(50000);
    expect(calculateMerchantSpend(L, { limit: 2 })).toHaveLength(2);
  });
  it("breaks credits down by source", () => {
    const src = calculateIncomeSources(L);
    expect(src[0]).toMatchObject({ source: "Salary", amount: 390000 });
    expect(src.map((s) => s.source)).toEqual(expect.arrayContaining(["Refunds & cashback", "Family transfers"]));
  });
  it("category trend folds small categories into a remainder", () => {
    const t = calculateCategoryTrend(L, "monthly", 2);
    expect(t.keys).toContain("OTHER CATEGORIES");
    expect(t.rows.every((r) => t.keys.every((k) => typeof r[k] === "number"))).toBe(true);
  });
});

describe("cash flow", () => {
  it("accumulates net movement by day", () => {
    const cf = calculateCashFlow(L);
    expect(cf[0]).toMatchObject({ date: "2025-12-31", net: 89250, cumulative: 89250 });
    expect(cf.at(-1)!.cumulative).toBe(calculateNetCashFlow(L));
  });
});

describe("patterns", () => {
  it("weekday totals, calendar heat and distribution buckets", () => {
    const p = calculatePatterns(L);
    expect(p.weekday).toHaveLength(7);
    expect(p.weekday.reduce((a, w) => a + w.amount, 0)).toBeCloseTo(calculateExpenses(L), 2);
    expect(p.calendar.find((c) => c.date === "2025-12-31")).toMatchObject({ amount: 750, count: 2 });
    expect(p.distribution.reduce((a, b) => a + b.count, 0)).toBe(L.filter((t) => t.direction === "debit" && !["TRANSFERS", "INVESTMENTS"].includes(t.category)).length);
    expect(p.distribution.at(-1)!.count).toBe(3); // two ₹25,000 rents + the ₹9.99 lakh purchase
  });
});

describe("anomaly detection", () => {
  it("flags a very large purchase without being fooled by its own size", () => {
    const base = Array.from({ length: 30 }, (_, i) => debit(`2026-03-${String((i % 28) + 1).padStart(2, "0")}`, 300 + (i % 5) * 20, "FOOD", "Swiggy"));
    const withOutlier = [...base, debit("2026-03-15", 9000, "FOOD", "Fancy Restaurant", "Restaurants")];
    const a = detectAnomalies(withOutlier);
    expect(a).toHaveLength(1);
    expect(a[0].txn.amount).toBe(9000);
    expect(a[0].reason).toMatch(/typical/);
  });
  it("does not flag normal variation or tiny data", () => {
    const normal = Array.from({ length: 30 }, (_, i) => debit(`2026-03-${String((i % 28) + 1).padStart(2, "0")}`, 2000 + (i % 7) * 100, "SHOPPING", "Amazon"));
    expect(detectAnomalies(normal)).toEqual([]);
    expect(detectAnomalies([debit("2026-03-01", 50000)])).toEqual([]);
  });
  it("ignores credits and transfers", () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => debit(`2026-03-${i + 1}`, 500)), credit("2026-03-20", 999999), debit("2026-03-21", 999999, "TRANSFERS", "Friend")];
    expect(detectAnomalies(rows)).toEqual([]);
  });
});

describe("edge cases", () => {
  it("copes with duplicated-looking identical rows (both counted)", () => {
    const rows = [debit("2026-01-01", 100), debit("2026-01-01", 100)];
    expect(calculateExpenses(rows)).toBe(200);
  });
  it("avoids float drift when summing paise", () => {
    const rows = Array.from({ length: 10 }, () => debit("2026-01-01", 0.1));
    expect(calculateExpenses(rows)).toBe(1);
  });
  it("very large amounts stay exact to 2 decimals", () => {
    expect(calculateExpenses([debit("2026-01-01", 123456789.12)])).toBe(123456789.12);
  });
});
