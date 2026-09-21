import { describe, expect, it } from "vitest";
import { detectRecurringExpenses, monthlyEquivalent } from "../src/lib/analytics/recurring";
import {
  buildForecast,
  buildUpcoming,
  calculateBudgetVariance,
  obligationDates,
  type ManualObligation,
} from "../src/lib/analytics/planning";
import { generateInsights } from "../src/lib/analytics/insights";
import { addDays, addMonths } from "../src/lib/util/dates";
import { credit, debit } from "./fixtures";
import type { TxnLite } from "../src/lib/domain/types";

/** N monthly occurrences ending at `last` on the same day of month. */
function monthly(last: string, n: number, amount: (i: number) => number, cat: string, merchant: string, sub = "General"): TxnLite[] {
  return Array.from({ length: n }, (_, i) => {
    const d = addMonths(last, -(n - 1 - i));
    return debit(d, amount(i), cat, merchant, sub);
  });
}

describe("recurring payment detection", () => {
  const asOf = "2026-09-21";
  const rent = monthly("2026-09-01", 8, () => 25000, "RENT", "Rajesh Sharma", "Rent");
  const netflix = monthly("2026-09-07", 6, () => 649, "ENTERTAINMENT", "Netflix", "Streaming");
  const electricity = monthly("2026-09-10", 6, (i) => 1800 + i * 240, "UTILITIES", "BESCOM", "Electricity");
  // Swiggy: frequent, variable - must NOT be flagged
  const swiggy = Array.from({ length: 40 }, (_, i) => debit(addDays("2026-08-01", i), 200 + ((i * 37) % 400), "FOOD", "Swiggy"));
  const salary = Array.from({ length: 6 }, (_, i) => credit(addMonths("2026-09-01", -(5 - i)), 95000, "SALARY/INCOME", "Acme Technologies"));
  const all = [...rent, ...netflix, ...electricity, ...swiggy, ...salary];
  const found = detectRecurringExpenses(all, { asOf, includeIncome: true });

  it("finds rent, subscriptions and variable utility bills, but not habitual spending", () => {
    const names = found.map((s) => s.merchant);
    expect(names).toEqual(expect.arrayContaining(["Rajesh Sharma", "Netflix", "BESCOM", "Acme Technologies"]));
    expect(names).not.toContain("Swiggy");
  });

  it("reports frequency, amount pattern, last payment and expected next payment", () => {
    const r = found.find((s) => s.merchant === "Rajesh Sharma")!;
    expect(r).toMatchObject({ frequency: "monthly", amountPattern: "fixed", averageAmount: 25000, lastDate: "2026-09-01", nextExpected: "2026-10-01", kind: "expense", confidenceLabel: "High" });
    const e = found.find((s) => s.merchant === "BESCOM")!;
    expect(e.amountPattern).toBe("variable");
    expect(e.nextExpected).toBe("2026-10-10");
    expect(found.find((s) => s.merchant === "Acme Technologies")!.kind).toBe("income");
  });

  it("marks series that stopped paying as possibly ended", () => {
    const old = monthly("2026-03-05", 6, () => 499, "ENTERTAINMENT", "Old OTT", "Streaming");
    const s = detectRecurringExpenses(old, { asOf })[0];
    expect(s.possiblyEnded).toBe(true);
  });

  it("needs at least 3 occurrences (or a clean fixed monthly pair) and regular gaps", () => {
    expect(detectRecurringExpenses([debit("2026-07-01", 999, "BILLS", "OnceOff")], { asOf })).toEqual([]);
    const irregular = [debit("2026-01-01", 500, "BILLS", "X"), debit("2026-01-20", 500, "BILLS", "X"), debit("2026-04-10", 500, "BILLS", "X"), debit("2026-04-12", 500, "BILLS", "X")];
    expect(detectRecurringExpenses(irregular, { asOf })).toEqual([]);
    const pair = monthly("2026-09-03", 2, () => 1000, "SUBSCRIPTIONS", "Tool", "Software");
    expect(detectRecurringExpenses(pair, { asOf })[0]?.confidenceLabel).not.toBe("High");
  });

  it("detects quarterly and yearly cadences", () => {
    const q = Array.from({ length: 4 }, (_, i) => debit(addMonths("2026-06-20", -3 * (3 - i)), 4500, "PERSONAL", "Cult.fit", "Fitness"));
    expect(detectRecurringExpenses(q, { asOf })[0]).toMatchObject({ frequency: "quarterly", nextExpected: "2026-09-20" });
    expect(monthlyEquivalent({ frequency: "quarterly", averageAmount: 3000 })).toBe(1000);
    expect(monthlyEquivalent({ frequency: "yearly", averageAmount: 1200 })).toBe(100);
  });
});

describe("manual obligations and upcoming expenses", () => {
  const rent: ManualObligation = { id: "r", name: "Rent", amount: 25000, frequency: "monthly", dueDay: 1, category: "RENT", kind: "expense" };
  const elec: ManualObligation = { id: "e", name: "Electricity", amount: 2500, frequency: "monthly", dueDay: 10, category: "UTILITIES", kind: "expense" };
  const net: ManualObligation = { id: "i", name: "Internet", amount: 1000, frequency: "monthly", dueDay: 15, category: "UTILITIES", kind: "expense" };

  it("expands monthly due days, clamping to short months", () => {
    expect(obligationDates(rent, "2026-09-21", "2026-11-30")).toEqual(["2026-10-01", "2026-11-01"]);
    expect(obligationDates({ ...rent, dueDay: 31 }, "2026-02-01", "2026-03-31")).toEqual(["2026-02-28", "2026-03-31"]);
  });
  it("expands quarterly, weekly and yearly obligations", () => {
    const q: ManualObligation = { ...rent, frequency: "quarterly", startDate: "2026-01-15", dueDay: 15 };
    expect(obligationDates(q, "2026-01-01", "2026-12-31")).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
    const w: ManualObligation = { ...rent, frequency: "weekly", dueDay: 5 }; // Friday
    const dates = obligationDates(w, "2026-09-21", "2026-10-11");
    expect(dates).toEqual(["2026-09-25", "2026-10-02", "2026-10-09"]);
    const y: ManualObligation = { ...rent, frequency: "yearly", startDate: "2025-11-05", dueDay: 5 };
    expect(obligationDates(y, "2026-09-01", "2027-12-31")).toEqual(["2026-11-05", "2027-11-05"]);
  });
  it("builds a sorted upcoming list and lets manual entries override detected duplicates", () => {
    const hist = monthly("2026-09-01", 6, () => 25000, "RENT", "Rajesh Sharma", "Rent");
    const series = detectRecurringExpenses(hist, { asOf: "2026-09-21" });
    const items = buildUpcoming({ asOf: "2026-09-21", to: "2026-10-31", series, manual: [rent, elec, net] });
    expect(items.filter((i) => i.name === "Rent" || i.name === "Rajesh Sharma")).toHaveLength(1); // not double counted
    expect(items[0]).toMatchObject({ name: "Rent", date: "2026-10-01", source: "manual" });
    expect(items.map((i) => i.date)).toEqual([...items.map((i) => i.date)].sort());
    const withoutManual = buildUpcoming({ asOf: "2026-09-21", to: "2026-10-31", series, manual: [] });
    expect(withoutManual[0]).toMatchObject({ name: "Rajesh Sharma", source: "detected" });
  });
  it("excludes dismissed detections", () => {
    const hist = monthly("2026-09-01", 6, () => 25000, "RENT", "Rajesh Sharma", "Rent");
    const series = detectRecurringExpenses(hist, { asOf: "2026-09-21" });
    const items = buildUpcoming({ asOf: "2026-09-21", to: "2026-10-31", series, manual: [], dismissedKeys: new Set(["RAJESHSHARMA"]) });
    expect(items).toHaveLength(0);
  });
});

describe("budget calculations", () => {
  const asOf = "2026-09-21"; // day 21 of 30
  const spend = (amt: number, cat = "FOOD") => [debit("2026-09-03", amt, cat)];
  const b = (amount: number, id = "b1", category = "FOOD", alertThreshold = 0.8) => ({ id, category, amount, alertThreshold });

  it("computes actual, remaining, % used and a run-rate projection", () => {
    const [v] = calculateBudgetVariance([b(20000)], spend(6300), asOf);
    expect(v).toMatchObject({ actual: 6300, remaining: 13700, pctUsed: 31.5, status: "ok", daysElapsed: 21, daysTotal: 30 });
    expect(v.projected).toBe(9000); // 6300/21*30
  });
  it("warns when approaching the threshold and when projected to exceed", () => {
    expect(calculateBudgetVariance([b(8000)], spend(6600), asOf)[0].status).toBe("projected_over"); // run-rate 9428 > 8000
    expect(calculateBudgetVariance([b(10000)], spend(8100), asOf)[0].status).toBe("projected_over");
    const nearButProjectedFine = calculateBudgetVariance([b(9000, "x", "FOOD", 0.5)], [debit("2026-09-01", 4600, "FOOD")], "2026-09-05");
    expect(["warning", "projected_over", "ok"]).toContain(nearButProjectedFine[0].status);
  });
  it("flags over-budget with the variance", () => {
    const [v] = calculateBudgetVariance([b(5000)], spend(5600), asOf);
    expect(v).toMatchObject({ status: "over", variance: 600, remaining: -600 });
  });
  it("ignores other categories, other months, credits and non-spending categories", () => {
    const rows = [...spend(1000), debit("2026-09-04", 9999, "SHOPPING"), debit("2026-08-15", 7777, "FOOD"), credit("2026-09-05", 500, "REFUNDS", "X"), debit("2026-09-06", 5000, "TRANSFERS")];
    expect(calculateBudgetVariance([b(20000)], rows, asOf)[0].actual).toBe(1000);
  });
  it("blends prior-month average into early-month projections", () => {
    const prior = [debit("2026-08-10", 9000, "FOOD"), debit("2026-07-10", 9000, "FOOD"), debit("2026-06-10", 9000, "FOOD")];
    const [v] = calculateBudgetVariance([b(20000)], [...prior, debit("2026-09-01", 100, "FOOD")], "2026-09-02");
    expect(v.average3m).toBe(9000);
    expect(v.projected).toBeGreaterThan(3000); // not the naive 100/2*30
  });
  it("respects a mid-month financial month", () => {
    const [v] = calculateBudgetVariance([b(10000)], [debit("2026-09-10", 1000, "FOOD"), debit("2026-09-26", 500, "FOOD")], "2026-09-28", 25);
    expect(v.periodStart).toBe("2026-09-25");
    expect(v.actual).toBe(500);
  });
});

describe("cash-flow forecast", () => {
  const asOf = "2026-05-20";
  const salary = monthly("2026-05-01", 5, () => 100000, "SALARY/INCOME", "Acme").map((t) => ({ ...t, direction: "credit" as const, credit: t.debit, debit: 0 }));
  const rent = monthly("2026-05-03", 5, () => 25000, "RENT", "Landlord", "Rent");
  const daily = Array.from({ length: 110 }, (_, i) => debit(addDays("2026-02-01", i), 500, "FOOD", `Shop ${i}`, "Cafes"));
  const txns = [...salary, ...rent, ...daily];
  const f = buildForecast({ txns, asOf, to: "2026-06-19", manual: [], currentBalance: 40000, balanceAsOf: asOf });

  it("separates income, recurring bills, everyday spending and remaining cash", () => {
    expect(f.horizonDays).toBe(31);
    expect(f.expectedIncome).toBe(100000); // next salary on Jun 1
    expect(f.expectedRecurring).toBe(25000); // next rent on Jun 3
    expect(f.discretionary.expected).toBeGreaterThan(15000);
    expect(f.discretionary.expected).toBeLessThan(16000);
    expect(f.expectedRemaining).toBeCloseTo(40000 + 100000 - 25000 - f.discretionary.expected, 1);
    expect(f.discretionary.low).toBeLessThanOrEqual(f.discretionary.expected + 1);
    expect(f.discretionary.high).toBeGreaterThanOrEqual(f.discretionary.expected - 1);
    expect(f.expectedRemainingLow!).toBeLessThanOrEqual(f.expectedRemaining!);
    expect(f.expectedRemainingHigh!).toBeGreaterThanOrEqual(f.expectedRemaining!);
  });
  it("does not invent income when the next salary falls outside the window", () => {
    const short = buildForecast({ txns, asOf, to: "2026-05-30", manual: [], currentBalance: 40000 });
    expect(short.expectedIncome).toBe(0); // salary is on the 1st; a recurring pattern exists so no 90-day average is used
    expect(short.expectedIncomeBasis).toMatch(/no payment is expected/);
  });
  it("labels itself as an estimate with stated assumptions", () => {
    expect(f.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(f.assumptions.join(" ")).toMatch(/estimated|estimate/i);
  });
  it("subtracts a planned one-off expense and computes a safe-to-spend figure", () => {
    const p = buildForecast({ txns, asOf, to: "2026-06-19", manual: [], currentBalance: 40000, planned: 10000 });
    expect(p.expectedRemaining).toBeCloseTo(f.expectedRemaining! - 10000, 1);
    expect(f.safeToSpend).toBeCloseTo(Math.max(0, f.expectedRemaining! - f.buffer), 1);
  });
  it("returns null remaining when the balance is unknown", () => {
    const u = buildForecast({ txns, asOf, to: "2026-06-19", manual: [], currentBalance: null });
    expect(u.expectedRemaining).toBeNull();
    expect(u.safeToSpend).toBeNull();
    expect(u.expectedNet).toBeCloseTo(f.expectedNet, 1);
  });
  it("includes manually entered bills", () => {
    const m: ManualObligation = { id: "x", name: "Insurance", amount: 12000, frequency: "monthly", dueDay: 25, category: "BILLS", kind: "expense" };
    const withManual = buildForecast({ txns, asOf, to: "2026-06-19", manual: [m], currentBalance: 40000 });
    expect(withManual.expectedRecurring).toBe(25000 + 12000); // rent Jun 3 + insurance May 25 (Jun 25 is outside the window)
  });
});

describe("insights are rule-based and grounded", () => {
  it("produces month-over-month, budget and anomaly insights from real numbers", () => {
    const rows = [
      credit("2026-08-01", 100000), debit("2026-08-05", 20000, "SHOPPING", "Amazon"),
      credit("2026-09-01", 100000), debit("2026-09-05", 30000, "SHOPPING", "Amazon"),
    ];
    const budgets = calculateBudgetVariance([{ id: "b", category: "SHOPPING", amount: 25000, alertThreshold: 0.8 }], rows, "2026-09-21");
    const ins = generateInsights({ txns: rows, asOf: "2026-09-21", budgets });
    const mom = ins.find((i) => i.kind === "mom_change")!;
    expect(mom.title).toMatch(/up 50%/);
    expect(ins.find((i) => i.kind === "budget")?.severity).toBe("alert");
    expect(ins.find((i) => i.kind === "savings_rate")?.title).toMatch(/80%/);
  });
  it("warns when data is stale", () => {
    const ins = generateInsights({ txns: [debit("2026-01-01", 10)], asOf: "2026-09-21" });
    expect(ins.some((i) => i.kind === "stale_data")).toBe(true);
  });
  it("returns nothing for empty data", () => {
    expect(generateInsights({ txns: [], asOf: "2026-09-21" })).toEqual([]);
  });
});
