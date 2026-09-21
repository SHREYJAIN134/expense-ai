import type { TxnLite } from "../src/lib/domain/types";

let n = 0;
export function tx(date: string, amount: number, direction: "debit" | "credit", category: string, merchant = "Test", subcategory = "General"): TxnLite {
  n++;
  return {
    id: `t${n}`,
    date,
    debit: direction === "debit" ? amount : 0,
    credit: direction === "credit" ? amount : 0,
    amount,
    direction,
    category,
    subcategory,
    merchant,
  };
}
export const debit = (date: string, amount: number, category = "FOOD", merchant = "Swiggy", sub = "Food Delivery") => tx(date, amount, "debit", category, merchant, sub);
export const credit = (date: string, amount: number, category = "SALARY/INCOME", merchant = "Acme", sub = "Salary") => tx(date, amount, "credit", category, merchant, sub);

/** A small hand-checkable ledger spanning two quarters and two years. */
export function ledger(): TxnLite[] {
  return [
    credit("2025-12-31", 90000),
    debit("2025-12-31", 500, "FOOD", "Zomato"),
    debit("2025-12-31", 250, "FOOD", "Zomato"), // two on same day
    credit("2026-01-01", 100000),
    debit("2026-01-01", 25000, "RENT", "Landlord", "Rent"),
    debit("2026-01-05", 1200, "GROCERIES", "BigBasket", "Online Grocery"),
    debit("2026-01-31", 800, "FOOD", "Swiggy"),
    credit("2026-02-01", 100000),
    debit("2026-02-02", 25000, "RENT", "Landlord", "Rent"),
    credit("2026-02-10", 400, "REFUNDS", "Amazon", "Refund"),
    debit("2026-02-14", 10000, "INVESTMENTS", "Groww", "Mutual Funds"),
    credit("2026-03-01", 100000),
    debit("2026-03-15", 5000, "TRANSFERS", "Friend", "Person Transfer"),
    credit("2026-04-02", 3000, "TRANSFERS", "Papa", "Family"),
    debit("2026-04-03", 999999.5, "SHOPPING", "Big Purchase", "Electronics"),
  ];
}
