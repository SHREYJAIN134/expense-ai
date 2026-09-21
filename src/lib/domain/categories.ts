/**
 * Category taxonomy. Seeded per user into `transaction_categories` so the user
 * can add/remove categories in Settings. Names are the canonical stored values.
 */
export interface CategoryDef {
  name: string;
  color: string;
  subcategories: string[];
}

export const CATEGORIES: CategoryDef[] = [
  { name: "FOOD", color: "#f59e5b", subcategories: ["Restaurants", "Cafes", "Food Delivery", "Fast Food", "Bakery & Sweets"] },
  { name: "GROCERIES", color: "#7ddc8a", subcategories: ["Supermarket", "Online Grocery", "Quick Commerce", "Household Supplies", "Fresh Produce"] },
  { name: "TRANSPORTATION", color: "#5eb1ff", subcategories: ["Fuel", "Cab", "Metro", "Bus", "Parking", "Toll", "Vehicle Service"] },
  { name: "SHOPPING", color: "#c084fc", subcategories: ["Online Shopping", "Clothing", "Electronics", "Home & Furniture", "General Retail"] },
  { name: "ENTERTAINMENT", color: "#ff7ab6", subcategories: ["Movies", "Games", "Streaming", "Digital Purchases", "Events"] },
  { name: "EDUCATION", color: "#4fd1c5", subcategories: ["Courses", "Books", "Certifications", "College", "Career & Events", "Educational Subscriptions"] },
  { name: "SUBSCRIPTIONS", color: "#a78bfa", subcategories: ["Software", "Cloud & Storage", "Memberships", "News & Media", "Other Subscription"] },
  { name: "UTILITIES", color: "#f6d365", subcategories: ["Electricity", "Internet", "Mobile", "Water", "Gas", "DTH & Cable"] },
  { name: "RENT", color: "#fb7185", subcategories: ["Rent", "Maintenance"] },
  { name: "HEALTHCARE", color: "#34d399", subcategories: ["Pharmacy", "Doctor", "Hospital", "Diagnostics"] },
  { name: "TRAVEL", color: "#38bdf8", subcategories: ["Flights", "Hotels", "Trains & Buses", "Travel Booking"] },
  { name: "BILLS", color: "#fbbf24", subcategories: ["Insurance", "Loan EMI", "Credit Card Bill", "Taxes", "Government", "Other Bill"] },
  { name: "PERSONAL", color: "#f472b6", subcategories: ["Salon & Grooming", "Fitness", "Gifts & Donations", "Pets", "Personal Care"] },
  { name: "TRANSFERS", color: "#94a3b8", subcategories: ["Family", "Person Transfer", "Own Account", "Wallet Top-up"] },
  { name: "ATM/CASH", color: "#d4a373", subcategories: ["Cash Withdrawal", "Cash Deposit"] },
  { name: "BANKING FEES", color: "#ef4444", subcategories: ["Bank Charges", "Interest Charges", "Penalties", "GST on Charges"] },
  { name: "INVESTMENTS", color: "#22d3ee", subcategories: ["Mutual Funds", "Stocks", "Fixed Deposit", "PPF & NPS", "Other Investment"] },
  { name: "SALARY/INCOME", color: "#4ade80", subcategories: ["Salary", "Interest", "Freelance & Business", "Dividend", "Other Income"] },
  { name: "REFUNDS", color: "#86efac", subcategories: ["Refund", "Cashback", "Reversal"] },
  { name: "NEEDS_REVIEW", color: "#f59e0b", subcategories: ["Unresolved"] },
  { name: "OTHER", color: "#64748b", subcategories: ["Unclassified"] },
];

export const CATEGORY_NAMES = CATEGORIES.map((c) => c.name);
export const CATEGORY_COLOR: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.color]));
export const UNCLASSIFIED = { category: "OTHER", subcategory: "Unclassified" } as const;

/** Categories that are money movement, not consumption. Excluded from "spending". */
export const NON_SPENDING_CATEGORIES = new Set(["TRANSFERS", "INVESTMENTS"]);
/** Credit categories that count as earned income. */
export const INCOME_CATEGORY = "SALARY/INCOME";
export const REFUND_CATEGORY = "REFUNDS";

export function isValidCategory(category: string, subcategory?: string, custom?: CategoryDef[]): boolean {
  const list = custom ?? CATEGORIES;
  const c = list.find((x) => x.name === category);
  if (!c) return false;
  return subcategory === undefined || subcategory === "" || c.subcategories.includes(subcategory);
}

/** "SALARY/INCOME" -> "Salary/Income" for display. */
export function categoryLabel(c: string): string {
  return c
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/(^|[\s/])([a-z])/g, (_, p, ch) => p + ch.toUpperCase());
}
